import { FileView, Menu, Notice, setIcon, setTooltip, TFile, WorkspaceLeaf } from 'obsidian';
import { chooseDeviceFile, chooseVaultFile, PICTURE_EXTENSIONS, placePicture, preparePicture } from './importing';
import { ANNOTATE_VIEW_TYPE, refreshCoreReaders } from './coreViews';
import { AnnotationMode, getDocument, RenderingCancelledException, type PageViewport, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import { PDFDocument, type PDFPage } from 'pdf-lib';
import { AnnotationController, buildToolbar, HistoryStack, paletteFor, ToolState, type Annotation, type Point, type ToolType } from './annotate';
import { HIGHLIGHTER_OPACITY } from './annotate/types';
import { attachViewNavigation, type ViewZoom } from './annotate/pointer';
import { createId } from './annotate/id';
import { AnnotationWriterClient, type OpenResult } from './pdf/annotationWriterClient';
import { sameInFile } from './pdf/annotationSync';
import { mergeAnnotations } from './markdown/mergeInkBlocks';
import { toArrayBuffer } from './binary';
import { appendBinarySafely, canAppendBinary, writeBinarySafely } from './vaultWrite';
import { compareProfiles, formatMediaBox, normalizeRotation, samplePageIndices, type StructureProfile } from './pdf/compatibility';
import { findMatches, flattenOutline, type OutlineEntry } from './pdf/navigation';
import { BASELINE_DESCENT_RATIO, groupIntoLines, highlightBarHeight, quoteBetween, type PositionedBox, type TextLine } from './pdf/textLines';
import { MAX_CANVAS_PIXELS, RENDER_SCALE, baseRenderScale, capToPixelBudget, layoutRenderScale, zoomedRenderScale } from './pdf/renderScale';
import {
	EDGE_ZONE,
	GROW_STEP_X,
	GROW_STEP_Y,
	INFINITE_BASE_WIDTH,
	boundsOf,
	boxFromView,
	edgesNear,
	growBox,
	isInfiniteCanvasKeywords,
	type Edge,
	type Growth,
	type PdfBox,
} from './pdf/infiniteCanvas';
import { maxWriteIntervalMs } from './pdf/saveCadence';
import { placeWithin } from './pdf/popoverPlacement';
import { defaultSettings, type InklingSettings } from './settings';
import {
	applyTemplateStyle,
	pageSizeFor,
	parseTemplateStyleFromKeywords,
	readTemplateStyle,
	setInfiniteCanvasBox,
	TEMPLATE_STYLE_LABELS,
	TEMPLATE_STYLES,
	type TemplateStyle,
} from './templates';
import { setPageBackground } from './pdf/pageBackground';
import { backUp, type BackupReason } from './backups';

// A page's size as it is seen: its crop box, the part a reader shows, turned
// the way the page is turned — so a page added after it, upright and
// uncropped, comes out the same shape on screen.
function shownPageSize(page: PDFPage): [number, number] {
	const { width, height } = page.getCropBox();
	const turned = Math.abs(page.getRotation().angle) % 180 === 90;
	return turned ? [height, width] : [width, height];
}

// The menu's icons for each background.
const BACKGROUND_ICONS: Record<TemplateStyle, string> = { blank: 'square', lined: 'align-justify', 'dot-grid': 'grip' };

// pdfjs-dist is pinned to an exact version (see package.json) — 5.4.624+
// calls Uint8Array.prototype.toHex() unconditionally when computing a PDF's
// fingerprint, an API too new for Obsidian's bundled Chromium. Check that a
// newer pin still guards it (grep pdf.worker.mjs for "toHex") before bumping.

export const VIEW_TYPE_PDF = ANNOTATE_VIEW_TYPE;

// Obsidian's own built-in PDF view type id — used to switch a leaf back to
// native reading (page number/zoom/outline, and no pdf-lib/editing cost)
// when the user is done annotating. See main.ts for the reverse direction:
// it stays the default for opening a .pdf at all now, and only swaps a leaf
// into VIEW_TYPE_PDF when the user explicitly asks to annotate.
export const CORE_PDF_VIEW_TYPE = 'pdf';

const PAGE_NUMBER_ATTR = 'pageNumber';

// How many pages either side of the visible ones keep their canvases once
// scrolled past; anything beyond is torn back down to its placeholder and
// re-rendered if the user returns. Rendering was lazy already, but nothing
// was ever released — read a 195-page book start to finish and all 195
// pages ended up holding three canvases each (a PDF page plus two
// annotation layers), which on a tablet is exactly the sort of steadily
// climbing memory use that ends in the renderer being killed. Annotations
// aren't affected: they live in the controller's store, keyed by page, and
// are redrawn from it whenever a page mounts again.
const PAGE_RETAIN_MARGIN = 3;

// How long to wait after the last edit before writing annotations into the
// file — pdf-lib's rewrites aren't incremental, so batching rapid
// successive strokes into one save matters more here than for most
// autosave features (see the plan's Write granularity note).
const WRITE_DEBOUNCE_MS = 1500;
// The same, while another device is writing to the file too (see
// pullRemote): ink goes to disk, and so to the other device, as soon as the
// pen lifts, rather than after a pause.
const SHARED_WRITE_DEBOUNCE_MS = 300;
// How long after the file changes on disk the change is read. A sync can
// land a file in more than one write, and the last one is the one to read.
const REMOTE_SETTLE_MS = 250;

// How far a note's editor sits from the point it annotates, and from the
// page's edges when it has to be pulled back inside them.
//
// One number for both, and expressed here rather than as a CSS margin, so
// that the arithmetic which keeps the popover inside its clipping parent
// accounts for the same offset that nudges it clear of the marker. As a
// margin it was invisible to that arithmetic.
const NOTE_POPOVER_MARGIN = 8;

// How long after the last stroke an infinite canvas checks whether its ink
// has come near an edge, and how long a scroll has to have stopped before
// it counts as having arrived at one.
const GROW_AFTER_INK_MS = 1200;
const GROW_AFTER_SCROLL_MS = 400;
// How often a grown page, rendered and ready, checks whether the pen has
// lifted so it can be swapped in.
const GROW_IDLE_POLL_MS = 50;
// Scrolling the view itself — restoring the position after a growth, or
// jumping to a page — is not the reader moving towards an edge. Scroll
// events this soon after a load are not taken as one.
const SCROLL_GROWTH_SETTLE_MS = 800;

// How far the whole view can be zoomed: out far enough to see a spread of
// pages at once, in as far as a page can usefully be rendered (see
// MAX_RENDER_SCALE) — the same kind of range Obsidian's own reader has.
const VIEW_MIN_ZOOM = 0.25;
const VIEW_MAX_ZOOM = 5;

// What a view zoom holds still: a point on one page, as a fraction of its
// size, which is the one description of "this spot" that is still true
// after every page has changed size.
interface ViewAnchorPoint {
	page: HTMLElement | null;
	fx: number;
	fy: number;
}

// The detail layer (see renderDetail): how far past the edges of the view a
// sharp region reaches, as a share of the view's size, so that a short
// scroll stays sharp; and how long scrolling has to pause before the region
// is drawn again where the view has moved to.
const DETAIL_MARGIN = 0.15;
const DETAIL_DELAY_MS = 120;
// How much sharper a page has to need to be than its canvas is before the
// detail layer is worth drawing.
const DETAIL_THRESHOLD = 1.1;

// A page's sharp region, and the three canvases that draw it: the page
// itself, its ink, and the stroke being drawn. Placed by fractions of the
// page, which stay true however the view zooms afterwards.
interface PageDetail {
	left: number;
	top: number;
	right: number;
	bottom: number;
	// The page's full width, and the region's offset into it, in the detail
	// canvases' pixels — what maps the page's canvas space onto them.
	pageWidth: number;
	offsetX: number;
	offsetY: number;
	pdf: HTMLCanvasElement | null;
	// The highlighter's strokes, multiplied into the sharp page as the page's
	// own highlight layer is into the page — without one, highlights stayed
	// the stretched, blurred copy however far the page was zoomed.
	highlight: HTMLCanvasElement | null;
	ink: HTMLCanvasElement | null;
	overlay: HTMLCanvasElement | null;
	// Whether a highlighter stroke was being drawn at the last paint, so the
	// paint after it lifts takes it off again.
	highlightDrafting: boolean;
	task: RenderTask | null;
	generation: number;
	inkFrame: number | null;
	overlayFrame: number | null;
}

// Parts of the view a finger should work in rather than move the view by:
// the tool strip, the outline and find panel (which scrolls by itself), and
// a note being typed.
const NAVIGATION_EXEMPT = '.inkling-toolbar, .inkling-nav-panel, .inkling-note-editor';

// How long typing in the find field pauses before it searches.
const FIND_AS_YOU_TYPE_MS = 300;

// One press of a zoom key. Matches the step the toolbar buttons use, so
// the two agree about what "zoom in once" means.
const KEYBOARD_ZOOM_STEP = 1.25;

// Single-letter tool shortcuts. Every drawing app has them, and they cost
// nothing here because this view contains no text to type into.
const TOOL_KEYS: Record<string, ToolType | undefined> = {
	s: 'select',
	p: 'pen',
	h: 'highlighter',
	e: 'eraser',
	l: 'line',
	r: 'rectangle',
	o: 'oval',
	a: 'arrow',
};

// pdf.js runs its own parsing off the main thread via a worker it manages
// internally (see main.ts's configurePdfWorker) — a separate worker from
// AnnotationWriterClient's, but the same failure mode applies: if it's
// killed or wedged (mobile memory pressure parsing a large book, the same
// theorized cause as the annotation-writer worker's own crash handling),
// pdf.js's own promise can simply never settle, with no error and no
// timeout of its own. Left unguarded, that hung `await` is indistinguishable
// from "goes black and doesn't pop up" — nothing after it ever runs, so no
// page ever gets far enough to render.
const PDF_LOAD_TIMEOUT_MS = 45000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeout = window.setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				window.clearTimeout(timeout);
				resolve(value);
			},
			(error: unknown) => {
				window.clearTimeout(timeout);
				// Rewrapped rather than passed straight through: pdf.js can
				// reject with values that aren't Errors, and callers here log
				// whatever comes out.
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}

// Stroke width is a length, so it belongs to a coordinate space just as
// much as the points do — canvas pixels here, PDF points on disk, differing
// by the viewport's scale. Converting the points but copying the width
// through unchanged wrote every stroke into the file at RENDER_SCALE times
// its intended thickness (1.5x), which is why ink drawn here came back
// visibly fatter in Obsidian's own PDF view — the file really did say 3
// points where 2 was meant. Scaling it in both directions keeps what's
// drawn, what's saved, and what other PDF software renders identical, and
// keeps thickness stable across a zoom re-render too (which round-trips
// annotations through PDF space at a different scale — see
// upgradeResolution).
function toCanvasSpace(annotation: Annotation, viewport: PageViewport): Annotation {
	const width = annotation.width * viewport.scale;
	// A note keeps its width untouched because it has none that means
	// anything — the marker is a fixed size in whatever space it is drawn
	// in, so only its position converts.
	if (annotation.kind === 'note') return { ...annotation, at: convert(viewport, annotation.at, 'toViewport') };
	if (annotation.kind === 'stroke') {
		return { ...annotation, width, points: annotation.points.map((p) => convert(viewport, p, 'toViewport')) };
	}
	return {
		...annotation,
		width,
		start: convert(viewport, annotation.start, 'toViewport'),
		end: convert(viewport, annotation.end, 'toViewport'),
	};
}

function toPdfSpace(annotation: Annotation, viewport: PageViewport): Annotation {
	const width = annotation.width / viewport.scale;
	if (annotation.kind === 'note') return { ...annotation, at: convert(viewport, annotation.at, 'toPdf') };
	if (annotation.kind === 'stroke') {
		return { ...annotation, width, points: annotation.points.map((p) => convert(viewport, p, 'toPdf')) };
	}
	return {
		...annotation,
		width,
		start: convert(viewport, annotation.start, 'toPdf'),
		end: convert(viewport, annotation.end, 'toPdf'),
	};
}

// pdf.js's viewport transform is already rotation-aware (it's the exact
// matrix used to render the page), so routing both directions through it
// here — rather than hand-deriving a flip/scale — keeps our canvas<->PDF
// coordinate mapping correct for rotated pages too, not just the common
// upright case.
//
// Only the position moves; whatever else a point carries comes with it.
// Rebuilding it as a bare {x, y} dropped stylus pressure on every save and
// every zoom re-render, the same way translateAnnotation once did.
function convert(viewport: PageViewport, point: Point, direction: 'toViewport' | 'toPdf'): Point {
	const result: unknown[] =
		direction === 'toViewport' ? viewport.convertToViewportPoint(point.x, point.y) : viewport.convertToPdfPoint(point.x, point.y);
	const [x, y] = result as [number, number];
	return { ...point, x, y };
}

// One line of real PDF text, in canvas space — used to snap a freehand
// highlighter stroke to straight segments (see snapHighlighterStroke)
// instead of committing it as drawn, and to report the words that stroke
// covered (see src/pdf/textLines.ts, which owns the grouping and clipping).

// pdf.js's text items carry their own transform in the page's raw PDF
// space (unscaled, unrotated — the same space annotation coordinates round
// -trip through via convert() above), not the rendered canvas's pixel
// space, so each one needs converting through the page's viewport just
// like a stroke or shape does. Grouped into lines by proximity of vertical
// center — a single visual line of text is usually split into several
// items (one per run of consistent font/style), not one item per line.
async function computeTextLines(page: PDFPageProxy, viewport: PageViewport): Promise<TextLine[]> {
	const content = await page.getTextContent();

	const boxes: PositionedBox[] = [];
	for (const item of content.items) {
		if (!('str' in item) || !item.str.trim()) continue;
		// pdf.js types `transform` loosely; it is always the six-element
		// matrix [a, b, c, d, e, f], whose last two entries are the item's
		// origin. Typed as a fixed-length tuple so those two read as the
		// numbers they are rather than as possibly-missing array entries.
		const [, , , , e, f] = item.transform as [number, number, number, number, number, number];
		// `f` is the text's *baseline*, not the bottom of its glyphs, so the
		// box runs from a descender's depth below it to the rest of the line
		// height above — see BASELINE_DESCENT_RATIO.
		const bottom = f - item.height * BASELINE_DESCENT_RATIO;
		const top = f + item.height * (1 - BASELINE_DESCENT_RATIO);
		const corners = [
			convert(viewport, { x: e, y: bottom }, 'toViewport'),
			convert(viewport, { x: e + item.width, y: bottom }, 'toViewport'),
			convert(viewport, { x: e, y: top }, 'toViewport'),
			convert(viewport, { x: e + item.width, y: top }, 'toViewport'),
		];
		const xs = corners.map((c) => c.x);
		const ys = corners.map((c) => c.y);
		const minY = Math.min(...ys);
		const maxY = Math.max(...ys);
		// The string is kept, where it used to be read only to skip blanks and
		// then thrown away. Carrying it through is the whole of "extract
		// highlights to notes": the geometry that decides which lines a
		// stroke swept already knows which words those are.
		boxes.push({
			text: item.str,
			minX: Math.min(...xs),
			maxX: Math.max(...xs),
			centerY: (minY + maxY) / 2,
			height: Math.max(maxY - minY, 1),
		});
	}

	return groupIntoLines(boxes);
}

// pdf.js's half of the structure profile (see src/pdf/compatibility.ts).
// `page.view` is the raw MediaBox array, unrotated — the same space
// pdf-lib's getMediaBox reports in. A viewport would fold rotation into the
// dimensions and disagree with pdf-lib on every rotated page, which is
// exactly the false positive this check must not produce.
async function profileFromPdfJs(pdf: PDFDocumentProxy): Promise<StructureProfile> {
	const sampledPages: StructureProfile['sampledPages'] = [];
	for (const index of samplePageIndices(pdf.numPages)) {
		const page = await pdf.getPage(index + 1);
		const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = page.view;
		sampledPages.push({
			index,
			page: { mediaBox: formatMediaBox(x1, y1, x2 - x1, y2 - y1), rotation: normalizeRotation(page.rotate) },
		});
	}
	return { pageCount: pdf.numPages, sampledPages };
}

// Sizes a page placeholder by width plus an aspect ratio, rather than by
// explicit width and height. `.inkling-pdf-page-placeholder` caps width at
// 100% of the view, and with a hard pixel height that cap squashed pages
// horizontally whenever a page was wider than the pane — measured in the
// running app at 685px wide against an unchanged 999px tall, for a page
// whose real proportions are 755x999. Deriving height from the ratio means
// a narrow pane (a phone, a split pane, a sidebar) scales pages down whole
// instead of distorting them, and still reserves correct space before a
// page has rendered. Annotation coordinates are unaffected either way:
// pointer input is mapped through each canvas's own backing-store scale
// (see src/annotate/pointer.ts), not assumed to be 1:1 with CSS pixels.
function sizePlaceholder(placeholder: HTMLElement, width: number, height: number): void {
	// Handed to the stylesheet as custom properties rather than set as
	// inline styles: the actual rules stay in styles.css (and stay
	// themeable), and only the two data-derived numbers cross over.
	placeholder.setCssProps({ '--inkling-page-width': `${width}px`, '--inkling-page-aspect': `${width} / ${height}` });
}

// Accepts both shapes this view can be handed a position in: `{ page: N }`,
// which main.ts sends when swapping over from the native view, and the
// `{ subpath: '#page=N' }` form Obsidian itself uses for PDF links like
// `[[book.pdf#page=42]]`.
function readPageFromEphemeralState(state: unknown): number | null {
	const source = state as { page?: unknown; subpath?: unknown } | null;

	const page = source?.page;
	if (typeof page === 'number' && Number.isFinite(page) && page >= 1) return page;

	if (typeof source?.subpath === 'string') {
		const matched = /#page=(\d+)/.exec(source.subpath);
		if (matched) return Number(matched[1]);
	}

	return null;
}

// Whether two lists hold the same annotations, as the file would.
function sameSet(a: readonly Annotation[], b: readonly Annotation[]): boolean {
	if (a.length !== b.length) return false;
	const byId = new Map(b.map((annotation) => [annotation.id, annotation]));
	return a.every((annotation) => sameInFile(annotation, byId.get(annotation.id)));
}

export class PdfAnnotateView extends FileView {
	private readonly controller: AnnotationController;
	private renderToken = 0;
	private pdf: PDFDocumentProxy | null = null;
	private observer: IntersectionObserver | null = null;
	private renderedPages = new Set<number>();
	// Pages already seeded from the file's own saved annotations — distinct
	// from renderedPages, which recycling (see releasePage) empties again.
	private readonly seededPages = new Set<number>();
	private visiblePages = new Set<number>();
	// The page filling most of the view — see updateCurrentPage — and the
	// frame that will next measure it, if one is pending.
	private currentPageNumber = 1;
	private currentPageFrame: number | null = null;
	private disposeToolbar: (() => void) | null = null;
	private addingPage = false;

	// Per-page pdf.js viewport, kept around for the coordinate conversion
	// above — populated as pages render, cleared on teardown.
	private viewports = new Map<number, PageViewport>();
	// The PDF background canvas for each rendered page, and the pdf.js
	// render scale it's currently backed at — both needed by
	// upgradeResolution to re-render a page sharper once pinch-zoom (see
	// pointer.ts) makes the original RENDER_SCALE render look blurry.
	private pageCanvases = new Map<number, HTMLCanvasElement>();
	private renderedScales = new Map<number, number>();
	// What each page was backed at *unzoomed* — the scale that gives it one
	// canvas pixel per physical device pixel at its laid-out size (see
	// pdf/renderScale.ts). Distinct from renderedScales, which also moves
	// when a page is sharpened for a pinch-zoom; this is the baseline that
	// sharpening is measured against.
	//
	// Computed once per page and then kept, rather than recomputed on every
	// render. A page's annotations live in the coordinate space of the scale
	// it was rendered at, so quietly picking a different one later (after a
	// pane resize, say) would put every stroke on that page in the wrong
	// place — the same reason renderedScales is reused rather than reset.
	private baseScales = new Map<number, number>();
	// The base scale before capToPixelBudget lowered it, where it did. Pen
	// width is measured against this, so that a canvas too large to back at
	// full density still takes ink at the width the pen says — just drawn
	// with fewer pixels — rather than ink that thickens as the canvas grows.
	private inkBaseScales = new Map<number, number>();
	// The scale each page is laid out at — fitted to the pane, the way the
	// core PDF view fits its own (see pdf/renderScale.ts). Kept per page
	// rather than recomputed, for the same reason baseScales is: a page's
	// annotations live in the space it was rendered in, so its size must not
	// move underneath them.
	private layoutScales = new Map<number, number>();
	// Pages currently mid-upgradeResolution — guards against a second pinch
	// ending before the first page's re-render has finished.
	private readonly upgradingPages = new Set<number>();
	// Real PDF text, in canvas space, per page — populated alongside each
	// page's render (see computeTextLines) and used to snap freehand
	// highlighter strokes straight (see snapHighlighterStroke).
	private textLines = new Map<number, TextLine[]>();
	// Annotations read back from the file at open time, in PDF space,
	// seeded into the controller as each page mounts.
	private savedAnnotations = new Map<number, Annotation[]>();
	// Each page's identity in the file the writer has open, by index — see
	// pageIdsOf in pdf/annotationWriterCore.ts. What lets a change from
	// another device be matched page for page when pages were added or
	// deleted there.
	private pageIds: string[] = [];
	// A change from another device being taken in, while it is.
	private pulling: Promise<void> | null = null;
	// Owns the pdf-lib document, parsed once at open time and kept alive off
	// the main thread for the life of the view, reused across every
	// debounced write instead of re-reading and re-parsing the whole file
	// from disk each time — on a large book, a full pdf-lib re-parse on
	// every autosave was real, repeated work that compounded over a long
	// note-taking session and is what "gets laggier and laggier" traced back
	// to. Running it in a worker (see annotationWriter.worker.ts) rather than
	// just caching it here on the main thread is what keeps pdf-lib's save()
	// — genuinely slow, seconds, for a page thick with strokes — from
	// stalling pointer input while the user is actively writing.
	private writer: AnnotationWriterClient | null = null;
	// Pages whose in-memory annotations have changed since the last save.
	private dirtyPages = new Set<number>();
	private writeDebounceHandle: number | null = null;
	// Armed alongside writeDebounceHandle but, unlike it, never reset by a
	// later edit. Continuous handwriting routinely has less than
	// WRITE_DEBOUNCE_MS between one stroke ending and the next starting,
	// which kept resetting the trailing timer before it ever fired — so
	// nothing reached disk until the user stopped for a real pause, and a
	// force-quit lost the whole session's ink.
	private maxWaitHandle: number | null = null;
	// The ceiling for this file specifically — see pdf/saveCadence.ts. Set
	// on load from the file's size; the default covers the window before a
	// file is open.
	private maxWriteInterval = maxWriteIntervalMs(0);
	// Consecutive save failures on the current file. One is worth retrying:
	// a transient adapter error, a file briefly locked by sync. Two in a row
	// is a property of the document, and retrying forever just means a
	// notice every interval for as long as the book stays open.
	private consecutiveWriteFailures = 0;
	// The save in flight, and the one queued behind it. See flushAnnotations.
	private saving: Promise<void> | null = null;
	private saveAgain: Promise<void> | null = null;
	// The outline/find panel and its outline area, held so teardown can
	// drop them and so a find can write into them from a walk that
	// outlives the keystroke that started it.
	private navPanel: HTMLElement | null = null;
	private navOutline: HTMLElement | null = null;
	// Supersedes an in-flight document search. Separate from renderToken:
	// a second search within the same file has to cancel the first, and
	// bumping the render token would cancel the whole page pipeline.
	private findToken = 0;
	// The open note popover, if any. Held so a second note, a file switch,
	// or a teardown can close it rather than leaving it floating over a
	// page it no longer belongs to.
	private noteEditor: HTMLElement | null = null;
	// A per-session override of the inversion setting, or null to follow
	// it. Not persisted: it answers "this one scan is unreadable", not "I
	// always want this".
	private sessionInversion: boolean | null = null;
	// Tracked ourselves rather than trusting FileView's own `this.file` at
	// transition time — see onLoadFile's flush-before-teardown for why.
	private currentFile: TFile | null = null;
	// A page to jump to once this file's placeholders exist, set via
	// setEphemeralState (see main.ts's switchToInkling) — captured here since
	// it can arrive before onLoadFile has finished creating them, in which
	// case scrollToPage would have nothing to find yet.
	private pendingScrollToPage: number | null = null;
	// The undo history, owned here rather than by the controller so that it
	// can be carried into the new coordinate space an infinite canvas's page
	// has each time it grows. Cleared on every load, as the controller's own
	// was.
	private readonly history = new HistoryStack();
	// The open file's page box in PDF space, when it is an infinite canvas
	// (see pdf/infiniteCanvas.ts); null for every other PDF.
	private infiniteBox: PdfBox | null = null;
	private growing = false;
	private growAfterInkHandle: number | null = null;
	private growAfterScrollHandle: number | null = null;
	// Where the current scroll gesture started, for which way it went.
	private scrollGestureStart: { left: number; top: number } | null = null;
	private scrollGrowthArmedAt = 0;
	private reportedCanvasLimit = false;
	// How far the whole view is zoomed, 1 being every page fitted to the
	// pane. Applied as a multiplier on every page's laid-out size (see
	// --inkling-view-zoom in styles.css), so the pages grow and the view
	// scrolls across them, as it does in Obsidian's own reader.
	private viewZoomLevel = 1;
	// The file as this view last wrote or read it, to tell its own saves
	// from another device's when the file changes. And how many of its own
	// writes are under way, for a change reported while one is.
	private knownDisk: { path: string; size: number; mtime: number } | null = null;
	private ownWrites = 0;
	private remoteHandle: number | null = null;
	// Closing: a change from another device taken in now is saved, but the
	// view is not reloaded from it — it is on its way out.
	private unloading = false;
	// A restore under way (see prepareForRestore): the file is about to be
	// replaced on purpose, and that is not another device's change to merge.
	private restoring = false;
	// A save put off because a pen was down, retried shortly (see
	// flushCurrentFileIfAny).
	private gestureFlushHandle: number | null = null;
	// The find field's pause before it searches (see buildNavigationPanel).
	private navSearchHandle: number | null = null;
	// Whether another device has written to this file while it was open
	// here — which makes this view save sooner (see markPageDirty).
	private sharedWithAnotherDevice = false;
	// Sharp regions of pages zoomed in past what their canvas can hold. See
	// renderDetail.
	private readonly details = new Map<number, PageDetail>();
	private detailHandle: number | null = null;
	private detailGeneration = 0;
	private readonly viewZoom: ViewZoom = {
		min: VIEW_MIN_ZOOM,
		max: VIEW_MAX_ZOOM,
		get: () => this.viewZoomLevel,
		anchorAt: (at) => this.viewAnchorAt(at),
		zoomTo: (scale, anchor, at) => this.zoomViewTo(scale, anchor as ViewAnchorPoint, at),
		centre: () => this.viewCentre(),
		settle: () => this.settleViewZoom(),
	};
	// The "opening…" placeholder, held so it can be taken down again from
	// either of the two places that end the wait (pages ready, or a failure).
	private loadingEl: HTMLElement | null = null;

	// A getter rather than a snapshot, so a setting changed while a file
	// is open takes effect on the next stroke instead of the next reopen.
	private readonly getSettings: () => InklingSettings;

	constructor(leaf: WorkspaceLeaf, toolState: ToolState, getSettings: () => InklingSettings = defaultSettings) {
		super(leaf);
		this.getSettings = getSettings;
		this.controller = new AnnotationController({
			// Shared with every other annotating surface, so the pen you set
			// up in a note is the pen you get in a PDF (see annotate/toolState).
			toolState,
			history: this.history,
			onAddPage: () => void this.addPage(),
			onImport: (anchor) => this.showImportMenu(anchor),
			onChangeBackground: (anchor) => this.showBackgroundMenu(anchor),
			getCurrentPage: () => this.currentPageNumber,
			onAnnotationsChanged: (pageNumber) => this.markPageDirty(pageNumber),
			onZoomSettled: (pageNumber, scale) => void this.upgradeResolution(pageNumber, scale),
			// Relative to the page's first render, so an unzoomed page draws
			// exactly as it always has, and a page upgradeResolution has
			// since re-backed denser draws the same width in PDF space rather
			// than a thinner one.
			getInkScale: (pageNumber) => {
				const base = this.inkBaseScales.get(pageNumber) ?? this.baseScales.get(pageNumber);
				const rendered = this.renderedScales.get(pageNumber);
				return base && rendered ? rendered / base : 1;
			},
			onSnapHighlighterStroke: (pageNumber, points, color) => this.snapHighlighterStroke(pageNumber, points, color),
			onGoToPage: (pageNumber) => this.scrollToPage(pageNumber),
			onToggleNavigation: () => this.toggleNavigationPanel(),
			onEditNote: (pageNumber, point, existing) => this.editNote(pageNumber, point, existing),
			isShapeRecognitionEnabled: () => getSettings().shapeRecognition === 'hold',
			onToggleInversion: () => this.toggleInversion(),
			isInverted: () => this.isInverted(),
			viewZoom: this.viewZoom,
			getPenButtonAction: () => getSettings().penButton,
			// Canvas pixels per PDF point, as the page is backed now: what a
			// copy is sized by, so it pastes the same size on any page.
			getUnitScale: (pageNumber) => this.viewports.get(pageNumber)?.scale ?? 1,
			onPageRepainted: (pageNumber, layer) => this.repaintDetail(pageNumber, layer),
		});
	}

	getViewType(): string {
		return VIEW_TYPE_PDF;
	}

	// For the palette commands in main.ts. The controller is private, and
	// should stay that way — a command reaching through the view into it
	// would be a second, undocumented way to drive the same state.
	// Anything still sitting in a debounce, written now. Extraction reads
	// the file from disk, so without this the last minute of highlighting
	// is simply missing from the note it produces.
	async flushPendingWrites(): Promise<void> {
		await this.flushAnnotationsIfDirty(this.currentFile);
	}

	undoAnnotation(): void {
		if (this.controller.isReadOnly()) return;
		this.controller.undo();
	}

	redoAnnotation(): void {
		if (this.controller.isReadOnly()) return;
		this.controller.redo();
	}

	async onOpen(): Promise<void> {
		// One-time per leaf, unlike onLoadFile (which reruns per file) — the
		// leaf's title-bar action row, not the toolbar built per-file below.
		this.addAction('book-open', 'Stop annotating (view only)', () => void this.exitEditMode());
		// On the document, not on contentEl: a keydown only reaches an
		// element that contains the focus, and nothing inside this view
		// takes focus — a canvas is not focusable and there is nothing to
		// type into. So listen globally and check that this view is the one
		// the user is actually looking at.
		// The view's own window's document — a view moved into a popout
		// window types into that window, not the main one.
		this.registerDomEvent(this.contentEl.ownerDocument, 'keydown', (event) => this.handleKey(event));
		// contentEl is the scroll container, and outlives every file shown
		// in it, so this is registered once here rather than per load.
		// Dragging, pinching and trackpad zoom, anywhere in the view — over a
		// page, between pages, or beside them. See attachViewNavigation.
		this.register(
			attachViewNavigation(this.contentEl, this.viewZoom, {
				ignore: (target) => target instanceof Element && target.closest(NAVIGATION_EXEMPT) !== null,
				isBusy: () => this.controller.isGestureActive(),
				onPinchStart: () => this.controller.abandonGesture(),
				// A finger held on a picture picks it up; held anywhere else with
				// something copied, it offers a paste there.
				onLongPress: (at) => this.pickUpPictureAt(at) || this.offerPasteAt(at),
				onTap: (at) => this.tapAt(at),
			}),
		);
		this.registerDomEvent(this.contentEl, 'scroll', () => {
			this.scheduleCurrentPageUpdate();
			this.onScrollForGrowth();
			this.scheduleDetails();
		});
		// Obsidian fires this on a theme switch, which is what follow-theme
		// has to react to.
		this.registerEvent(this.app.workspace.on('css-change', () => this.applyInversion()));
		// The file changing on disk while it is open: another device's save,
		// arriving by sync. See pullRemote.
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && file === this.currentFile) this.onFileChanged(file);
			}),
		);
	}

	// Bare letters are safe here in a way they would not be in a note: this
	// view holds no text to type into. The one place that will (the note
	// popover) is excluded below.
	private handleKey(event: KeyboardEvent): void {
		if (this.app.workspace.getActiveViewOfType(PdfAnnotateView) !== this) return;
		const target = event.target;
		if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea'))) return;

		const modified = event.ctrlKey || event.metaKey;
		const handled = modified ? this.handleModifiedKey(event) : this.handlePlainKey(event);
		if (handled) {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	private handleModifiedKey(event: KeyboardEvent): boolean {
		switch (event.key.toLowerCase()) {
			case 'z':
				// Read-only means there is nothing of ours to undo: the file was
				// never written to this session.
				if (this.controller.isReadOnly()) return false;
				if (event.shiftKey) this.controller.redo();
				else this.controller.undo();
				return true;
			case 'y':
				if (this.controller.isReadOnly()) return false;
				this.controller.redo();
				return true;
			// Only with ink selected, or something copied: otherwise the keys
			// are left to do what they do anywhere else in Obsidian.
			case 'c':
				return this.controller.copySelection();
			case 'x':
				return this.controller.cutSelection();
			case 'v':
				return this.pasteFromKeyboard();
			case '=':
			case '+':
				this.controller.zoomBy(KEYBOARD_ZOOM_STEP);
				return true;
			case '-':
				this.controller.zoomBy(1 / KEYBOARD_ZOOM_STEP);
				return true;
			case '0':
				this.controller.resetZoom();
				return true;
			default:
				return false;
		}
	}

	private handlePlainKey(event: KeyboardEvent): boolean {
		if (event.key === 'Escape') return this.controller.clearSelection();
		// Navigation works whatever state the document is in. Reading a book
		// InklingExpanded refuses to write to is still reading a book.
		if (event.key === 'PageDown') {
			this.scrollToPage(Math.min(this.currentPageNumber + 1, this.controller.getPageCount()));
			return true;
		}
		if (event.key === 'PageUp') {
			this.scrollToPage(Math.max(this.currentPageNumber - 1, 1));
			return true;
		}

		if (this.controller.isReadOnly()) return false;

		const tool = TOOL_KEYS[event.key.toLowerCase()];
		if (tool) {
			this.controller.setTool(tool);
			return true;
		}

		// 1-6 pick the preset swatches, in the order they sit in the strip —
		// which means the *current tool's* strip, so 1 is black ink with the
		// pen selected and yellow with the highlighter, matching what the
		// toolbar is showing at the time the key is pressed.
		const palette = paletteFor(this.controller.getTool());
		const swatch = Number(event.key);
		if (Number.isInteger(swatch) && swatch >= 1 && swatch <= palette.length) {
			const color = palette[swatch - 1];
			if (color) {
				this.controller.setColor(color.value);
				return true;
			}
		}

		if (event.key === '[') {
			this.controller.setWidth(this.controller.getWidth() - 1);
			return true;
		}
		if (event.key === ']') {
			this.controller.setWidth(this.controller.getWidth() + 1);
			return true;
		}
		if (event.key === 'Delete' || event.key === 'Backspace') {
			if (!this.controller.hasSelection()) return false;
			this.controller.deleteSelection();
			return true;
		}

		return false;
	}

	// Hands this leaf back to Obsidian's native PDF view for the same file —
	// restores page number/zoom/outline and drops the editing machinery
	// (pdf-lib, the annotation controller/toolbar) this view needed. The
	// reverse direction (native -> InklingExpanded) lives in main.ts, on a "pencil"
	// action it adds to core PDF view leaves. Carries the current page back
	// the same way that direction does, via ephemeral state, so leaving edit
	// mode doesn't lose your place either.
	private async exitEditMode(): Promise<void> {
		const file = this.currentFile ?? this.file;
		if (!file) return;
		// `{ subpath: '#page=N' }`, not `{ page: N }` — verified against the
		// running app: the core PDF view honours the subpath form (the same
		// one `[[file.pdf#page=5]]` links use) and ignores a bare page
		// number, so the earlier shape carried nothing over.
		await this.leaf.setViewState(
			{ type: CORE_PDF_VIEW_TYPE, state: { file: file.path } },
			{ subpath: `#page=${this.currentPageNumber}` },
		);
	}

	// Obsidian's ephemeral-state passthrough (see main.ts's switchToInkling)
	// — receives whatever page the native view had been showing. Undocumented
	// shape (the core PDF view isn't part of the public API), so this reads
	// defensively and simply does nothing if it doesn't look like what's
	// expected, rather than risk misinterpreting some other view's state.
	setEphemeralState(state: unknown): void {
		const page = readPageFromEphemeralState(state);
		if (page === null) return;
		this.pendingScrollToPage = page;
		// Works immediately if this file's placeholders already exist (this
		// fired after onLoadFile finished); otherwise onLoadFile itself
		// applies pendingScrollToPage once they do.
		this.scrollToPage(page);
	}

	async onLoadFile(file: TFile): Promise<void> {
		// teardown() below cancels the pending debounced write and clears
		// dirty-page tracking with no save of its own — onUnloadFile covers
		// the normal "switching files" case by flushing first, but nothing
		// guarantees onLoadFile is always preceded by onUnloadFile on this
		// same view instance (e.g. Obsidian re-navigating to a file already
		// open in this leaf). Flushing here too, unconditionally, closes
		// that gap so a still-debouncing edit can never be silently lost —
		// this is what "erase/edit works, then reverts on reopen" traced
		// back to.
		await this.flushAnnotationsIfDirty(this.currentFile);
		// A save that found the file changed by another device leaves its ink
		// dirty for that change to be taken in first. Taken in now, and the
		// ink saved on top of it: the teardown below would otherwise lose it.
		const previous = this.currentFile;
		if (previous && this.dirtyPages.size > 0 && (await this.changedOnDisk(previous))) {
			await this.pullRemote(previous, true);
			await this.flushAnnotationsIfDirty(previous);
		}
		this.currentFile = file;

		const token = ++this.renderToken;
		this.teardown();
		this.contentEl.addClass('inkling-pdf-view');
		// A new document is a new question about legibility.
		this.sessionInversion = null;
		this.applyInversion();
		this.disposeToolbar = buildToolbar(this.contentEl, this.controller, { app: this.app });
		this.buildNavigationPanel();

		// Everything below this point is asynchronous — reading the file,
		// parsing it in the writer worker, then opening it in pdf.js — and a
		// large document spends a noticeable stretch in it. Until now that
		// stretch showed an empty content area under a live toolbar, which
		// reads as "the plugin opened the file and it's blank" rather than
		// "still working". Removed the moment there are placeholders to look
		// at instead, and by showLoadError if we never get that far.
		this.showLoading();

		// The annotation-writer worker parses the file (off the main thread —
		// see its own comment for why) to: read back our own previously-saved
		// annotations (for the overlay); stay the doc instance every later
		// write reuses; and build the copy pdf.js should render from, with
		// only *our* annotations stripped out so its default annotation-
		// baking render still shows annotations from other PDF software
		// (Xodo, etc.) without doubling up with our own live overlay.
		// Set again below, once the file has been classified: whether it can
		// be appended to rather than rewritten is what the ceiling now turns
		// on, and that is not known until the writer has parsed it. The
		// shortest interval until then, so a load that fails before
		// classification does not inherit a stale one from the previous file.
		this.maxWriteInterval = maxWriteIntervalMs(0);
		this.consecutiveWriteFailures = 0;
		const bytes = await this.app.vault.readBinary(file);
		await this.rememberDisk(file);

		// `this.teardown()` above already terminated the previous file's
		// writer (if any) — this one is this load's own, kept local until we
		// know it's still wanted, since a newer onLoadFile racing this one
		// (rapid file-switching) would otherwise have its own fresh writer
		// clobbered by this call finishing late.
		// `writer` is constructed *inside* this try, not before it — its
		// constructor opens a Worker, which can itself throw synchronously
		// (confirmed via a real device: a cross-origin Worker construction
		// SecurityError, now worked around in resolveWorkerUrl, but a future
		// failure of some other kind should degrade the same way an open()
		// failure already does below, not silently abort the rest of this
		// file's load with the toolbar up and nothing else — see this
		// function's other comments for what that looked like.
		let writer: AnnotationWriterClient | null = null;
		let savedAnnotations: Map<number, Annotation[]>;
		let displayBytes: ArrayBuffer;
		// Left null/empty when open() fails: that means `writer` is null, so
		// nothing will be written to this file at all this session — there is
		// nothing for the gate to protect and no profile to check against.
		let profile: StructureProfile | null = null;
		let risky: string[] = [];
		// Both halves have to hold. The writer decides whether the *file* can
		// be appended to; only here can we see whether this Obsidian has
		// Vault.appendBinary at all — it is `@since 1.12.3` against a
		// minAppVersion of 1.4.4.
		let incremental = false;
		let pageIds: string[] = [];
		try {
			writer = new AnnotationWriterClient();
			const opened = await writer.open(bytes);
			pageIds = opened.pageIds ?? [];
			savedAnnotations = opened.savedAnnotations;
			displayBytes = opened.displayBytes;
			profile = opened.profile;
			risky = opened.risky;
			incremental = opened.incremental && canAppendBinary(this.app.vault);
		} catch (error) {
			console.error('InklingExpanded: could not read existing annotations from this file.', error);
			new Notice("InklingExpanded: could not read this PDF's existing annotations — any already on it won't show up this time.");
			writer?.terminate();
			writer = null;
			savedAnnotations = new Map();
			// `bytes` was already transferred into (and detached by) the
			// worker above regardless of whether it then failed to parse —
			// re-read a fresh copy so pdf.js still has something to render.
			displayBytes = await this.app.vault.readBinary(file);
		}
		if (token !== this.renderToken) {
			writer?.terminate();
			return;
		}
		this.writer = writer;
		this.savedAnnotations = savedAnnotations;
		this.pageIds = pageIds;

		// "Frequent" is stated as a zero size, which the size-scaled mapping
		// already answers with its shortest interval — one place decides how
		// often a file is written, rather than two that can disagree.
		this.maxWriteInterval = maxWriteIntervalMs(
			this.getSettings().saveCadence === 'frequent' ? 0 : file.stat.size,
			incremental,
		);

		let pdf: PDFDocumentProxy;
		try {
			pdf = await withTimeout(getDocument({ data: displayBytes, isEvalSupported: false }).promise, PDF_LOAD_TIMEOUT_MS, 'InklingExpanded: timed out opening this PDF.');
		} catch (error) {
			console.error('InklingExpanded: failed to open this PDF for rendering.', error);
			new Notice('InklingExpanded: could not open this PDF for annotating — try again, or reopen it in reading view.');
			this.showLoadError();
			return;
		}
		if (token !== this.renderToken) {
			await pdf.destroy();
			return;
		}
		this.pdf = pdf;

		// Whether pdf-lib can be trusted to rewrite this file at all. A
		// disagreement between the two parsers means pdf-lib's model of the
		// document is incomplete, and every save would serialize from that
		// incomplete model. Better to render the book and refuse to draw on
		// it than to quietly damage it.
		let refusal: string | null = risky.length > 0 ? `it contains ${risky.join(' and ')}` : null;
		if (!refusal && profile) {
			try {
				refusal = compareProfiles(profile, await profileFromPdfJs(pdf));
			} catch (error) {
				console.error('InklingExpanded: could not check this PDF for editing safety.', error);
				refusal = 'its structure could not be checked';
			}
		}
		if (token !== this.renderToken) return;

		this.controller.setReadOnly(refusal !== null);
		if (refusal) this.showReadOnlyBanner(refusal);

		let metadata: Awaited<ReturnType<PDFDocumentProxy['getMetadata']>>;
		let firstPage: PDFPageProxy;
		try {
			// Both still depend on the same pdf.js worker that just parsed the
			// document above — a worker that went quiet mid-parse could just as
			// easily go quiet here instead, so these get the same guard.
			metadata = await withTimeout(pdf.getMetadata(), PDF_LOAD_TIMEOUT_MS, 'InklingExpanded: timed out reading this PDF.');
			if (token !== this.renderToken) return;
			// Real textbooks/technical docs are hundreds of pages; rendering all
			// of them eagerly on open is what made switching PDFs slow. Use one
			// page's viewport to size every placeholder up front (most documents
			// share a page size), then only render a page once it actually
			// scrolls into view.
			firstPage = await withTimeout(pdf.getPage(1), PDF_LOAD_TIMEOUT_MS, 'InklingExpanded: timed out reading this PDF.');
		} catch (error) {
			console.error('InklingExpanded: failed to read this PDF for rendering.', error);
			new Notice('InklingExpanded: could not open this PDF for annotating — try again, or reopen it in reading view.');
			this.showLoadError();
			return;
		}
		if (token !== this.renderToken) return;
		const keywords = (metadata.info as { Keywords?: string }).Keywords;
		// One page, or it is not a canvas whatever its keywords say: the
		// growth below only ever reasons about page 1.
		this.infiniteBox = isInfiniteCanvasKeywords(keywords) && pdf.numPages === 1 ? boxFromView(firstPage.view) : null;
		this.contentEl.toggleClass('is-infinite', this.infiniteBox !== null);
		// "Add page" works on any PDF — a note this plugin made, or a book or
		// a handout from anywhere else — and means nothing only on a sheet
		// that grows by itself.
		this.controller.setCanManagePages(this.infiniteBox === null);
		this.controller.setCanChangeBackground(true);
		// A canvas is laid out at its real size from the start rather than at
		// an estimate: it is usually far from the size of a page, and an
		// estimate would jump when the real one arrived.
		const estimatedViewport = firstPage.getViewport({
			scale: this.infiniteBox ? this.layoutScaleFor(1, INFINITE_BASE_WIDTH) : RENDER_SCALE,
		});

		// Stays subscribed to every placeholder for the life of the view
		// (never unobserved) — it doubles as the "which page is the user
		// currently on" signal that "Add page" needs, not just a
		// render-on-scroll trigger.
		const observer = new IntersectionObserver(
			(entries) => this.onIntersect(entries, token),
			// Roughly a page of lead in each direction, so a page has usually
			// finished rendering before it's scrolled into view rather than
			// arriving blank and filling in late — much more noticeable now
			// that a flick keeps gliding (see pointer.ts's momentum). Kept
			// under PAGE_RETAIN_MARGIN so pre-rendered pages aren't
			// immediately recycled again.
			{ root: this.contentEl, rootMargin: '1000px 0px' },
		);
		this.observer = observer;

		this.controller.setPageCount(pdf.numPages);
		this.clearLoading();
		// Not awaited: an outline is a convenience, and resolving every
		// destination on a deeply nested one is a per-entry pdf.js call no
		// reader should wait behind to see page 1.
		void this.loadOutline(pdf, token);

		for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
			const placeholder = this.contentEl.createDiv({
				cls: 'inkling-pdf-page-placeholder',
			});
			placeholder.dataset[PAGE_NUMBER_ATTR] = String(pageNumber);
			sizePlaceholder(placeholder, estimatedViewport.width, estimatedViewport.height);
			// A small page number in the corner of the sheet. A sibling of
			// the zoomable `.inkling-page-content` rather than a child, so
			// pinch-zooming a page doesn't blow the number up with it, and
			// pointer-events: none in styles.css so it can never swallow a
			// stroke that starts on top of it.
			placeholder.createDiv({ cls: 'inkling-page-number', text: String(pageNumber) });
			observer.observe(placeholder);
		}

		// Covers setEphemeralState firing *before* this — its own immediate
		// scrollToPage call would have found no placeholders yet at that
		// point, since this is what creates them.
		if (this.pendingScrollToPage != null) {
			this.scrollToPage(this.pendingScrollToPage);
			this.pendingScrollToPage = null;
		}

		this.scrollGrowthArmedAt = performance.now() + SCROLL_GROWTH_SETTLE_MS;
	}

	async onUnloadFile(): Promise<void> {
		const file = this.currentFile;
		// Saved first, with the view still whole: a save that finds the file
		// changed by another device takes that change in before it saves, and
		// that needs this file still open and its render token unchanged.
		// Bumping the token before the save used to make it give up there,
		// and the teardown below then threw the unsaved ink away.
		this.unloading = true;
		try {
			await this.flushAnnotationsIfDirty(file);
			if (file && this.dirtyPages.size > 0 && (await this.changedOnDisk(file))) {
				await this.pullRemote(file, true);
				await this.flushAnnotationsIfDirty(file);
			}
			if (file && this.dirtyPages.size > 0) {
				console.error(`InklingExpanded: ink on ${this.dirtyPages.size} page(s) of ${file.path} could not be saved before it closed.`);
				new Notice(`InklingExpanded: some ink on “${file.basename}” could not be saved before it closed.`);
			}
		} finally {
			this.unloading = false;
		}
		this.renderToken++;
		this.currentFile = null;
		this.teardown();
	}

	// The leaf itself going away, as opposed to teardown()'s per-file reset:
	// the controller is built once per leaf, and it holds a subscription to
	// the plugin-wide ToolState, which outlives every view over it. Without
	// this, each PDF leaf ever opened would stay reachable from that state
	// for the rest of the session.
	//
	// super first, and awaited. FileView's own onClose is what runs
	// loadFile(null), and that is the only path by which onUnloadFile — the
	// flush and the teardown — happens when a view closes. Skipping it left
	// the save debounce armed and the writer alive while destroy() below
	// emptied the store, so the debounce saved every unsaved page as blank:
	// a page of handwriting lost to "Stop annotating" on 2026-09-16.
	async onClose(): Promise<void> {
		await super.onClose();
		this.controller.destroy();
	}

	private teardown() {
		this.observer?.disconnect();
		this.observer = null;
		this.renderedPages.clear();
		this.seededPages.clear();
		this.visiblePages.clear();
		if (this.currentPageFrame !== null) {
			window.cancelAnimationFrame(this.currentPageFrame);
			this.currentPageFrame = null;
		}
		this.currentPageNumber = 1;
		// Back to a single page, so the toolbar's readout can't briefly show
		// the *previous* file's length while the next one is still loading.
		this.controller.setPageCount(1);
		this.viewports.clear();
		this.pageCanvases.clear();
		this.renderedScales.clear();
		this.baseScales.clear();
		this.inkBaseScales.clear();
		this.history.clear();
		this.infiniteBox = null;
		this.contentEl.classList.remove('is-infinite');
		this.cancelGrowthChecks();
		this.reportedCanvasLimit = false;
		if (this.remoteHandle !== null) window.clearTimeout(this.remoteHandle);
		this.remoteHandle = null;
		if (this.gestureFlushHandle !== null) window.clearTimeout(this.gestureFlushHandle);
		this.gestureFlushHandle = null;
		if (this.navSearchHandle !== null) window.clearTimeout(this.navSearchHandle);
		this.navSearchHandle = null;
		this.sharedWithAnotherDevice = false;
		for (const pageNumber of [...this.details.keys()]) this.removeDetail(pageNumber);
		if (this.detailHandle !== null) window.clearTimeout(this.detailHandle);
		this.detailHandle = null;
		if (this.viewZoomLevel !== 1) {
			this.viewZoomLevel = 1;
			this.contentEl.setCssProps({ '--inkling-view-zoom': '1' });
		}
		this.layoutScales.clear();
		this.upgradingPages.clear();
		this.textLines.clear();
		this.pendingScrollToPage = null;
		// Bumped so an in-flight document search stops walking a file that
		// is no longer open.
		this.findToken++;
		this.closeNoteEditor();
		this.navPanel = null;
		this.navOutline = null;
		if (this.writeDebounceHandle !== null) {
			window.clearTimeout(this.writeDebounceHandle);
			this.writeDebounceHandle = null;
		}
		if (this.maxWaitHandle !== null) {
			window.clearTimeout(this.maxWaitHandle);
			this.maxWaitHandle = null;
		}
		this.dirtyPages.clear();
		this.writer?.terminate();
		this.writer = null;
		this.pageIds = [];
		void this.pdf?.destroy();
		this.pdf = null;
		this.controller.unmountAll();
		this.disposeToolbar?.();
		this.disposeToolbar = null;
		this.contentEl.empty();
		// Already gone with the emptied contentEl — this just stops us
		// holding a detached node until the next load replaces it.
		this.loadingEl = null;
	}

	private onIntersect(entries: IntersectionObserverEntry[], token: number) {
		for (const entry of entries) {
			const placeholder = entry.target as HTMLElement;
			const pageNumber = Number(placeholder.dataset[PAGE_NUMBER_ATTR]);

			if (entry.isIntersecting) {
				this.visiblePages.add(pageNumber);
				if (!this.renderedPages.has(pageNumber)) {
					this.renderedPages.add(pageNumber);
					void this.renderPage(placeholder, pageNumber, token);
				}
			} else {
				this.visiblePages.delete(pageNumber);
			}
		}

		this.updateCurrentPage();
		this.releaseDistantPages();
	}

	// Batched to one measurement a frame; scroll events come far faster.
	private scheduleCurrentPageUpdate(): void {
		if (this.currentPageFrame !== null) return;
		this.currentPageFrame = window.requestAnimationFrame(() => {
			this.currentPageFrame = null;
			this.updateCurrentPage();
		});
	}

	// The page filling most of the view, measured now.
	//
	// Not from the observer. It is padded by a screen in each direction (see
	// its rootMargin) so pages render before they arrive, which means it only
	// reports a page crossing that padding — a screen away from anything the
	// reader can see. Deciding "on screen" from its entries left a page
	// current long after it scrolled off: in a two-page note, page 1 never
	// left the padding, so page 2 could never become current, and zooming it
	// showed no zoom readout at all. Measured on scroll instead, and only
	// over the padded set, which is a handful of pages however long the book.
	private updateCurrentPage(): void {
		const container = this.contentEl.getBoundingClientRect();
		let best: number | null = null;
		let bestShown = 0;
		for (const pageNumber of [...this.visiblePages].sort((a, b) => a - b)) {
			const placeholder = this.contentEl.querySelector<HTMLElement>(
				`.inkling-pdf-page-placeholder[data-page-number="${pageNumber}"]`,
			);
			if (!placeholder) continue;
			const rect = placeholder.getBoundingClientRect();
			const shown = Math.min(rect.bottom, container.bottom) - Math.max(rect.top, container.top);
			if (shown > bestShown) {
				best = pageNumber;
				bestShown = shown;
			}
		}

		const previousPageNumber = this.currentPageNumber;
		if (best !== null) {
			this.currentPageNumber = best;
		} else if (this.visiblePages.size > 0) {
			this.currentPageNumber = Math.min(...this.visiblePages);
		}
		// The toolbar's readouts are the only thing watching this, and
		// scrolling isn't something the controller can observe for itself —
		// so tell it, but only on an actual change.
		if (this.currentPageNumber !== previousPageNumber) {
			this.controller.refreshUi();
			this.markCurrentChapter();
		}
	}

	// Tears scrolled-far-away pages back down to bare placeholders — see
	// PAGE_RETAIN_MARGIN. Their layout footprint is unchanged (the
	// placeholder keeps the explicit size set when it rendered), so this
	// never shifts the scroll position out from under the reader.
	private releaseDistantPages(): void {
		if (this.visiblePages.size === 0) return;

		const lowest = Math.min(...this.visiblePages) - PAGE_RETAIN_MARGIN;
		const highest = Math.max(...this.visiblePages) + PAGE_RETAIN_MARGIN;

		for (const pageNumber of [...this.renderedPages]) {
			if (pageNumber >= lowest && pageNumber <= highest) continue;
			// A pinch-zoomed page's zoom/pan lives on the very element this
			// would remove (and in controller state keyed to that mount), so
			// leave those alone rather than silently resetting someone's zoom
			// on a page they're likely to come back to.
			if (this.controller.getPageZoom(pageNumber) !== 1) continue;
			this.releasePage(pageNumber);
		}
	}

	private releasePage(pageNumber: number): void {
		const placeholder = this.contentEl.querySelector<HTMLElement>(
			`.inkling-pdf-page-placeholder[data-page-number="${pageNumber}"]`,
		);
		this.removeDetail(pageNumber);
		placeholder?.querySelector('.inkling-page-content')?.remove();

		this.controller.unmountPage(pageNumber);
		this.renderedPages.delete(pageNumber);
		this.pageCanvases.delete(pageNumber);

		// `viewports` and `renderedScales` deliberately survive: a still-dirty
		// page needs its viewport to convert annotations back to PDF space at
		// save time (without it flushAnnotations would skip the page and lose
		// the edit), and keeping the scale means re-rendering reuses the exact
		// canvas space the stored annotations are already in. They're small —
		// the canvases were the memory that mattered.
	}

	private async renderPage(placeholder: HTMLElement, pageNumber: number, token: number) {
		const pdf = this.pdf;
		if (!pdf) return;

		const page = await pdf.getPage(pageNumber);
		if (token !== this.renderToken) return;

		// Re-rendering a page that was recycled (see releasePage) reuses the
		// scale it last had, not the default: annotations for that page are
		// still held in the controller's store in *that* render's canvas
		// space, so coming back at a different scale would put every stroke
		// in the wrong place. It also means a page sharpened for zoom comes
		// back sharp.
		// Two scales, deliberately: one for how big the page is drawn, one for
		// how densely its canvas is backed. Keeping them apart is what lets
		// upgradeResolution sharpen a pinch-zoomed page by raising only the
		// backing store, with no reflow.
		const pagePointWidth = page.getViewport({ scale: 1 }).width;
		// A canvas keeps the zoom its starting page was fitted at, however wide
		// it has grown, so that growing never shrinks the ink already on it.
		const layoutScale = this.layoutScaleFor(pageNumber, this.infiniteBox ? INFINITE_BASE_WIDTH : pagePointWidth);
		const layoutViewport = page.getViewport({ scale: layoutScale });
		sizePlaceholder(placeholder, layoutViewport.width, layoutViewport.height);

		const pagePointHeight = page.getViewport({ scale: 1 }).height;
		// A page rendered for the first time while the view is zoomed is
		// rendered for the zoom, not for its fitted size and then again.
		const scale =
			this.renderedScales.get(pageNumber) ??
			capToPixelBudget(
				zoomedRenderScale(this.baseScaleFor(pageNumber, layoutViewport.width, pagePointWidth, pagePointHeight), this.viewZoomLevel),
				pagePointWidth,
				pagePointHeight,
			);
		const viewport = page.getViewport({ scale });

		// A separate transformable layer inside the placeholder's fixed-size
		// (and, per styles.css, clipped) box — pinch-zoom/pan (see pointer.ts)
		// scales and translates this element, not the placeholder itself, so
		// zooming into one page never changes its footprint in the scrolling
		// list of pages or overlaps its neighbors. The pdf page canvas and
		// both annotation layers all live inside it, so they zoom and pan
		// together as one picture.
		const content = placeholder.createDiv({ cls: 'inkling-page-content' });

		const canvas = content.createEl('canvas', { cls: 'inkling-pdf-page' });
		canvas.width = viewport.width;
		canvas.height = viewport.height;

		try {
			// pdf.js bakes /Annots onto this same canvas by default
			// (AnnotationMode.ENABLE) — left on so *foreign* annotations (from
			// other PDF software, e.g. Xodo) are still visible while editing.
			// Our own never reach this render at all: `pdf` above was opened
			// from the annotation-writer worker's displayBytes, which already
			// has only *our* annotations stripped out (see its comment), so
			// they render exclusively — and always currently — through our
			// own live overlay instead.
			await page.render({ canvas, viewport, annotationMode: AnnotationMode.ENABLE }).promise;
		} catch (error) {
			// Expected when the view is torn down (file switched/closed) while
			// a scrolled-past page was still rendering — the in-flight task
			// gets cancelled along with the rest of the document.
			if (!(error instanceof RenderingCancelledException)) {
				console.error(`InklingExpanded: failed to render PDF page ${pageNumber}.`, error);
				return;
			}
		}

		if (token !== this.renderToken) return;
		this.viewports.set(pageNumber, viewport);
		this.pageCanvases.set(pageNumber, canvas);
		// The scale it was actually rendered at, which is not always the base
		// one: a page recycled after being sharpened for zoom comes back at
		// the scale it left at, and recording RENDER_SCALE here (as this used
		// to) left renderedScales disagreeing with the viewport stored beside
		// it about the space that page's annotations are in.
		this.renderedScales.set(pageNumber, scale);
		this.controller.mountPage(pageNumber, content, viewport.width, viewport.height);

		// Only ever on a page's first render. A recycled page (see
		// releasePage) coming back would otherwise be re-seeded from the
		// file's original contents, overwriting everything drawn on it this
		// session — mountPage above already redrew it from the store, which
		// is the live truth for a page that's been mounted before.
		if (!this.seededPages.has(pageNumber)) {
			this.seededPages.add(pageNumber);
			const saved = this.savedAnnotations.get(pageNumber);
			if (saved && saved.length > 0) {
				this.controller.seedPage(pageNumber, saved.map((a) => toCanvasSpace(a, viewport)));
			}
		}
		// A recycled page comes back at the scale it left at, which the view
		// may since have been zoomed well away from.
		void this.upgradeResolution(pageNumber, this.viewZoomLevel);
		this.scheduleDetails();

		// Not awaited — a highlighter stroke drawn before this resolves just
		// falls back to committing as freehand (see snapHighlighterStroke),
		// rather than holding up the page's actual render/mount on text
		// extraction it may never even need.
		computeTextLines(page, viewport)
			.then((lines) => {
				if (token === this.renderToken) this.textLines.set(pageNumber, lines);
			})
			.catch((error: unknown) => {
				console.error(`InklingExpanded: failed to read text content for PDF page ${pageNumber}.`, error);
			});
	}

	// The scale to back a page's canvas at, the first time it is rendered.
	//
	// This is the fix for "the PDF got blurrier the moment I opened it to
	// annotate". The view used to render every page at a flat 1.5 and lay it
	// out at 1.5 too, which is exactly one canvas pixel per CSS pixel — so on
	// any display with a devicePixelRatio above 1 (a 150%-scaled Windows
	// desktop, a retina Mac, a tablet) the browser upscaled that raster to
	// fill the real pixels. Obsidian's own PDF view is pdf.js's viewer, which
	// applies devicePixelRatio as a matter of course, so switching a leaf
	// into this one visibly softened the page. src/markdown/inkBlock.ts had
	// always done this correctly for ink blocks; only the PDF view had not.
	//
	// `clientWidth` rather than the layout width, so a page shrunk to fit a
	// narrow pane is rendered for the size it is really displayed at instead
	// of the size it would have liked to be — the memory saved there is what
	// pays for the density.
	private baseScaleFor(pageNumber: number, layoutWidth: number, pagePointWidth: number, pagePointHeight: number): number {
		const existing = this.baseScales.get(pageNumber);
		if (existing !== undefined) return existing;

		const ideal = baseRenderScale(layoutWidth, pagePointWidth, window.devicePixelRatio || 1);
		const scale = capToPixelBudget(ideal, pagePointWidth, pagePointHeight);
		this.baseScales.set(pageNumber, scale);
		this.inkBaseScales.set(pageNumber, ideal);
		return scale;
	}

	// How big to draw this page: fitted to the width the scroll container
	// actually has, rather than a flat multiple of the page's size in points.
	// This is the half of the sharpness fix that mattered on an ordinary 1x
	// desktop — the old fixed 1.5x drew a 540pt page 810px wide in a pane
	// where the core PDF view drew it 1224px, so two thirds of the
	// resolution was never asked for in the first place.
	private layoutScaleFor(pageNumber: number, pagePointWidth: number): number {
		const existing = this.layoutScales.get(pageNumber);
		if (existing !== undefined) return existing;

		const scale = layoutRenderScale(this.availablePageWidth(), pagePointWidth);
		this.layoutScales.set(pageNumber, scale);
		return scale;
	}

	// The CSS width a page placeholder has to fill. `clientWidth` includes
	// the container's own padding, which the placeholders sit inside of, so
	// the padding has to come back off — measured rather than assumed,
	// because it is set in the stylesheet in theme units.
	private availablePageWidth(): number {
		const container = this.contentEl;
		const style = window.getComputedStyle(container);
		const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
		return Math.max(container.clientWidth - padding, 0);
	}

	// Fired once a pinch-zoom gesture on a page settles (see
	// AnnotationController's onZoomSettled) — the original render is a
	// fixed-resolution raster, so CSS-transform zoom past it just shows that
	// same raster larger and blurrier past a point. Re-rendering the page at
	// a resolution matching how zoomed-in the user actually is fixes that —
	// the CSS size stays exactly the same (only the canvas's backing-store
	// pixel density increases), so this never causes any layout shift.
	private async upgradeResolution(pageNumber: number, zoomScale: number): Promise<void> {
		if (!this.pdf || this.upgradingPages.has(pageNumber)) return;

		const base = this.baseScales.get(pageNumber) ?? RENDER_SCALE;
		const currentScale = this.renderedScales.get(pageNumber) ?? base;
		// Measured from this page's own base rather than from a flat
		// constant, so zooming in keeps the one-canvas-pixel-per-device-pixel
		// relationship the unzoomed page already has instead of dropping back
		// to it.
		const canvas = this.pageCanvases.get(pageNumber);
		const oldViewport = this.viewports.get(pageNumber);
		if (!canvas || !oldViewport) return;
		// And never past what one canvas can hold, which a large page — an
		// infinite canvas especially — reaches long before MAX_RENDER_SCALE.
		const targetScale = capToPixelBudget(
			zoomedRenderScale(base, zoomScale),
			oldViewport.width / oldViewport.scale,
			oldViewport.height / oldViewport.scale,
		);
		// Not worth a re-render for a marginal gain. Downwards only once the
		// page is backed far denser than it is now shown: a page zoomed in on
		// and then zoomed back out from would otherwise keep its large canvas,
		// and with the whole view zoomed out there can be many of them.
		if (targetScale <= currentScale * 1.15 && targetScale >= currentScale / 1.5) return;

		this.upgradingPages.add(pageNumber);
		const token = this.renderToken;
		try {
			const page = await this.pdf.getPage(pageNumber);
			if (token !== this.renderToken) return;

			const newViewport = page.getViewport({ scale: targetScale });
			canvas.width = newViewport.width;
			canvas.height = newViewport.height;
			await page.render({ canvas, viewport: newViewport, annotationMode: AnnotationMode.ENABLE }).promise;
			if (token !== this.renderToken) return;
			// Recycled out from under this while it rendered (see
			// releasePage): resizePage below would no-op with no mount to
			// resize, but the viewport/scale bookkeeping after it would still
			// be updated — leaving this page's stored annotations in the old
			// canvas space while its recorded viewport claimed the new one,
			// which would misplace every stroke on save.
			if (!this.renderedPages.has(pageNumber)) return;

			// Existing strokes are in the *old* render's canvas-space — round
			// them through PDF space (invariant regardless of render scale)
			// into the new one, via the same two helpers used for saving.
			const reprojected = this.controller
				.getPageAnnotations(pageNumber)
				.map((a) => toCanvasSpace(toPdfSpace(a, oldViewport), newViewport));
			this.controller.resizePage(pageNumber, newViewport.width, newViewport.height, reprojected);

			this.viewports.set(pageNumber, newViewport);
			this.renderedScales.set(pageNumber, targetScale);
		} catch (error) {
			if (!(error instanceof RenderingCancelledException)) {
				console.error(`InklingExpanded: failed to sharpen PDF page ${pageNumber} for zoom.`, error);
			}
		} finally {
			this.upgradingPages.delete(pageNumber);
			this.scheduleDetails();
		}
	}

	// See AnnotationControllerOptions.onSnapHighlighterStroke — replaces a
	// freehand highlighter path with one straight segment per real text line
	// it swept over (clipped to however much of that line's width the
	// stroke actually covered), so dragging over text comes out straight
	// instead of following the pen's natural wobble. Returns null (falling
	// back to the raw freehand stroke) when this page's text hasn't been
	// read yet, or the stroke isn't over any text at all — a highlighter
	// used freehand in a margin or over a diagram works exactly as before.
	private snapHighlighterStroke(pageNumber: number, points: Point[], color: string): Annotation[] | null {
		const lines = this.textLines.get(pageNumber);
		if (!lines || lines.length === 0 || points.length === 0) return null;

		const xs = points.map((p) => p.x);
		const ys = points.map((p) => p.y);
		const strokeMinX = Math.min(...xs);
		const strokeMaxX = Math.max(...xs);
		const strokeMinY = Math.min(...ys);
		const strokeMaxY = Math.max(...ys);

		const hits = lines.filter((line) => {
			const halfHeight = line.height / 2;
			return (
				line.centerY + halfHeight >= strokeMinY &&
				line.centerY - halfHeight <= strokeMaxY &&
				line.maxX >= strokeMinX &&
				line.minX <= strokeMaxX
			);
		});
		if (hits.length === 0) return null;

		return hits.map((line): Annotation => {
			const from = Math.max(line.minX, strokeMinX);
			const to = Math.min(line.maxX, strokeMaxX);
			// The words this segment covers, taken from the very geometry
			// that decided which lines the stroke swept. No new interaction,
			// no text layer, no second pass — the highlighter gesture is
			// exactly what it was, and it now knows what it highlighted.
			const quote = quoteBetween(line, from, to);
			return {
				id: createId(),
				kind: 'stroke',
				tool: 'highlighter',
				color,
				// Not the full reported line height: that is the font size,
				// leading included, and a bar drawn at it runs into the lines
				// above and below. See highlightBarHeight.
				width: highlightBarHeight(line.height),
				points: [
					{ x: from, y: line.centerY },
					{ x: to, y: line.centerY },
				],
				// Omitted rather than stored empty: an absent quote means
				// "recompute me", and an empty one would mean "this covers no
				// words", which is a different and wrong claim.
				...(quote ? { quote } : {}),
			};
		});
	}

	private markPageDirty(pageNumber: number): void {
		this.dirtyPages.add(pageNumber);
		if (this.infiniteBox) this.scheduleGrowthFromInk();

		if (this.writeDebounceHandle !== null) window.clearTimeout(this.writeDebounceHandle);
		this.writeDebounceHandle = window.setTimeout(
			() => this.flushCurrentFileIfAny(),
			this.sharedWithAnotherDevice ? SHARED_WRITE_DEBOUNCE_MS : WRITE_DEBOUNCE_MS,
		);

		// Deliberately NOT reset here the way writeDebounceHandle above is.
		// Only armed when nothing's already pending, so it fires a fixed time
		// after the *first* unsaved edit in a batch, regardless of how many
		// more edits reset the trailing debounce in the meantime.
		if (this.maxWaitHandle === null) {
			this.maxWaitHandle = window.setTimeout(() => this.flushCurrentFileIfAny(), this.maxWriteInterval);
		}
	}

	private flushCurrentFileIfAny(): void {
		if (!this.currentFile) return;
		// Even off the main thread (see AnnotationWriterClient), a save still
		// takes real wall-clock time — starting one exactly while the user has
		// a pen down would mean the stroke they're mid-way through can't
		// commit until it comes back, which reads as the same kind of "won't
		// let me write" stall this whole worker move was meant to fix. Defer
		// to the next check instead of forcing it mid-gesture; the retry is
		// cheap and short-lived since gestures normally last well under a
		// second.
		if (this.controller.isGestureActive()) {
			if (this.gestureFlushHandle !== null) window.clearTimeout(this.gestureFlushHandle);
			this.gestureFlushHandle = window.setTimeout(() => {
				this.gestureFlushHandle = null;
				this.flushCurrentFileIfAny();
			}, 250);
			return;
		}
		void this.flushAnnotations(this.currentFile);
	}

	// `file` is passed explicitly rather than read from `this.file` /
	// `this.currentFile` internally — callers mid-transition (onLoadFile in
	// particular) need this flush to target the file that's on its way
	// *out*, which may already differ from whichever of those two the
	// caller has moved on to by the time this runs.
	private async flushAnnotationsIfDirty(file: TFile | null): Promise<void> {
		if (this.writeDebounceHandle !== null) {
			window.clearTimeout(this.writeDebounceHandle);
			this.writeDebounceHandle = null;
		}
		if (this.maxWaitHandle !== null) {
			window.clearTimeout(this.maxWaitHandle);
			this.maxWaitHandle = null;
		}
		if (this.gestureFlushHandle !== null) {
			window.clearTimeout(this.gestureFlushHandle);
			this.gestureFlushHandle = null;
		}
		// A save still in flight counts even with nothing new behind it: the
		// callers go on to read the file or terminate the writer.
		if (file && (this.dirtyPages.size > 0 || this.saving)) await this.flushAnnotations(file);
		// A save that found the file changed by another device leaves its ink
		// dirty while that change is taken in (see saveDirtyPages). Waited
		// for, and the ink then saved on top of it: every caller goes on to
		// read the file, reload it or tear the view down, and each of those
		// would lose it. Never called from inside a pull (takeInRemote saves
		// directly), so this cannot wait on itself.
		for (let round = 0; file && round < 3 && this.pulling; round++) {
			await this.pulling.catch(() => undefined);
			if (this.dirtyPages.size > 0 || this.saving) await this.flushAnnotations(file);
		}
	}

	// One save at a time. Each save is built against what the writer believes
	// is on disk and advances that belief only once its write has landed, so a
	// second save started while the first is in flight is built on a base that
	// is about to be wrong: an append at a stale offset, a commit that folds
	// the wrong bytes into the session, or two full rewrites landing in the
	// wrong order with the older one last. On a tablet a large book's save
	// takes seconds, so a stroke drawn straight after another did exactly
	// that. A save asked for mid-flight runs once the current one settles,
	// and however many ask, one follow-up carries everything dirtied meanwhile.
	private flushAnnotations(file: TFile): Promise<void> {
		if (this.writeDebounceHandle !== null) {
			window.clearTimeout(this.writeDebounceHandle);
			this.writeDebounceHandle = null;
		}
		if (this.maxWaitHandle !== null) {
			window.clearTimeout(this.maxWaitHandle);
			this.maxWaitHandle = null;
		}
		if (this.saving) {
			this.saveAgain ??= this.saving.then(() => {
				this.saveAgain = null;
				return this.flushAnnotations(file);
			});
			return this.saveAgain;
		}
		const saving = this.saveDirtyPages(file).finally(() => {
			if (this.saving === saving) this.saving = null;
		});
		this.saving = saving;
		return saving;
	}

	private async saveDirtyPages(file: TFile): Promise<void> {
		if (this.dirtyPages.size === 0 || !this.writer) return;

		const pageNumbers = [...this.dirtyPages];
		this.dirtyPages.clear();

		try {
			// The file changed since this view last knew it — another device's
			// save, landed by a sync. A save now would be built on the file as
			// it was and written over theirs: their pages, their pictures,
			// their ink, gone, and ours put back by page number into a file
			// whose pages no longer have those numbers. That was how a note
			// open on a tablet and a laptop at once could come back with its
			// ink heaped onto the wrong pages. So theirs is taken in first —
			// merged, page by page — and ours saved on top of it.
			if (await this.changedOnDisk(file)) {
				for (const pageNumber of pageNumbers) this.dirtyPages.add(pageNumber);
				void this.pullRemote(file);
				return;
			}

			const pages = pageNumbers.flatMap((pageNumber) => {
				const viewport = this.viewports.get(pageNumber);
				if (!viewport) return [];
				const annotations = this.controller.getPageAnnotations(pageNumber).map((a) => toPdfSpace(a, viewport));
				return [{ pageNumber, annotations }];
			});

			// The actual pdf-lib mutate+save happens off the main thread in
			// annotationWriter.worker.ts — see its comment and this view's
			// `writer` field for why that matters for a densely annotated file.
			const outcome = await this.writer.write(pages);
			if (outcome.mode === 'append') {
				try {
					await this.ownWrite(file, () => appendBinarySafely(this.app.vault, file, outcome.appendix, outcome.baseLength));
				} catch (error) {
					// An append that did not land — most likely because sync
					// moved the file underneath us — must never be retried as
					// an append: the next one would be built on a base that is
					// not what is on disk, and would land at the wrong offset
					// entirely. The session gives the fast path up and the
					// work stays dirty for a full rewrite to carry.
					await this.writer.abandon(String(error));
					throw error;
				}
			} else {
				await this.ownWrite(file, () => writeBinarySafely(this.app.vault, file, outcome.bytes));
			}
			// Only now may the writer advance its idea of what is on disk.
			await this.writer.commit();
			// And only now is this what the file holds — the base the next
			// change from another device is merged against.
			for (const page of pages) this.savedAnnotations.set(page.pageNumber, page.annotations);
			this.consecutiveWriteFailures = 0;
		} catch (error) {
			console.error('InklingExpanded: failed to save annotations.', error);
			new Notice('InklingExpanded: could not save annotations to this file.');
			// Re-marked dirty first, deliberately: the work stays pending, so
			// if the file later saves — this session or the next — nothing has
			// been thrown away.
			for (const pageNumber of pageNumbers) this.dirtyPages.add(pageNumber);

			this.consecutiveWriteFailures += 1;
			if (this.consecutiveWriteFailures >= 2 && !this.controller.isReadOnly()) {
				// A systematic problem — a document pdf-lib cannot round-trip
				// that the open gate did not catch — would otherwise produce
				// a notice every interval for as long as the book is open.
				this.controller.setReadOnly(true);
				this.showReadOnlyBanner('saving to it keeps failing');
				new Notice("InklingExpanded: this PDF isn't saving, so editing has been turned off. Your ink from this session is still on screen.");
			}
		}
	}

	private async addPage(): Promise<void> {
		// An infinite canvas is one page by definition: a second would end it
		// being one — it would never grow again. The toolbar hides the button
		// there; this is for any other way of asking.
		if (this.infiniteBox) {
			new Notice('InklingExpanded: an infinite canvas grows by itself and cannot have more pages.');
			return;
		}
		await this.rebuild('add-page', 'could not add a page to this PDF.', async (bytes) => {
			const pdfDoc = await PDFDocument.load(bytes);
			// currentPageNumber is 1-based; as a 0-based insertion index that
			// is exactly "right after the page the user is currently on".
			const insertIndex = Math.min(this.currentPageNumber, pdfDoc.getPageCount());
			// A note this plugin made gets a page of its paper size and ruling.
			// Any other PDF gets a blank page the size of the one on screen, so
			// a page added to a book or a handout fits in with its own.
			if (parseTemplateStyleFromKeywords(pdfDoc.getKeywords()) !== null) {
				const newPage = pdfDoc.insertPage(insertIndex, pageSizeFor(this.getSettings().pageSize));
				applyTemplateStyle(newPage, readTemplateStyle(pdfDoc));
			} else {
				pdfDoc.insertPage(insertIndex, shownPageSize(pdfDoc.getPage(Math.max(insertIndex - 1, 0))));
			}
			return { bytes: toArrayBuffer(await pdfDoc.save()), scrollTo: insertIndex + 1 };
		});
	}

	// ---- Rebuilding the file ----
	//
	// Adding a page, inserting another PDF's pages and changing a background
	// all rewrite the whole file with pdf-lib, then reload the view from it.
	// Each used to do that on its own, with nothing stopping the rest of the
	// view meanwhile — and a stroke drawn while the file was being rebuilt
	// was saved by the writer that still knew the file as it had been, over
	// the rebuilt one or at an offset in it that no longer meant anything.
	// That is how a note could come back with its pages gone and its ink
	// heaped onto the wrong one.
	//
	// So a rebuild is one step, and nothing else touches the file during it:
	//   - drawing is paused (read-only) from the first moment to the reload;
	//   - unsaved ink is saved first, and if it cannot be, nothing is rebuilt;
	//   - the save slot is held, so no save, growth or change from another
	//     device lands in between the read and the write;
	//   - the file as it was is kept as a backup (see backups.ts), so even a
	//     rebuild gone wrong costs nothing that "Restore an earlier version of
	//     this PDF" cannot bring back.
	private async rebuild(
		reason: BackupReason,
		failure: string,
		change: (bytes: ArrayBuffer) => Promise<{ bytes: ArrayBuffer; scrollTo: number; notice?: string } | null>,
	): Promise<boolean> {
		const file = this.currentFile;
		if (!file || this.addingPage || this.growing || this.controller.isReadOnly()) return false;
		this.addingPage = true;
		const token = this.renderToken;
		this.controller.setReadOnly(true);
		let reloading = false;
		try {
			await this.flushAnnotationsIfDirty(file);
			// Another device's change not taken in yet: taken in first, so the
			// rebuild is of the note as it now is everywhere. If that reloads
			// the view — pages added or deleted there — the page numbers this
			// rebuild was asked with mean other pages now, and it stops.
			if (this.dirtyPages.size > 0 || (await this.changedOnDisk(file))) {
				await this.pullRemote(file, true);
				if (token !== this.renderToken) return false;
				await this.flushAnnotationsIfDirty(file);
			}
			while (this.saving) await this.saving.catch(() => undefined);
			if (token !== this.renderToken || file !== this.currentFile) return false;
			// A save that failed leaves its pages dirty, and the reload below
			// would lose them.
			if (this.dirtyPages.size > 0) throw new Error('the ink on this note could not be saved first');

			let release: () => void = () => undefined;
			this.saving = new Promise<void>((resolve) => (release = resolve));
			const slot = this.saving;
			let result: { bytes: ArrayBuffer; scrollTo: number; notice?: string } | null;
			try {
				const before = await this.app.vault.readBinary(file);
				result = await change(before);
				if (!result) return false;
				await backUp(this.app, file, before, reason);
				const rebuilt = result.bytes;
				await this.ownWrite(file, () => writeBinarySafely(this.app.vault, file, rebuilt));
			} finally {
				release();
				if (this.saving === slot) this.saving = null;
			}

			reloading = true;
			await this.onLoadFile(file);
			this.scrollToPage(result.scrollTo);
			void refreshCoreReaders(this.app, file);
			if (result.notice) new Notice(result.notice);
			return true;
		} catch (error) {
			console.error(`InklingExpanded: ${failure}`, error);
			new Notice(`InklingExpanded: ${failure}`);
			return false;
		} finally {
			this.addingPage = false;
			// A reload decides for itself whether the file can be written.
			if (!reloading && token === this.renderToken) this.controller.setReadOnly(false);
		}
	}

	// ---- View zoom ----

	private viewAnchorAt(at: Point): ViewAnchorPoint {
		// The page under the point, or failing that the nearest one above or
		// below it — a pinch can start in the gap between two pages.
		let best: { page: HTMLElement; rect: DOMRect } | null = null;
		let bestDistance = Infinity;
		for (const page of Array.from(this.contentEl.querySelectorAll<HTMLElement>('.inkling-pdf-page-placeholder'))) {
			const rect = page.getBoundingClientRect();
			const distance = at.y < rect.top ? rect.top - at.y : at.y > rect.bottom ? at.y - rect.bottom : 0;
			if (distance < bestDistance) {
				best = { page, rect };
				bestDistance = distance;
			}
			if (distance === 0) break;
		}
		if (!best || best.rect.width === 0 || best.rect.height === 0) return { page: null, fx: 0, fy: 0 };
		return { page: best.page, fx: (at.x - best.rect.left) / best.rect.width, fy: (at.y - best.rect.top) / best.rect.height };
	}

	private zoomViewTo(scale: number, anchor: ViewAnchorPoint, at: Point): void {
		const next = Math.min(Math.max(scale, VIEW_MIN_ZOOM), VIEW_MAX_ZOOM);
		if (next !== this.viewZoomLevel) {
			this.viewZoomLevel = next;
			this.contentEl.setCssProps({ '--inkling-view-zoom': String(next) });
			// The toolbar's readout, kept current through the whole gesture.
			this.controller.refreshUi();
		}
		// Measured after the change, which lays the pages out at their new
		// size, so the scroll lands the anchor exactly under the point.
		if (!anchor.page?.isConnected) return;
		const rect = anchor.page.getBoundingClientRect();
		this.contentEl.scrollLeft += rect.left + anchor.fx * rect.width - at.x;
		this.contentEl.scrollTop += rect.top + anchor.fy * rect.height - at.y;
	}

	private viewCentre(): Point {
		const rect = this.contentEl.getBoundingClientRect();
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
	}

	// Every page on screen re-rendered for the zoom it is now shown at:
	// sharper zoomed in, smaller zoomed back out.
	private settleViewZoom(): void {
		for (const pageNumber of this.renderedPages) void this.upgradeResolution(pageNumber, this.viewZoomLevel);
		this.scheduleDetails();
	}

	// ---- Detail layer ----
	//
	// A page is one canvas, and a canvas has a ceiling: MAX_RENDER_SCALE, and
	// MAX_CANVAS_PIXELS, past which Safari on an iPhone or iPad leaves it
	// blank. A Letter page at 500% on a tablet would need well over a hundred
	// megapixels, so zoomed in that far the page's canvas is stretched, and
	// the text and the ink on it break up into visible pixels.
	//
	// The detail layer is what Obsidian's own reader (pdf.js) does about the
	// same thing: just the part of the page on screen, drawn again at the
	// screen's own resolution, over the stretched page. Only ever about a
	// screenful of pixels, so it fits on every device at any zoom. Three
	// canvases — the page, its ink, and the stroke being drawn — so that
	// drawing stays as cheap as it is on the page's own layers: a pen moving
	// repaints only the stroke, not every stroke on the page. The stretched
	// ink and live layers underneath are hidden where the sharp copies are.

	private scheduleDetails(): void {
		if (this.detailHandle !== null) window.clearTimeout(this.detailHandle);
		this.detailHandle = window.setTimeout(() => {
			this.detailHandle = null;
			this.updateDetails();
		}, DETAIL_DELAY_MS);
	}

	private updateDetails(): void {
		for (const pageNumber of this.renderedPages) {
			if (this.detailNeeded(pageNumber)) void this.renderDetail(pageNumber);
			else this.removeDetail(pageNumber);
		}
		for (const pageNumber of [...this.details.keys()]) {
			if (!this.renderedPages.has(pageNumber)) this.removeDetail(pageNumber);
		}
	}

	// Whether the page's canvas falls short of the screen at this zoom.
	private detailNeeded(pageNumber: number): boolean {
		const rendered = this.renderedScales.get(pageNumber);
		const ideal = this.inkBaseScales.get(pageNumber) ?? this.baseScales.get(pageNumber);
		if (!rendered || !ideal) return false;
		return ideal * this.viewZoomLevel > rendered * DETAIL_THRESHOLD;
	}

	private async renderDetail(pageNumber: number): Promise<void> {
		const pdf = this.pdf;
		const placeholder = this.contentEl.querySelector<HTMLElement>(`.inkling-pdf-page-placeholder[data-page-number="${pageNumber}"]`);
		const viewport = this.viewports.get(pageNumber);
		if (!pdf || !placeholder || !viewport) return;

		const page = placeholder.getBoundingClientRect();
		const view = this.contentEl.getBoundingClientRect();
		const marginX = view.width * DETAIL_MARGIN;
		const marginY = view.height * DETAIL_MARGIN;
		const left = Math.max(page.left, view.left - marginX);
		const right = Math.min(page.right, view.right + marginX);
		const top = Math.max(page.top, view.top - marginY);
		const bottom = Math.min(page.bottom, view.bottom + marginY);
		if (right <= left || bottom <= top || page.width === 0 || page.height === 0) {
			this.removeDetail(pageNumber);
			return;
		}

		// The screen's own density, unless a very large screen would take the
		// region past what one canvas may hold.
		const dpr = window.devicePixelRatio || 1;
		const pixels = (right - left) * dpr * (bottom - top) * dpr;
		const density = pixels > MAX_CANVAS_PIXELS ? dpr * Math.sqrt(MAX_CANVAS_PIXELS / pixels) : dpr;

		const detail = this.details.get(pageNumber) ?? this.createDetail(pageNumber);
		detail.task?.cancel();
		const generation = ++this.detailGeneration;
		detail.generation = generation;
		const token = this.renderToken;

		const canvas = createEl('canvas', { cls: 'inkling-detail-layer inkling-pdf-detail' });
		canvas.width = Math.ceil((right - left) * density);
		canvas.height = Math.ceil((bottom - top) * density);
		const pageWidth = page.width * density;
		const offsetX = (left - page.left) * density;
		const offsetY = (top - page.top) * density;
		try {
			const pdfPage = await pdf.getPage(pageNumber);
			if (detail.generation !== generation || token !== this.renderToken) return;
			const pointWidth = viewport.width / viewport.scale;
			const task = pdfPage.render({
				canvas,
				viewport: pdfPage.getViewport({ scale: pageWidth / pointWidth }),
				// Just the region: everything else lands off the canvas.
				transform: [1, 0, 0, 1, -offsetX, -offsetY],
				annotationMode: AnnotationMode.ENABLE,
			});
			detail.task = task;
			await task.promise;
		} catch (error) {
			if (!(error instanceof RenderingCancelledException)) console.error(`InklingExpanded: failed to draw page ${pageNumber} sharp.`, error);
			return;
		}
		if (detail.generation !== generation || token !== this.renderToken || this.details.get(pageNumber) !== detail) return;

		// Everything below swaps in together, so the sharp page, the sharp
		// ink and the hole cut in the stretched ink always agree.
		detail.task = null;
		Object.assign(detail, {
			left: (left - page.left) / page.width,
			top: (top - page.top) / page.height,
			right: (right - page.left) / page.width,
			bottom: (bottom - page.top) / page.height,
			pageWidth,
			offsetX,
			offsetY,
		});
		const content = placeholder.querySelector<HTMLElement>('.inkling-page-content');
		const pageCanvas = this.pageCanvases.get(pageNumber);
		const base = content?.querySelector<HTMLCanvasElement>('.inkling-annotation-base');
		const overlay = content?.querySelector<HTMLCanvasElement>('.inkling-annotation-overlay');
		if (!content || !pageCanvas || !base || !overlay) return;

		if (detail.pdf) detail.pdf.replaceWith(canvas);
		else pageCanvas.after(canvas);
		detail.pdf = canvas;
		// Under the ink, as the page's own highlight layer is, and over the
		// sharp page it multiplies into.
		if (!detail.highlight) {
			detail.highlight = createEl('canvas', { cls: 'inkling-detail-layer inkling-highlight-detail' });
			detail.highlight.setCssProps({ '--inkling-highlight-opacity': String(HIGHLIGHTER_OPACITY) });
		}
		if (!detail.highlight.isConnected) base.before(detail.highlight);
		detail.ink ??= createEl('canvas', { cls: 'inkling-detail-layer inkling-ink-detail' });
		if (!detail.ink.isConnected) base.after(detail.ink);
		detail.overlay ??= createEl('canvas', { cls: 'inkling-detail-layer inkling-overlay-detail' });
		if (!detail.overlay.isConnected) overlay.after(detail.overlay);
		for (const layer of [detail.highlight, detail.ink, detail.overlay]) {
			layer.width = canvas.width;
			layer.height = canvas.height;
		}

		const place = this.detailPlace(detail);
		for (const layer of [detail.pdf, detail.highlight, detail.ink, detail.overlay]) layer.setCssProps(place);
		base.setCssProps(place);
		base.addClass('has-detail-hole');
		overlay.addClass('is-detailed');
		this.paintDetail(pageNumber, 'ink');
		this.paintDetail(pageNumber, 'overlay');
	}

	// Where a page's sharp region is, as fractions of the page.
	private detailPlace(detail: PageDetail): Record<string, string> {
		return {
			'--inkling-detail-left': `${detail.left * 100}%`,
			'--inkling-detail-top': `${detail.top * 100}%`,
			'--inkling-detail-right': `${detail.right * 100}%`,
			'--inkling-detail-bottom': `${detail.bottom * 100}%`,
		};
	}

	private createDetail(pageNumber: number): PageDetail {
		const detail: PageDetail = {
			left: 0,
			top: 0,
			right: 0,
			bottom: 0,
			pageWidth: 0,
			offsetX: 0,
			offsetY: 0,
			pdf: null,
			highlight: null,
			ink: null,
			overlay: null,
			highlightDrafting: false,
			task: null,
			generation: 0,
			inkFrame: null,
			overlayFrame: null,
		};
		this.details.set(pageNumber, detail);
		return detail;
	}

	private removeDetail(pageNumber: number): void {
		const detail = this.details.get(pageNumber);
		if (!detail) return;
		this.details.delete(pageNumber);
		detail.task?.cancel();
		if (detail.inkFrame !== null) window.cancelAnimationFrame(detail.inkFrame);
		if (detail.overlayFrame !== null) window.cancelAnimationFrame(detail.overlayFrame);
		const content = detail.pdf?.parentElement;
		detail.pdf?.remove();
		detail.highlight?.remove();
		detail.ink?.remove();
		detail.overlay?.remove();
		content?.querySelector('.inkling-annotation-base')?.removeClass('has-detail-hole');
		content?.querySelector('.inkling-annotation-highlight')?.removeClass('has-detail-hole');
		content?.querySelector('.inkling-annotation-overlay')?.removeClass('is-detailed');
	}

	// The page's ink or live layer changed: the sharp copy follows, once a
	// frame at most, however many samples a fast pen delivers in one.
	private repaintDetail(pageNumber: number, layer: 'ink' | 'overlay'): void {
		const detail = this.details.get(pageNumber);
		if (!detail?.pdf) return;
		const frame = layer === 'ink' ? 'inkFrame' : 'overlayFrame';
		if (detail[frame] !== null) return;
		detail[frame] = window.requestAnimationFrame(() => {
			detail[frame] = null;
			if (this.details.get(pageNumber) === detail) this.paintDetail(pageNumber, layer);
		});
	}

	// The ink layer brings the highlights with it: a highlight committed is
	// a change to both. The live layer brings them while one is being drawn,
	// and once more as it ends — the overlay never carries a highlighter's
	// stroke (see redrawHighlightDraft in the controller).
	private paintDetail(pageNumber: number, layer: 'ink' | 'overlay'): void {
		const detail = this.details.get(pageNumber);
		if (!detail) return;
		if (layer === 'ink') {
			this.paintDetailLayer(pageNumber, detail, detail.ink, (ctx) => this.controller.drawInkTo(pageNumber, ctx));
			this.paintDetailHighlights(pageNumber, detail);
			return;
		}
		this.paintDetailLayer(pageNumber, detail, detail.overlay, (ctx) => this.controller.drawOverlayTo(pageNumber, ctx));
		const drafting = this.controller.hasHighlightDraft(pageNumber);
		if (drafting || detail.highlightDrafting) this.paintDetailHighlights(pageNumber, detail);
		detail.highlightDrafting = drafting;
	}

	private paintDetailHighlights(pageNumber: number, detail: PageDetail): void {
		// The page's highlight layer is made on the first highlight, which can
		// be after this region was: the hole cut in the stretched copy, so the
		// sharp copy is not multiplied in twice, is made here as well.
		// Placed every time: the region moves as the page scrolls.
		const stretched = detail.pdf?.parentElement?.querySelector<HTMLElement>('.inkling-annotation-highlight');
		if (stretched) {
			stretched.setCssProps(this.detailPlace(detail));
			stretched.classList.add('has-detail-hole');
		}
		this.paintDetailLayer(pageNumber, detail, detail.highlight, (ctx) => this.controller.drawHighlightsTo(pageNumber, ctx));
	}

	private paintDetailLayer(
		pageNumber: number,
		detail: PageDetail,
		canvas: HTMLCanvasElement | null,
		draw: (ctx: CanvasRenderingContext2D) => void,
	): void {
		const viewport = this.viewports.get(pageNumber);
		const ctx = canvas?.getContext('2d');
		if (!canvas || !viewport || !ctx) return;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		// The page's canvas space onto this region of the sharp copy. Worked
		// out from the page's canvas as it is now rather than as it was when
		// the region was drawn, since sharpening the page re-backs it.
		const scale = detail.pageWidth / viewport.width;
		ctx.setTransform(scale, 0, 0, scale, -detail.offsetX, -detail.offsetY);
		draw(ctx);
	}

	// ---- Infinite canvas ----
	//
	// A canvas grows when ink comes near one of its edges, or when the reader
	// scrolls up against an edge with ink near it — which is how you make
	// room before writing somewhere new. Never on its own: a canvas with no
	// ink near an edge stays the size it is however much it is scrolled, so
	// panning around cannot leave it ballooning with empty space.
	//
	// Growing never reloads the view. The file is rewritten with the new box
	// and a fresh writer opened on it (see writeGrownBox) — the old one holds
	// its own parsed copy of the document and verifies every save against
	// it, so it cannot simply be told the file changed. Then the grown page
	// is rendered out of sight and swapped in for the old one in a single
	// frame (see showGrownPage). Writing carries on throughout.

	private scheduleGrowthFromInk(): void {
		if (this.growAfterInkHandle !== null) window.clearTimeout(this.growAfterInkHandle);
		this.growAfterInkHandle = window.setTimeout(() => {
			this.growAfterInkHandle = null;
			const box = this.infiniteBox;
			if (!box) return;
			void this.growInfiniteCanvas(edgesNear(box, this.inkBounds(), EDGE_ZONE));
		}, GROW_AFTER_INK_MS);
	}

	private onScrollForGrowth(): void {
		if (!this.infiniteBox || performance.now() < this.scrollGrowthArmedAt) return;
		this.scrollGestureStart ??= { left: this.contentEl.scrollLeft, top: this.contentEl.scrollTop };
		if (this.growAfterScrollHandle !== null) window.clearTimeout(this.growAfterScrollHandle);
		this.growAfterScrollHandle = window.setTimeout(() => {
			this.growAfterScrollHandle = null;
			const start = this.scrollGestureStart;
			this.scrollGestureStart = null;
			if (start) void this.growInfiniteCanvas(this.edgesScrolledInto(start));
		}, GROW_AFTER_SCROLL_MS);
	}

	// The edges the reader has just scrolled up against: moved towards, and
	// now on screen. Only those with ink within a step of them, so the room
	// made is room next to something rather than room next to more room.
	private edgesScrolledInto(start: { left: number; top: number }): Edge[] {
		const box = this.infiniteBox;
		const placeholder = this.contentEl.querySelector<HTMLElement>('.inkling-pdf-page-placeholder');
		if (!box || !placeholder) return [];
		const page = placeholder.getBoundingClientRect();
		const view = this.contentEl.getBoundingClientRect();
		const dx = this.contentEl.scrollLeft - start.left;
		const dy = this.contentEl.scrollTop - start.top;

		const reached: Edge[] = [];
		if (dx < 0 && page.left >= view.left - 1) reached.push('left');
		if (dx > 0 && page.right <= view.right + 1) reached.push('right');
		if (dy < 0 && page.top >= view.top - 1) reached.push('top');
		if (dy > 0 && page.bottom <= view.bottom + 1) reached.push('bottom');
		if (reached.length === 0) return [];

		const ink = this.inkBounds();
		const near = [
			...edgesNear(box, ink, GROW_STEP_X).filter((edge) => edge === 'left' || edge === 'right'),
			...edgesNear(box, ink, GROW_STEP_Y).filter((edge) => edge === 'top' || edge === 'bottom'),
		];
		return reached.filter((edge) => near.includes(edge));
	}

	// Everything on the canvas, as one box in PDF space.
	private inkBounds(): PdfBox | null {
		const viewport = this.viewports.get(1);
		if (!viewport) return null;
		const points: Point[] = [];
		for (const annotation of this.controller.getPageAnnotations(1).map((a) => toPdfSpace(a, viewport))) {
			// The pen's half-width beyond its centreline, so a thick stroke
			// along an edge counts as reaching it.
			const reach = annotation.width / 2;
			const centres =
				annotation.kind === 'stroke'
					? annotation.points
					: annotation.kind === 'note'
						? [annotation.at]
						: [annotation.start, annotation.end];
			for (const { x, y } of centres) {
				points.push({ x: x - reach, y: y - reach }, { x: x + reach, y: y + reach });
			}
		}
		return boundsOf(points);
	}

	private cancelGrowthChecks(): void {
		if (this.growAfterInkHandle !== null) window.clearTimeout(this.growAfterInkHandle);
		if (this.growAfterScrollHandle !== null) window.clearTimeout(this.growAfterScrollHandle);
		this.growAfterInkHandle = null;
		this.growAfterScrollHandle = null;
		this.scrollGestureStart = null;
	}

	private async growInfiniteCanvas(edges: Edge[]): Promise<void> {
		const file = this.currentFile;
		const box = this.infiniteBox;
		if (edges.length === 0 || !file || !box || !this.writer || !this.pdf) return;
		if (this.growing || this.addingPage || this.controller.isReadOnly()) return;

		const growth = growBox(box, edges);
		if (!growth) {
			if (!this.reportedCanvasLimit) {
				this.reportedCanvasLimit = true;
				new Notice('InklingExpanded: this canvas has reached the largest size a PDF page can be.');
			}
			return;
		}

		this.growing = true;
		const token = this.renderToken;
		// Whether the file grew but the screen did not catch up with it.
		let unshown = false;
		try {
			const opened = await this.writeGrownBox(file, growth.box, token);
			if (!opened || token !== this.renderToken) return;
			try {
				await this.showGrownPage(opened, growth, token);
			} catch (error) {
				unshown = true;
				throw error;
			}
		} catch (error) {
			console.error('InklingExpanded: failed to grow the canvas.', error);
			if (!unshown) new Notice('InklingExpanded: could not make this canvas larger.');
		} finally {
			this.growing = false;
		}
		// The file and its writer have the grown page, the screen the old
		// one: ink still saves right (a growth leaves PDF space alone), but
		// the page shown is not the page there is. Reloaded, they agree again.
		if (unshown && token === this.renderToken && file === this.currentFile) {
			await this.onLoadFile(file);
			return;
		}
		// Ink drawn while the page was growing can have reached the new edge
		// already.
		if (token === this.renderToken) this.scheduleGrowthFromInk();
	}

	// The file half of a growth: the new box written into the PDF, and a
	// writer opened on the result in place of the old one, whose parsed copy
	// of the document no longer matches what is on disk.
	//
	// Takes the save slot for as long as that lasts. A save already in flight
	// finishes first, and one asked for meanwhile waits behind this — so no
	// save is ever built against the document as it was before the box
	// changed, and none is lost either: ink drawn during it is still dirty,
	// and goes to the new writer.
	//
	// Nothing on screen changes here. Ink is converted to PDF space through
	// the page's viewport when it is saved, and PDF space is the one thing a
	// growth leaves alone, so the old viewport keeps saving correctly until
	// the grown page is shown.
	private async writeGrownBox(file: TFile, box: PdfBox, token: number): Promise<OpenResult | null> {
		while (this.saving) await this.saving.catch(() => undefined);
		if (token !== this.renderToken) return null;

		let release: () => void = () => undefined;
		this.saving = new Promise<void>((resolve) => (release = resolve));
		const slot = this.saving;
		try {
			// Another device's change first: a growth written over it would
			// keep its ink in the file but never show it here, and the next
			// save of this page would then drop it.
			if (await this.changedOnDisk(file)) {
				void this.pullRemote(file);
				return null;
			}
			const original = await this.app.vault.readBinary(file);
			const pdfDoc = await PDFDocument.load(original);
			setInfiniteCanvasBox(pdfDoc.getPage(0), box);
			const grown = toArrayBuffer(await pdfDoc.save());
			await this.ownWrite(file, () => writeBinarySafely(this.app.vault, file, grown));

			const writer = new AnnotationWriterClient();
			let opened: OpenResult;
			try {
				// A copy: open() hands its buffer to the worker.
				opened = await writer.open(grown.slice(0));
			} catch (error) {
				writer.terminate();
				// The old writer is still the one in charge, and it believes
				// the file is what it was. Making that true again is what keeps
				// its next save from undoing the growth or landing at an offset
				// that is no longer the end of the file.
				await this.ownWrite(file, () => writeBinarySafely(this.app.vault, file, original));
				throw error;
			}
			if (token !== this.renderToken) {
				writer.terminate();
				return null;
			}

			this.writer?.terminate();
			this.writer = writer;
			this.pageIds = opened.pageIds ?? this.pageIds;
			this.infiniteBox = box;
			this.maxWriteInterval = maxWriteIntervalMs(
				this.getSettings().saveCadence === 'frequent' ? 0 : grown.byteLength,
				opened.incremental && canAppendBinary(this.app.vault),
			);
			return opened;
		} finally {
			release();
			if (this.saving === slot) this.saving = null;
		}
	}

	// The screen half: the grown page rendered out of sight, then swapped in
	// for the old one in a single frame — canvas, annotation layers and
	// scroll position together — so the page simply has more room around it
	// and nothing visibly reloads. The stroke being drawn finishes first.
	private async showGrownPage(opened: OpenResult, growth: Growth, token: number): Promise<void> {
		const pdf = await withTimeout(
			getDocument({ data: opened.displayBytes, isEvalSupported: false }).promise,
			PDF_LOAD_TIMEOUT_MS,
			'InklingExpanded: timed out opening this PDF.',
		);
		let swapped = false;
		try {
			const page = await pdf.getPage(1);
			let refusal: string | null = opened.risky.length > 0 ? `it contains ${opened.risky.join(' and ')}` : null;
			refusal ??= compareProfiles(opened.profile, await profileFromPdfJs(pdf));
			if (token !== this.renderToken) return;

			const points = page.getViewport({ scale: 1 });
			const layoutScale = this.layoutScaleFor(1, INFINITE_BASE_WIDTH);
			const layoutViewport = page.getViewport({ scale: layoutScale });
			const ideal = baseRenderScale(layoutViewport.width, points.width, window.devicePixelRatio || 1);
			const base = capToPixelBudget(ideal, points.width, points.height);
			const scale = capToPixelBudget(zoomedRenderScale(base, this.viewZoomLevel), points.width, points.height);
			const viewport = page.getViewport({ scale });

			const canvas = createEl('canvas', { cls: 'inkling-pdf-page' });
			canvas.width = viewport.width;
			canvas.height = viewport.height;
			await page.render({ canvas, viewport, annotationMode: AnnotationMode.ENABLE }).promise;

			await this.untilPageIsIdle(1, token);
			if (token !== this.renderToken) return;

			const placeholder = this.contentEl.querySelector<HTMLElement>('.inkling-pdf-page-placeholder[data-page-number="1"]');
			const oldCanvas = this.pageCanvases.get(1);
			const oldViewport = this.viewports.get(1);
			if (!placeholder || !oldCanvas || !oldViewport || !oldCanvas.parentElement) {
				throw new Error('the page is not on screen to be swapped');
			}

			// From here to the end of the block is one synchronous run, so the
			// browser paints either the old page or the new one, never a mix.
			this.closeNoteEditor();
			// Placed by fractions of the old page, which the new one is not.
			this.removeDetail(1);
			const reproject = (annotation: Annotation) => toCanvasSpace(toPdfSpace(annotation, oldViewport), viewport);
			const annotations = this.controller.getPageAnnotations(1).map(reproject);
			this.history.restore(this.history.snapshot(), (entry) =>
				entry.pageNumber === 1 ? { ...entry, before: entry.before.map(reproject), after: entry.after.map(reproject) } : entry,
			);

			sizePlaceholder(placeholder, layoutViewport.width, layoutViewport.height);
			oldCanvas.replaceWith(canvas);
			this.controller.resizePage(1, viewport.width, viewport.height, annotations);
			this.viewports.set(1, viewport);
			this.pageCanvases.set(1, canvas);
			this.renderedScales.set(1, scale);
			this.baseScales.set(1, base);
			this.inkBaseScales.set(1, ideal);
			// Growing left or up puts new canvas in front of what was on
			// screen; scrolling on by the same amount keeps it there. Not the
			// reader moving towards an edge, so not a reason to grow again.
			this.scrollGrowthArmedAt = performance.now() + SCROLL_GROWTH_SETTLE_MS;
			this.contentEl.scrollLeft += growth.addedLeft * layoutScale * this.viewZoomLevel;
			this.contentEl.scrollTop += growth.addedTop * layoutScale * this.viewZoomLevel;

			const previous = this.pdf;
			this.pdf = pdf;
			swapped = true;
			void previous?.destroy();
			this.textLines.delete(1);
			computeTextLines(page, viewport)
				.then((lines) => {
					if (token === this.renderToken) this.textLines.set(1, lines);
				})
				.catch((error: unknown) => console.error('InklingExpanded: failed to read text content for the canvas.', error));

			if (refusal) {
				this.controller.setReadOnly(true);
				this.showReadOnlyBanner(refusal);
			}
			this.controller.refreshUi();
			this.scheduleDetails();
			const grownFile = this.currentFile;
			if (grownFile) void refreshCoreReaders(this.app, grownFile);
		} finally {
			if (!swapped) void pdf.destroy();
		}
	}

	// Resolves once nothing is happening on the page that swapping it would
	// break: no stroke or drag in progress, no pinch-zoom (whose transform is
	// in the old page's pixels), and no sharpening render still writing into
	// the old canvas. Or once the view has moved on to something else.
	private async untilPageIsIdle(pageNumber: number, token: number): Promise<void> {
		while (
			token === this.renderToken &&
			(this.controller.isGestureActive() || this.controller.getPageZoom(pageNumber) !== 1 || this.upgradingPages.has(pageNumber))
		) {
			await new Promise((resolve) => window.setTimeout(resolve, GROW_IDLE_POLL_MS));
		}
	}

	// ---- Another device ----
	//
	// Two devices with the same PDF open, both writing on it, each saving to
	// the file and each file arriving at the other by sync. This view used to
	// read the file once, when it opened, and then write over whatever was
	// there — so whichever device saved last silently undid the other's ink.
	//
	// Now a change on disk that this view did not make is read and merged
	// into what is on screen as it lands, stroke by stroke, the same three-way
	// way an ink block merges (see mergeAnnotations): the other device's new
	// strokes appear, ours that are not saved yet stay, and a stroke erased
	// on either side is gone. Then this view writes on from the merged file,
	// with a writer opened on it, so its next save is built on the other
	// device's rather than over it.
	//
	// It is as live as the sync that carries the file: there is no
	// connection between the devices but the file, which is all a plugin
	// that makes no network calls has.

	private async ownWrite(file: TFile, write: () => Promise<void>): Promise<void> {
		this.ownWrites++;
		try {
			await write();
		} finally {
			this.ownWrites--;
			await this.rememberDisk(file);
		}
	}

	private async rememberDisk(file: TFile): Promise<void> {
		try {
			const stat = await this.app.vault.adapter.stat(file.path);
			if (stat) this.knownDisk = { path: file.path, size: stat.size, mtime: stat.mtime };
		} catch {
			// Unknown, then: the next change is checked against the file itself.
		}
	}

	// Whether the file on disk is no longer the one this view last wrote or
	// read. Unknown — nothing remembered, or a file since renamed — is not a
	// change.
	private async changedOnDisk(file: TFile): Promise<boolean> {
		const known = this.knownDisk;
		if (!known || known.path !== file.path) return false;
		try {
			const stat = await this.app.vault.adapter.stat(file.path);
			return !!stat && (stat.size !== known.size || stat.mtime !== known.mtime);
		} catch {
			return false;
		}
	}

	private isOwnVersion(file: TFile): boolean {
		const known = this.knownDisk;
		return !!known && known.path === file.path && known.size === file.stat.size && known.mtime === file.stat.mtime;
	}

	private onFileChanged(file: TFile): void {
		if (this.restoring || this.ownWrites > 0 || this.isOwnVersion(file)) return;
		if (this.remoteHandle !== null) window.clearTimeout(this.remoteHandle);
		this.remoteHandle = window.setTimeout(() => {
			this.remoteHandle = null;
			void this.pullRemote(file);
		}, REMOTE_SETTLE_MS);
	}

	// ---- Restoring an earlier version ----
	//
	// For backups.ts. A restore replaces the file on purpose, and is not a
	// change from another device: merged as one, ink saved here since the
	// backup would have stayed on screen — and been saved straight back over
	// the restored file. So: what is drawn and not saved goes into the file
	// first, and so into the backup of it as it is now; then drawing pauses
	// and changes to the file are let be until the view has reloaded from
	// what was restored.

	async prepareForRestore(): Promise<void> {
		await this.flushAnnotationsIfDirty(this.currentFile);
		this.restoring = true;
		if (this.remoteHandle !== null) window.clearTimeout(this.remoteHandle);
		this.remoteHandle = null;
		this.controller.setReadOnly(true);
	}

	// Called whether the restore worked or not: either way, what is on disk
	// is what is shown from here.
	async finishRestore(file: TFile): Promise<void> {
		if (this.remoteHandle !== null) window.clearTimeout(this.remoteHandle);
		this.remoteHandle = null;
		while (this.pulling) await this.pulling.catch(() => undefined);
		this.dirtyPages.clear();
		if (this.writeDebounceHandle !== null) window.clearTimeout(this.writeDebounceHandle);
		if (this.maxWaitHandle !== null) window.clearTimeout(this.maxWaitHandle);
		this.writeDebounceHandle = null;
		this.maxWaitHandle = null;
		await this.rememberDisk(file);
		this.restoring = false;
		// The reload decides read-only for itself. Another file opened here
		// meanwhile was decided for when it loaded, and is left as it is.
		if (this.currentFile?.path === file.path) await this.onLoadFile(file);
	}

	// Reads another device's save and merges it into this view. One at a
	// time: asked again while one is under way, the one under way answers.
	// `force` is a rebuild's own asking (see rebuild), which may not wait for
	// the rebuild to be over.
	private pullRemote(file: TFile, force = false): Promise<void> {
		if (this.pulling) return this.pulling;
		let run: Promise<void> | null = null;
		run = (async () => {
			const reload = await this.takeInRemote(file, force);
			// Cleared before the reload, which flushes, and whose flush may
			// itself need to take in a change: it must not wait on this.
			if (this.pulling === run) this.pulling = null;
			if (reload && !this.unloading) await this.onLoadFile(file);
		})().finally(() => {
			if (this.pulling === run) this.pulling = null;
		});
		this.pulling = run;
		return run;
	}

	// Holds the save slot throughout, as a growth does (see writeGrownBox):
	// no save of ours may be built against the file as it was before it
	// changed. True when the view has to reload from the merged file.
	//
	// Pages are matched by identity, not number (see pageIdsOf). While both
	// files have the same pages in the same order, theirs are merged into
	// what is on screen as they land. When pages were added or deleted on
	// the other device, a page's number here is not its number there, and
	// neither is its size or the viewport that turns ink into PDF space: the
	// merged ink is then written straight into their file, page by page where
	// each page now is, and the view reloads from it. Before, ink was merged
	// by page number — onto whichever page now had that number.
	private async takeInRemote(file: TFile, force: boolean): Promise<boolean> {
		if (this.restoring) return false;
		// A rebuild or a growth under way reloads or swaps the page itself,
		// and between its steps the view's pages, viewports and writer do not
		// all describe the same file. Asked again once it is done.
		if (!force && (this.addingPage || this.growing)) {
			this.remoteHandle ??= window.setTimeout(() => {
				this.remoteHandle = null;
				void this.pullRemote(file);
			}, REMOTE_SETTLE_MS);
			return false;
		}
		const token = this.renderToken;
		while (this.saving) await this.saving.catch(() => undefined);
		if (token !== this.renderToken || file !== this.currentFile || !this.pdf) return false;
		if (!force && (this.addingPage || this.growing)) {
			this.onFileChanged(file);
			return false;
		}

		let release: () => void = () => undefined;
		this.saving = new Promise<void>((resolve) => (release = resolve));
		const slot = this.saving;
		let reload = false;
		let pausedInput = false;
		// A writer opened on their file and not taken on as this view's: ended
		// on the way out, whichever way out that is — a failure anywhere
		// between used to leave its worker running for good.
		let pendingWriter: AnnotationWriterClient | null = null;
		const unsaved: number[] = [];
		try {
			// Looked at again now that nothing of ours is writing: the change
			// may have been our own after all, reported late.
			const stat = await this.app.vault.adapter.stat(file.path);
			const known = this.knownDisk;
			if (stat && known && known.path === file.path && known.size === stat.size && known.mtime === stat.mtime) return false;

			const bytes = await this.app.vault.readBinary(file);
			const writer = new AnnotationWriterClient();
			pendingWriter = writer;
			let opened: OpenResult;
			try {
				opened = await writer.open(bytes.slice(0));
			} catch (error) {
				writer.terminate();
				// Not readable as it is — most likely a sync still writing it.
				// The next change will bring the rest.
				console.warn('InklingExpanded: could not read this PDF as it arrived from another device.', error);
				return false;
			}
			const pdf = this.pdf;
			if (token !== this.renderToken || !pdf) {
				writer.terminate();
				return false;
			}
			// A page more or fewer, or a page another size — a growth on an
			// infinite canvas, or pages inserted — is more than annotations
			// can say, and takes a reload once the ink is merged and saved.
			const resized = compareProfiles(opened.profile, await profileFromPdfJs(pdf)) !== null;
			// Checked again after every wait: a writer opened on a file the
			// view has since moved on from must never become the one it saves
			// with.
			if (token !== this.renderToken || pdf !== this.pdf) {
				writer.terminate();
				return false;
			}

			const ourIds = this.pageIds;
			const theirIds = opened.pageIds ?? [];
			const identified = ourIds.length > 0 && theirIds.length > 0;
			const moved = identified && (ourIds.length !== theirIds.length || ourIds.some((id, index) => id !== theirIds[index]));
			const theirPageFor = (pageNumber: number): number | null => {
				if (!identified) return pageNumber;
				const index = theirIds.indexOf(ourIds[pageNumber - 1] ?? '');
				return index < 0 ? null : index + 1;
			};

			// Nothing drawn here from now until the reload may be lost to it.
			if (moved && !this.controller.isReadOnly()) {
				this.controller.setReadOnly(true);
				pausedInput = true;
			}

			const writes: { pageNumber: number; annotations: Annotation[] }[] = [];
			const gone: number[] = [];
			const pages = new Set<number>([...this.savedAnnotations.keys(), ...this.seededPages, ...this.dirtyPages]);
			if (!moved) for (const theirPage of opened.savedAnnotations.keys()) pages.add(theirPage);
			for (const pageNumber of pages) {
				const base = this.savedAnnotations.get(pageNumber) ?? [];
				const viewport = this.viewports.get(pageNumber);
				const live = viewport && this.seededPages.has(pageNumber);
				const ours = live ? this.controller.getPageAnnotations(pageNumber).map((a) => toPdfSpace(a, viewport)) : base;
				const theirPage = theirPageFor(pageNumber);
				if (theirPage === null) {
					// Deleted there. Whatever was saved on it went with it, as
					// the other device meant; what was drawn here since cannot
					// go anywhere, and is said so rather than lost quietly.
					if (ours.some((a) => !base.some((b) => sameInFile(a, b)))) gone.push(pageNumber);
					continue;
				}
				const theirs = opened.savedAnnotations.get(theirPage) ?? [];
				const merged = mergeAnnotations(base, ours, theirs, sameInFile);
				if (moved) {
					if (!sameSet(merged, theirs)) writes.push({ pageNumber: theirPage, annotations: merged });
					continue;
				}
				if (live && !sameSet(merged, ours)) {
					this.controller.replacePage(pageNumber, merged.map((a) => toCanvasSpace(a, viewport)));
				}
				if (!sameSet(merged, theirs)) unsaved.push(pageNumber);
			}

			if (moved && writes.length > 0) {
				// Saved here and now, to their file, where each page is in it.
				try {
					let outcome = await writer.write(writes);
					if (outcome.mode === 'append') {
						const { appendix, baseLength } = outcome;
						try {
							await this.ownWrite(file, () => appendBinarySafely(this.app.vault, file, appendix, baseLength));
						} catch (error) {
							// As a save does (see saveDirtyPages): the fast path given
							// up, and the same ink written whole instead.
							await writer.abandon(String(error));
							outcome = await writer.write(writes);
							if (outcome.mode === 'append') throw error;
						}
					}
					if (outcome.mode === 'full') {
						const whole = outcome.bytes;
						await this.ownWrite(file, () => writeBinarySafely(this.app.vault, file, whole));
					}
					await writer.commit();
				} catch (error) {
					// Theirs is on disk and ours still on screen and dirty: the
					// next save finds the file changed and brings this round
					// again, rather than either side being lost.
					writer.terminate();
					console.error('InklingExpanded: could not save ink into a change from another device.', error);
					return false;
				}
			} else {
				await this.rememberDisk(file);
			}

			if (gone.length > 0) {
				const list = gone.join(', ');
				new Notice(`InklingExpanded: ${gone.length === 1 ? `page ${list} was` : `pages ${list} were`} deleted on another device, with what you had just drawn on ${gone.length === 1 ? 'it' : 'them'}.`);
			}

			this.savedAnnotations = opened.savedAnnotations;
			this.pageIds = theirIds;
			this.writer?.terminate();
			this.writer = writer;
			pendingWriter = null;
			this.maxWriteInterval = maxWriteIntervalMs(
				this.getSettings().saveCadence === 'frequent' ? 0 : bytes.byteLength,
				opened.incremental && canAppendBinary(this.app.vault),
			);
			this.sharedWithAnotherDevice = true;

			if (moved) {
				// All of ours is in their file now. Nothing may be saved again by
				// this view's page numbers, which no longer mean those pages.
				this.dirtyPages.clear();
				if (this.writeDebounceHandle !== null) window.clearTimeout(this.writeDebounceHandle);
				if (this.maxWaitHandle !== null) window.clearTimeout(this.maxWaitHandle);
				this.writeDebounceHandle = null;
				this.maxWaitHandle = null;
				pausedInput = false;
				reload = true;
			} else {
				reload = resized;
			}
		} catch (error) {
			console.error('InklingExpanded: failed to take in a change from another device.', error);
		} finally {
			pendingWriter?.terminate();
			release();
			if (this.saving === slot) this.saving = null;
			if (pausedInput) this.controller.setReadOnly(false);
		}

		// Ours that their file does not have yet, on its way to it.
		for (const pageNumber of unsaved) this.markPageDirty(pageNumber);
		if (reload && token === this.renderToken) {
			// Saved directly: flushAnnotationsIfDirty waits for the pull under
			// way, which is this one.
			if (this.dirtyPages.size > 0 || this.saving) await this.flushAnnotations(file);
			return true;
		}
		return false;
	}

	// A finger held on a picture picks it up, as a pen held on one does (see
	// AnnotationController.pickUpPictureAt). Found from the client point: the
	// page under it, and the point in that page's canvas.
	private pickUpPictureAt(at: Point): boolean {
		const found = this.pagePointAt(at);
		return found ? this.controller.pickUpPictureAt(found.pageNumber, found.point) : false;
	}

	private offerPasteAt(at: Point): boolean {
		const found = this.pagePointAt(at);
		return found ? this.controller.offerPasteAt(found.pageNumber, found.point) : false;
	}

	// Ctrl/Cmd+V: where the pen or mouse is over a page, or else the middle
	// of what is on screen.
	private pasteFromKeyboard(): boolean {
		if (this.controller.isReadOnly() || !this.controller.hasCopied()) return false;
		const at = this.controller.pointerPosition() ?? this.pagePointAt(this.viewCentre());
		return at ? this.controller.pasteAt(at.pageNumber, at.point) : false;
	}

	// A finger's tap anywhere in the view: on a page, the page has it (see
	// AnnotationController.touchTap); between pages or beside them, it only
	// lets go of a selection.
	private tapAt(at: Point): void {
		const found = this.pagePointAt(at);
		if (found) this.controller.touchTap(found.pageNumber, found.point);
		else this.controller.clearSelection();
	}

	// The page under a client point, and the point in that page's canvas.
	private pagePointAt(at: Point): { pageNumber: number; point: Point } | null {
		for (const placeholder of Array.from(this.contentEl.querySelectorAll<HTMLElement>('.inkling-pdf-page-placeholder'))) {
			const overlay = placeholder.querySelector<HTMLCanvasElement>('.inkling-annotation-overlay');
			if (!overlay) continue;
			const rect = overlay.getBoundingClientRect();
			if (at.x < rect.left || at.x > rect.right || at.y < rect.top || at.y > rect.bottom || rect.width === 0) continue;
			const pageNumber = Number(placeholder.dataset[PAGE_NUMBER_ATTR]);
			return { pageNumber, point: { x: ((at.x - rect.left) * overlay.width) / rect.width, y: ((at.y - rect.top) * overlay.height) / rect.height } };
		}
		return null;
	}

	// ---- Importing ----
	//
	// The toolbar's import button: a PDF's pages inserted after the page on
	// screen, or a picture placed on it — from the vault or from the device.

	// Blank, lined or dot grid: for the page in view, or for every page —
	// and then for the pages added after, too.
	private showBackgroundMenu(anchor: HTMLElement): void {
		const menu = new Menu();
		const pageNumber = this.currentPageNumber;
		const targets: Array<[number | 'all', string]> = this.infiniteBox
			? [['all', 'Background']]
			: [
					[pageNumber, `This page (${pageNumber})`],
					['all', 'All pages'],
				];
		targets.forEach(([target, label], index) => {
			if (index > 0) menu.addSeparator();
			menu.addItem((item) => item.setTitle(label).setIsLabel(true));
			for (const style of TEMPLATE_STYLES) {
				menu.addItem((item) =>
					item
						.setTitle(TEMPLATE_STYLE_LABELS[style])
						.setIcon(BACKGROUND_ICONS[style])
						.onClick(() => void this.changeBackground(target, style)),
				);
			}
		});
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
	}

	private async changeBackground(target: number | 'all', style: TemplateStyle): Promise<void> {
		const pageNumber = this.currentPageNumber;
		await this.rebuild('background', 'could not change the background.', async (bytes) => {
			const result = await setPageBackground(bytes, target, style);
			if (result.kind === 'refused') {
				new Notice(`InklingExpanded: the background was not changed — ${result.reason}.`);
				return null;
			}
			return { bytes: toArrayBuffer(result.bytes), scrollTo: pageNumber };
		});
	}

	private showImportMenu(anchor: HTMLElement): void {
		const menu = new Menu();
		// An infinite canvas is one page by definition; pages inserted into
		// it would end it being one.
		if (!this.infiniteBox) {
			menu.addItem((item) =>
				item
					.setTitle('PDF pages from the vault')
					.setIcon('file-text')
					.onClick(() =>
						chooseVaultFile(this.app, ['pdf'], 'Insert the pages of which PDF?', (file) => {
							void this.app.vault.readBinary(file).then((bytes) => this.insertPdfPages(bytes, file.basename));
						}),
					),
			);
			menu.addItem((item) =>
				item
					.setTitle('PDF pages from this device')
					.setIcon('file-up')
					.onClick(() => {
						void chooseDeviceFile(anchor.ownerDocument, '.pdf,application/pdf').then(async (file) => {
							if (file) await this.insertPdfPages(await file.arrayBuffer(), file.name);
						});
					}),
			);
			menu.addSeparator();
		}
		menu.addItem((item) =>
			item
				.setTitle('Picture from the vault')
				.setIcon('image')
				.onClick(() =>
					chooseVaultFile(this.app, PICTURE_EXTENSIONS, 'Place which picture?', (file) => {
						void this.app.vault.readBinary(file).then((bytes) => this.insertPicture(new Blob([bytes]), file.name));
					}),
				),
		);
		menu.addItem((item) =>
			item
				.setTitle('Picture from this device')
				.setIcon('camera')
				.onClick(() => {
					void chooseDeviceFile(anchor.ownerDocument, 'image/*').then(async (file) => {
						if (file) await this.insertPicture(file, file.name);
					});
				}),
		);
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
	}

	// Every page of another PDF, after the page on screen. Done the way "Add
	// page" adds one: what is unsaved is saved first, the file is rewritten
	// with pdf-lib, and the view reloads from it.
	private async insertPdfPages(bytes: ArrayBuffer, name: string): Promise<void> {
		// Most often failing for a PDF with a password on it, which pdf-lib
		// cannot copy pages out of.
		await this.rebuild('insert-pages', `could not insert the pages of ${name}. If it is password-protected, remove the password first.`, async (current) => {
			const source = await PDFDocument.load(bytes);
			const target = await PDFDocument.load(current);
			const insertAt = Math.min(this.currentPageNumber, target.getPageCount());
			const pages = await target.copyPages(source, source.getPageIndices());
			pages.forEach((page, index) => target.insertPage(insertAt + index, page));
			return {
				bytes: toArrayBuffer(await target.save()),
				scrollTo: insertAt + 1,
				notice: `InklingExpanded: inserted ${pages.length} ${pages.length === 1 ? 'page' : 'pages'} from ${name}.`,
			};
		});
	}

	// A picture onto the page on screen, in the middle of the part of it
	// that shows, selected so it can be moved and sized into place.
	private async insertPicture(blob: Blob, name: string): Promise<void> {
		if (this.controller.isReadOnly()) return;
		const pageNumber = this.currentPageNumber;
		const viewport = this.viewports.get(pageNumber);
		const placeholder = this.contentEl.querySelector<HTMLElement>(`.inkling-pdf-page-placeholder[data-page-number="${pageNumber}"]`);
		if (!viewport || !placeholder) return;

		let picture;
		try {
			picture = await preparePicture(blob, this.contentEl.ownerDocument);
		} catch (error) {
			console.error('InklingExpanded: failed to read a picture.', error);
			new Notice(`InklingExpanded: could not read ${name} as a picture on this device.`);
			return;
		}
		// The page may have changed while the picture was decoding.
		if (this.viewports.get(pageNumber) !== viewport) return;

		const page = placeholder.getBoundingClientRect();
		const view = this.contentEl.getBoundingClientRect();
		const scale = page.width > 0 ? viewport.width / page.width : 1;
		const centre = {
			x: ((Math.max(page.left, view.left) + Math.min(page.right, view.right)) / 2 - page.left) * scale,
			y: ((Math.max(page.top, view.top) + Math.min(page.bottom, view.bottom)) / 2 - page.top) * scale,
		};
		const box = placePicture({ minX: 0, minY: 0, maxX: viewport.width, maxY: viewport.height }, picture, centre);
		this.controller.place(pageNumber, {
			id: createId(),
			kind: 'image',
			color: '#000000',
			width: 1,
			start: { x: box.minX, y: box.minY },
			end: { x: box.maxX, y: box.maxY },
			picture,
		});
	}

	// ---- Navigation panel (outline + find) ----

	// Built once per file load, alongside the toolbar, and hidden until
	// asked for — so a reader who never opens it sees exactly the layout
	// they saw before this existed.
	// A card hanging from the bottom of the tool strip, over the pages
	// rather than between the strip and them: it stays where it is while the
	// pages scroll under it, and opening it no longer pushes the page being
	// read down the screen.
	private buildNavigationPanel(): void {
		const host = this.contentEl.querySelector<HTMLElement>('.inkling-toolbar') ?? this.contentEl;
		const panel = host.createDiv({ cls: 'inkling-nav-panel' });
		panel.hidden = true;
		panel.setAttribute('role', 'dialog');
		panel.setAttribute('aria-label', 'Outline and find');
		this.navPanel = panel;

		const header = panel.createDiv({ cls: 'inkling-nav-header' });
		header.createDiv({ cls: 'inkling-nav-title', text: 'Outline and find' });
		const close = header.createEl('button', { cls: 'clickable-icon inkling-nav-close' });
		close.type = 'button';
		setIcon(close, 'x');
		setTooltip(close, 'Close');
		close.addEventListener('click', () => this.toggleNavigationPanel(false));

		// Obsidian's own search field, clear button and all.
		const findRow = panel.createDiv({ cls: 'search-input-container inkling-nav-find' });
		const input = findRow.createEl('input', { cls: 'inkling-nav-find-input' });
		input.type = 'search';
		input.placeholder = 'Find in document';
		input.setAttribute('aria-label', 'Find in document');
		const status = panel.createDiv({ cls: 'inkling-nav-status' });
		const results = panel.createDiv({ cls: 'inkling-nav-results' });

		// Searches as it is typed, once typing pauses, and at once on Enter.
		// The pause is the view's, so closing the document cancels it.
		const search = () => {
			if (this.navSearchHandle !== null) window.clearTimeout(this.navSearchHandle);
			this.navSearchHandle = null;
			void this.runFind(input.value, status, results);
		};
		input.addEventListener('input', () => {
			if (this.navSearchHandle !== null) window.clearTimeout(this.navSearchHandle);
			this.navSearchHandle = window.setTimeout(search, FIND_AS_YOU_TYPE_MS);
		});
		panel.addEventListener('keydown', (event: KeyboardEvent) => {
			// Kept in here: the view's own keys are tool shortcuts.
			event.stopPropagation();
			if (event.key === 'Escape') {
				event.preventDefault();
				this.toggleNavigationPanel(false);
			} else if (event.key === 'Enter' && event.target === input) {
				event.preventDefault();
				search();
			}
		});

		this.navOutline = panel.createDiv({ cls: 'inkling-nav-outline' });
	}

	private toggleNavigationPanel(open?: boolean): void {
		const panel = this.navPanel;
		if (!panel) return;
		panel.hidden = !(open ?? panel.hidden);
		if (!panel.hidden) {
			this.markCurrentChapter();
			panel.querySelector<HTMLInputElement>('.inkling-nav-find-input')?.focus();
		}
	}

	// Goes to a page from the panel. On a phone the panel covers most of
	// what it would show, so it gets out of the way.
	private goFromPanel(pageNumber: number): void {
		this.scrollToPage(pageNumber);
		if (this.contentEl.ownerDocument.body.classList.contains('is-phone')) this.toggleNavigationPanel(false);
	}

	// The outline entry for the part of the document on screen: the last one
	// that starts at or before the current page.
	private markCurrentChapter(): void {
		const outline = this.navOutline;
		if (!outline || this.navPanel?.hidden) return;
		let current: HTMLElement | null = null;
		for (const entry of Array.from(outline.querySelectorAll<HTMLElement>('.inkling-nav-entry'))) {
			entry.removeClass('is-current');
			if (Number(entry.dataset.page) <= this.currentPageNumber) current = entry;
		}
		current?.addClass('is-current');
	}

	// pdf.js states a destination either as an explicit array or as a name
	// that has to be looked up first, and either can dangle. Anything that
	// fails resolves to null and is dropped from the list rather than shown
	// as an entry that does nothing when clicked.
	private async resolveDestination(pdf: PDFDocumentProxy, dest: unknown): Promise<number | null> {
		try {
			const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
			const ref: unknown = Array.isArray(explicit) ? explicit[0] : null;
			if (ref === null || typeof ref !== 'object') return null;
			return (await pdf.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0])) + 1;
		} catch {
			return null;
		}
	}

	private async loadOutline(pdf: PDFDocumentProxy, token: number): Promise<void> {
		let entries: OutlineEntry[] = [];
		try {
			entries = await flattenOutline(await pdf.getOutline(), (dest) => this.resolveDestination(pdf, dest));
		} catch (error) {
			console.error('InklingExpanded: could not read this PDF outline.', error);
			return;
		}
		if (token !== this.renderToken) return;

		const host = this.navOutline;
		if (!host) return;
		host.empty();
		// A document with no outline hides the section entirely rather than
		// showing an empty list under a heading, which reads as broken.
		if (entries.length === 0) return;

		host.createDiv({ cls: 'inkling-nav-heading', text: 'Outline' });
		for (const entry of entries) {
			const pageNumber = entry.pageNumber;
			if (pageNumber === null) continue;
			const row = host.createEl('button', { cls: 'inkling-nav-entry' });
			row.type = 'button';
			row.dataset.page = String(pageNumber);
			row.setCssProps({ '--inkling-nav-depth': String(entry.depth) });
			row.createSpan({ cls: 'inkling-nav-entry-title', text: entry.title });
			row.createSpan({ cls: 'inkling-nav-entry-page', text: String(pageNumber) });
			row.addEventListener('click', () => this.goFromPanel(pageNumber));
		}
		this.markCurrentChapter();
	}

	// Walks pages in order from the one being read, so the first result is
	// usually the nearest one. Incremental and interruptible: on a long
	// scanned book this is genuinely slow and may find nothing at all, and a
	// reader has to be able to keep reading — or change their mind — while
	// it runs.
	private async runFind(query: string, status: HTMLElement, results: HTMLElement): Promise<void> {
		const pdf = this.pdf;
		results.empty();
		const needle = query.trim();
		if (!pdf || !needle) {
			status.setText('');
			return;
		}

		// A second search supersedes the first, and so does switching files.
		const findToken = ++this.findToken;
		const renderToken = this.renderToken;
		let found = 0;

		for (let offset = 0; offset < pdf.numPages; offset++) {
			if (findToken !== this.findToken || renderToken !== this.renderToken) return;
			const pageNumber = ((this.currentPageNumber - 1 + offset) % pdf.numPages) + 1;

			let text = '';
			try {
				const content = await (await pdf.getPage(pageNumber)).getTextContent();
				text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
			} catch {
				// A page whose text will not extract — a scan with no text layer,
				// a damaged stream — is simply not searched.
				continue;
			}
			if (findToken !== this.findToken || renderToken !== this.renderToken) return;

			const matches = findMatches(text, needle);
			if (matches > 0) {
				found += matches;
				const row = results.createEl('button', { cls: 'inkling-nav-entry' });
				row.type = 'button';
				row.createSpan({ cls: 'inkling-nav-entry-title', text: `Page ${pageNumber}` });
				row.createSpan({ cls: 'inkling-nav-entry-page', text: `${matches} ${matches === 1 ? 'match' : 'matches'}` });
				row.addEventListener('click', () => this.goFromPanel(pageNumber));
			}
			status.setText(`Searched ${offset + 1} of ${pdf.numPages} pages, ${found} found`);
		}

		status.setText(found === 0 ? `No matches for "${needle}"` : `${found} matches`);
	}

	// ---- Note editor ----

	// A small popover anchored to the page, resolving with the text typed
	// into it, an empty string to delete, or null if cancelled.
	//
	// Built here rather than in the controller because the controller is
	// shared with Markdown ink blocks and deliberately owns no DOM. The
	// text goes in and comes out through the textarea’s value, never through
	// innerHTML: a note is user content, and it round-trips through a PDF
	// that other software can write to.
	private editNote(pageNumber: number, point: Point, existing: string): Promise<string | null> {
		this.closeNoteEditor();

		const placeholder = this.contentEl.querySelector<HTMLElement>(
			`.inkling-pdf-page-placeholder[data-page-number="${pageNumber}"]`,
		);
		if (!placeholder) return Promise.resolve(null);

		return new Promise<string | null>((resolve) => {
			const popover = placeholder.createDiv({ cls: 'inkling-note-editor' });
			// Positioned in the placeholder’s own coordinate space, which is
			// the space the point arrives in, scaled to its CSS size — the
			// canvas backing store is larger than the element on a narrow
			// screen (see annotate/pointer.ts).
			const canvas = this.pageCanvases.get(pageNumber);
			const scale = canvas && canvas.width > 0 ? placeholder.clientWidth / canvas.width : 1;

			const header = popover.createDiv({ cls: 'inkling-note-header' });
			header.createDiv({ cls: 'inkling-note-title', text: existing ? 'Edit note' : 'New note' });

			const field = popover.createEl('textarea', { cls: 'inkling-note-text' });
			field.value = existing;
			field.placeholder = 'Write a note…';
			field.rows = 3;
			field.setAttribute('aria-label', 'Note text');
			// Grows with what is written, up to a limit past which it scrolls,
			// rather than a fixed box with a drag handle in its corner — which
			// a finger cannot use.
			const fit = () => {
				field.setCssProps({ '--inkling-note-height': 'auto' });
				field.setCssProps({ '--inkling-note-height': `${field.scrollHeight}px` });
			};
			field.addEventListener('input', fit);

			const footer = popover.createDiv({ cls: 'inkling-note-footer' });
			// The keyboard shortcut, for a keyboard. A phone has none to press.
			if (!this.contentEl.ownerDocument.body.classList.contains('is-mobile')) {
				footer.createDiv({ cls: 'inkling-note-hint', text: 'Ctrl+Enter to save' });
			}
			const buttons = footer.createDiv({ cls: 'inkling-note-buttons' });
			let settled = false;
			const finish = (result: string | null) => {
				if (settled) return;
				settled = true;
				popover.remove();
				if (this.noteEditor === popover) this.noteEditor = null;
				resolve(result);
			};

			// Deleting is clearing the text and saving, which is how a note was
			// always removed; a note being edited gets a button that says so.
			if (existing) {
				const remove = header.createEl('button', { cls: 'clickable-icon inkling-note-delete' });
				remove.type = 'button';
				setIcon(remove, 'trash-2');
				setTooltip(remove, 'Delete note');
				remove.addEventListener('click', () => finish(''));
			}

			const cancel = buttons.createEl('button', { cls: 'inkling-note-button', text: 'Cancel' });
			cancel.type = 'button';
			cancel.addEventListener('click', () => finish(null));

			const save = buttons.createEl('button', { cls: 'inkling-note-button mod-cta', text: 'Save' });
			save.type = 'button';
			save.addEventListener('click', () => finish(field.value));

			// Positioned only now, because the placeholder clips its children
			// and clamping needs a measured size — which the popover does not
			// have until its textarea and buttons are in it. Placed near the
			// right edge before this, a note's editor lost 251 of its 280
			// pixels to the clip, Save button included, and could not be
			// saved at all.
			fit();
			const placed = placeWithin(
				{ x: point.x * scale + NOTE_POPOVER_MARGIN, y: point.y * scale + NOTE_POPOVER_MARGIN },
				{ width: popover.offsetWidth, height: popover.offsetHeight },
				{ width: placeholder.clientWidth, height: placeholder.clientHeight },
				NOTE_POPOVER_MARGIN,
			);
			popover.setCssProps({
				'--inkling-note-x': `${placed.x}px`,
				'--inkling-note-y': `${placed.y}px`,
			});

			field.addEventListener('keydown', (event: KeyboardEvent) => {
				// Stopped here rather than left to bubble: the view-wide key
				// handler treats bare letters as tool shortcuts, and typing a
				// note would otherwise change the pen with every word.
				event.stopPropagation();
				if (event.key === 'Escape') {
					event.preventDefault();
					finish(null);
				} else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
					event.preventDefault();
					finish(field.value);
				}
			});

			this.noteEditor = popover;
			field.focus();
			field.select();
		});
	}

	private closeNoteEditor(): void {
		this.noteEditor?.remove();
		this.noteEditor = null;
	}

	// Whether the page and its ink are inverted, from the setting plus the
	// current theme. The class does the work — see styles.css for which
	// layers it reaches, and why the highlight layer is not one of them.
	private applyInversion(): void {
		const setting = this.getSettings().darkInversion;
		const inverted =
			this.sessionInversion ?? (setting === 'on' || (setting === 'follow-theme' && this.isDarkTheme()));
		this.contentEl.toggleClass('is-inverted', inverted);
		this.controller.refreshUi();
	}

	// Flips inversion for this session without writing the setting — the
	// answer to "this one scan is unreadable" rather than to "I always want
	// this". Cleared when the file changes, because the next document is a
	// different question.
	toggleInversion(): void {
		const setting = this.getSettings().darkInversion;
		const current = setting === 'on' || (setting === 'follow-theme' && this.isDarkTheme());
		this.sessionInversion = !(this.sessionInversion ?? current);
		this.applyInversion();
	}

	// The theme of the window this view is in: a popout window has a body of
	// its own, and it is that one Obsidian marks.
	private isDarkTheme(): boolean {
		return this.contentEl.ownerDocument.body.classList.contains('theme-dark');
	}

	isInverted(): boolean {
		return this.contentEl.hasClass('is-inverted');
	}

	// Leaves something visible instead of the blank/black screen a failed
	// load used to produce — the toolbar (already built by the time any of
	// this can fail) stays up, but with an explanation in place of pages
	// that never rendered, rather than nothing at all.
	private showLoadError(): void {
		this.clearLoading();
		const box = this.contentEl.createDiv({ cls: 'inkling-pdf-message' });
		setIcon(box.createDiv({ cls: 'inkling-pdf-message-icon' }), 'file-warning');
		box.createDiv({
			cls: 'inkling-pdf-message-text',
			text: "InklingExpanded couldn't open this PDF. Try reopening it, or view it in reading mode.",
		});
	}

	// Sits above the pages rather than replacing them: the document is
	// perfectly readable, and its existing annotations still display. Only
	// writing to it is off the table, and this says why.
	private showReadOnlyBanner(reason: string): void {
		// One banner, not one per reason. The open gate and the repeated-
		// failure path can both reach this, and two stacked notices saying
		// different things about the same file would read as a bug.
		if (this.contentEl.querySelector('.inkling-pdf-readonly')) return;
		const box = this.contentEl.createDiv({ cls: 'inkling-pdf-message inkling-pdf-readonly' });
		setIcon(box.createDiv({ cls: 'inkling-pdf-message-icon' }), 'file-warning');
		box.createDiv({
			cls: 'inkling-pdf-message-text',
			text: `InklingExpanded can't safely annotate this PDF, because ${reason}. You can read it and see annotations already on it, but editing is turned off so the file isn't damaged.`,
		});
	}

	// A spinner and a line of text while the file is being read and parsed —
	// see the call in onLoadFile for why the wait needed something in it.
	private showLoading(): void {
		this.clearLoading();
		const box = this.contentEl.createDiv({ cls: 'inkling-pdf-message inkling-pdf-loading' });
		box.createDiv({ cls: 'inkling-pdf-spinner' });
		box.createDiv({ cls: 'inkling-pdf-message-text', text: 'Opening for annotation…' });
		this.loadingEl = box;
	}

	private clearLoading(): void {
		this.loadingEl?.remove();
		this.loadingEl = null;
	}

	private scrollToPage(pageNumber: number): void {
		const placeholder = this.contentEl.querySelector<HTMLElement>(
			`.inkling-pdf-page-placeholder[data-page-number="${pageNumber}"]`,
		);
		placeholder?.scrollIntoView({ block: 'center' });
	}
}
