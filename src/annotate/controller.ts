import { Notice } from 'obsidian';
import { eraseAt } from './eraser';
import {
	boundingBox,
	clampPointToBounds,
	clampTranslation,
	distance,
	hitTestAnnotation,
	polygonSelectsAnnotation,
	scaleAnnotationAbout,
	translateAnnotation,
	unionBoundingBox,
} from './geometry';
import { createId } from './id';
import { attachPointerGestures, contentZoom, currentZoom, GestureHandlers, MAX_ZOOM, setContentZoom, zoomAbout, type ContentZoom, type ViewZoom } from './pointer';
import { recognizeShape } from './recognize';
import { SIMPLIFY_EPSILON, simplifyPoints } from './simplify';
import { prepareStroke } from './stroke';
import {
	cropButtonAt,
	cropHandleAt,
	drawHighlights,
	drawInk,
	drawOverlay,
	handleAt,
	isHighlight,
	onPictureDecoded,
	pasteButtonAt,
	renderBase,
	renderHighlights,
	renderOverlay,
	selectionButtonAt,
	selectionFrame,
	type CropHandle,
	type HandleName,
	type OverlayOptions,
} from './render';
import { cropPicture, cropRegion } from './pictureCrop';
import { attachSelectionCatcher } from './selectionCatcher';
import { AnnotationStore } from './store';
import { HistoryStack } from './history';
import type { ToolbarLayout } from './toolbarLayout';
import { ToolState } from './toolState';
import {
	Annotation,
	DrawToolType,
	HIGHLIGHTER_OPACITY,
	NoteAnnotation,
	PenBrush,
	Point,
	Rect,
	ShapeAnnotation,
	ShapeToolType,
	StrokeAnnotation,
	ToolType,
	isLockedPicture,
} from './types';

// The eraser reuses the shared width control as its size/radius (per the
// plan: "adjustable size/radius, same as pen/highlighter width control"),
// scaled up — a radius equal to the line width would be too fussy to aim
// with a fingertip or an imprecise pen tap.
const ERASER_RADIUS_FACTOR = 3;
const MIN_ERASER_RADIUS = 10;
const DRAFT_ID = '__draft__';

// The smallest a selection can be shrunk to, in screen pixels.
const MIN_SELECTION_SIZE = 12;

// How far, in screen pixels, a lasso may wander and still count as a tap.
const TAP_SLOP = 6;

// Pressing on a picture and holding still this long picks it up, whatever
// tool is in hand — the way to get back to a picture placed some time ago,
// with the pen still in hand and ink all over it.
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 8;

function isTap(points: Point[], slop: number): boolean {
	const [first] = points;
	if (!first) return true;
	return points.every((point) => Math.hypot(point.x - first.x, point.y - first.y) <= slop);
}

// How long the pen has to dwell at the end of a stroke, before lifting,
// for that stroke to be offered to shape recognition. The gesture every
// other handwriting app uses, and the reason recognition needs no UI of
// its own: it is opt-in per stroke, so ordinary handwriting is never
// rewritten behind the user’s back.
const SHAPE_HOLD_MS = 500;

// How far a sample may sit from the last one and still count as the pen
// having been held still. A stylus resting on glass reports a steady
// jitter of a pixel or two, and treating that as motion would mean the
// hold gesture could never be performed at all.
const HOLD_STILLNESS_PX = 2.5;


type ButtonTool = 'eraser' | 'highlighter' | 'select';

// What a stylus's buttons say, read by readPenButtons: a button held that
// lends its tool while it is (`held`), Android's side button pressed in the
// air (`air-press`), which switches tools instead, a pen hovering with none
// (`hover-free`), one on or leaving the glass with none (`free`) — or, for
// a mouse or a finger, nothing.
type PenButtons =
	| { kind: 'held'; tool: ButtonTool }
	| { kind: 'air-press'; tool: ButtonTool }
	| { kind: 'hover-free' }
	| { kind: 'free' }
	| { kind: 'unknown' };


// What was last copied, shared by every surface this plugin draws on — so
// writing copied in one PDF can be pasted on another page, into another
// PDF, or into a note's ink block. `unit` is the copying page's canvas
// pixels per page unit (see AnnotationControllerOptions.getUnitScale), which
// is what lets a copy land the same size wherever it is pasted.
let clipboard: { annotations: Annotation[]; unit: number } | null = null;
// The first copy of a session says how to paste; later ones only that they
// copied.
let pasteHintShown = false;

// Forgets what was copied — as a new session starts out. For tests, which
// share one module, and so one clipboard, between them.
export function forgetCopied(): void {
	clipboard = null;
}

type DragMode =
	| { kind: 'draw'; tool: DrawToolType; points: Point[]; lastMovedAt: number }
	| { kind: 'shape'; tool: ShapeToolType; start: Point; end: Point }
	| { kind: 'erase'; before: Annotation[] }
	| { kind: 'lasso'; points: Point[] }
	// `box` is the selection's bounds at the moment the drag began, held so
	// every move can be limited against them without recomputing the union
	// of every selected annotation on each pointer sample. Resize carries
	// one for the same reason.
	| { kind: 'move'; before: Annotation[]; ids: string[]; origin: Point; box: Rect }
	// `anchor` is the corner opposite the one being dragged, which stays
	// where it is while the selection grows or shrinks towards the pointer.
	| { kind: 'resize'; before: Annotation[]; ids: string[]; box: Rect; handle: HandleName; anchor: Point }
	// A grip of a picture's crop, or the whole of it, with the crop as it
	// was when the press began.
	| { kind: 'crop'; handle: CropHandle; origin: Point; start: Rect };

// The smallest a crop is let shrink to, in screen pixels.
const MIN_CROP = 24;

interface PageMount {
	// Two stacked canvases rather than one: `base` holds committed
	// annotations and is only repainted when the store's content for this
	// page actually changes; `overlay` holds the in-progress draft/lasso/
	// selection/eraser-cursor and is repainted on every pointer move. See
	// render.ts's renderBase/renderOverlay for why this split matters.
	base: CanvasRenderingContext2D;
	// The overlay's element is always here — it is the surface that receives
	// pointer events, so it has to exist from the moment the page mounts.
	// Its 2D context is not: acquiring one is what makes the browser
	// allocate the backing store, width x height x 4 bytes, and a page
	// somebody only ever scrolls past never needs it. See overlayContext.
	overlayCanvas: HTMLCanvasElement;
	overlay: CanvasRenderingContext2D | null;
	// A third canvas, beneath the other two, holding only highlighter
	// strokes. Separate because it is composited into the page with
	// mix-blend-mode: multiply (see styles.css) and the other two must not
	// be: multiplied dark ink vanishes into a dark or inverted page, and a
	// note marker's white halo multiplies away to nothing.
	//
	// Created lazily, and for the same reason the overlay's context is: a
	// canvas costs width x height x 4 bytes the moment it exists, and most
	// pages of most books carry no highlight at all. A page only pays for
	// this layer once something is actually highlighted on it.
	highlightCanvas: HTMLCanvasElement | null;
	highlight: CanvasRenderingContext2D | null;
	// Whether the last paint of that layer included an in-progress draft.
	// Kept so the layer is repainted exactly twice per highlighter gesture's
	// worth of extra work — once when the draft first appears and once when
	// it goes — rather than on every pointermove of every *other* tool,
	// which would make each pen sample repaint every highlight on the page
	// for no change at all.
	highlightDraft: boolean;
	// The size the layers are backed at, kept so a lazily-created highlight
	// canvas can match the two that already exist.
	width: number;
	height: number;
	// The zoomable wrapper the canvases live in — the element the zoom
	// transform is applied to. Held so a zoom asked for from the toolbar
	// or the keyboard, which has no pointer to work back from, can reach
	// the same machinery a pinch does.
	content: HTMLElement;
	detach: () => void;
}

export interface AnnotationControllerOptions {
	// The plugin-wide tool/color/width selection. Passed in rather than
	// owned here because a Markdown ink block's controller is destroyed and
	// rebuilt every time the block saves (see markdown/inkBlock.ts), which
	// would otherwise reset the user's pen mid-sentence. Omitted only by
	// callers with no toolbar to keep in sync — each gets its own.
	toolState?: ToolState;
	// An undo history that outlives this controller. Ink blocks pass one
	// because a block is destroyed and rebuilt by its own save, roughly a
	// second after the pen comes up — a history owned by the controller
	// was therefore wiped that often, which made undo useless on the one
	// surface people draw on most. Omitted by callers whose controller
	// outlives the work, which get their own.
	history?: HistoryStack;
	onAddPage?: () => void;
	getCurrentPage?: () => number | null;
	// Fires once per committed gesture (draw, erase, move, resize, recolor,
	// clear, lasso-delete) and once per undo/redo — the signal src/pdfView.ts
	// uses to know a page's on-disk annotations are now stale and schedule a
	// debounced write.
	onAnnotationsChanged?: (pageNumber: number) => void;
	// Fires once a pinch-zoom gesture on a page ends, with its current zoom
	// scale — src/pdfView.ts uses this to decide whether that page's PDF
	// render is now too low-resolution to look sharp at this zoom level and,
	// if so, re-render it (see its upgradeResolution).
	onZoomSettled?: (pageNumber: number, scale: number) => void;
	// Canvas pixels per unit of pen width on a page, asked each time ink is
	// made. Omitted, a unit is one pixel. A host that re-backs a page at a
	// different resolution — the PDF view does, whenever a zoom sharpens one
	// — has to answer, or the same pen draws a different width after the
	// re-render than before it: one page of handwriting came out in two
	// widths exactly that way.
	getInkScale?: (pageNumber: number) => number;
	// Called right before a highlighter stroke commits (pointerup, or a
	// cancelled-but-kept gesture) — src/pdfView.ts uses this to replace the
	// raw freehand path with one or more straight, text-line-height segments
	// snapped to whatever PDF text the stroke actually swept over, so a
	// highlighter drag over real text comes out straight instead of
	// following the pen's natural wobble. Returning null (no text under the
	// stroke, or the host view doesn't support this — e.g. Markdown ink
	// blocks later) falls back to committing the raw stroke as drawn.
	onSnapHighlighterStroke?: (pageNumber: number, points: Point[], color: string) => Annotation[] | null;
	// Asks the host surface to scroll to a page. Only the host knows how
	// its pages are laid out — a Markdown ink block has exactly one and
	// omits this, which is what hides the toolbar page controls there.
	onGoToPage?: (pageNumber: number) => void;
	// Asks the host surface to collect text for a note annotation, given
	// where it sits (in this page’s canvas space) and whatever it already
	// says. Resolving null cancels; resolving an empty string deletes.
	//
	// The controller owns no DOM of its own — it is mounted into a PDF
	// view and into Markdown ink blocks alike — so the editor belongs to
	// whoever mounted it. A host that does not supply this has no note
	// tool at all, which is how ink blocks stay out of it.
	onEditNote?: (pageNumber: number, point: Point, existing: string) => Promise<string | null>;
	// Whether holding the pen still at the end of a stroke snaps it to a
	// clean shape. Off unless the host says otherwise, so a surface that
	// never opted in cannot silently rewrite handwriting.
	isShapeRecognitionEnabled?: () => boolean;
	// Dark-mode page inversion, which belongs to the host: only it has a
	// page canvas to invert. A surface without one omits both and the
	// toolbar hides the control.
	onToggleInversion?: () => void;
	isInverted?: () => boolean;
	// Asks the host to show or hide its navigation panel. Same reasoning:
	// the panel belongs to the PDF view, not to the shared controller.
	onToggleNavigation?: () => void;
	// Zoom for the whole view instead of each page on its own (see
	// pointer.ts's ViewZoom). The PDF view supplies one, so that zooming
	// there works the way it does in Obsidian's own reader; an ink block
	// has no view of its own to zoom and omits it.
	viewZoom?: ViewZoom;
	// Opens the host's import menu, from the toolbar's import button. A
	// surface without one has no import, which is how ink blocks stay out.
	onImport?: (anchor: HTMLElement) => void;
	// Opens the host's menu of page backgrounds, from the toolbar's
	// background button. Offered, like Add page, only on a note.
	onChangeBackground?: (anchor: HTMLElement) => void;
	// What the side button of a stylus does while held (see the setting).
	// Omitted, it erases.
	getPenButtonAction?: () => 'eraser' | 'highlighter' | 'select' | 'none';
	// A page's canvas pixels per unit of the page itself — PDF points, in the
	// PDF view. Omitted, 1: an ink block's canvas is its own unit. Copying
	// and pasting between pages shown at different sizes goes through it.
	getUnitScale?: (pageNumber: number) => number;
	// Told whenever a page's ink, or its live layer (the stroke being drawn,
	// a lasso, a selection), has been painted again. The PDF view draws both
	// a second time, magnified, wherever it is zoomed in past what a whole
	// page's canvas can hold (see its detail layer), and has to keep that
	// copy current. See drawInkTo and drawOverlayTo.
	onPageRepainted?: (pageNumber: number, layer: 'ink' | 'overlay') => void;
}

// The shared annotation tool module — owns tool/color/width state, an
// undo/redo history, and a per-page annotation store, and wires Pointer
// Events (with palm rejection) to an overlay canvas per mounted page. Built
// once, deliberately free of any PDF- or Markdown-specific concepts, so the
// Markdown ink blocks (a later step) can mount pages into this exact same
// controller instead of duplicating the tool logic.
export class AnnotationController {
	private readonly history: HistoryStack;
	// Whether this controller created its own history, and so may clear
	// it. A history handed in from outside outlives this controller on
	// purpose (see markdown/inkBlock.ts) and clearing it on unmount would
	// defeat the entire point of passing it.
	private readonly ownsHistory: boolean;
	private readonly store: AnnotationStore;
	private readonly pages = new Map<number, PageMount>();
	private readonly listeners = new Set<() => void>();

	private readonly toolState: ToolState;
	// The tool a held stylus side button took over from, put back when it is
	// let go. See followPenButtons.
	private toolUnderButton: ToolType | null = null;
	// The layer that follows a pen held to the glass with Android's side
	// button down, while it is held — see selectionCatcher.ts — and where
	// the stroke it is erasing last reached.
	private catcher: { pageNumber: number; detach: () => void } | null = null;
	private catcherLast: Point | null = null;
	// A picture being cropped: where it is on its page, and the part of it
	// that is to stay. See startCrop.
	private cropping: { pageNumber: number; id: string; picture: Rect; rect: Rect } | null = null;
	// A paste on offer, where a press was held (see offerPasteAt).
	private pasteOffer: { pageNumber: number; at: Point } | null = null;
	// Where a pen or mouse last was over a page, for a paste from the
	// keyboard.
	private lastPointer: { pageNumber: number; point: Point } | null = null;
	// A press on a picture that may yet turn into picking it up. See
	// LONG_PRESS_MS.
	private longPress: { pageNumber: number; at: Point; timer: number } | null = null;
	// The tool that was in hand before a long press picked a picture up,
	// which comes back the moment the picture is let go of — so pressing on
	// a photo to nudge it, and writing on, never means a trip to the toolbar.
	private toolBeforePickUp: ToolType | null = null;
	private readonly unsubscribeToolState: () => void;
	// A picture finished decoding: it can be drawn now where it was a
	// placeholder. See render.ts.
	private readonly unsubscribePictures: () => void;

	private selection: { pageNumber: number; ids: Set<string> } = { pageNumber: -1, ids: new Set() };
	private drag: { pageNumber: number; mode: DragMode } | null = null;
	private canManagePages = false;
	private isNote = false;
	// Set when the document cannot be safely written to (see
	// src/pdf/compatibility.ts). Every input path checks it, rather than the
	// view simply not attaching gestures, because a book is rendered lazily,
	// page by page, as it is scrolled — a view-level check would not cover
	// the pages mounted later.
	private readOnly = false;
	private eraserCursor: { pageNumber: number; point: Point } | null = null;
	// Each page remembers its own pinch-zoom level independently (see
	// pointer.ts) — the toolbar's zoom readout shows whichever page the view
	// currently considers "current" (getCurrentPage), which in practice is
	// whichever page the user is actually looking at/touching.
	private readonly zoomByPage = new Map<number, number>();
	// Coalesced pointer samples arrive several per animation frame (see
	// annotate/pointer.ts) and each one used to repaint the overlay. The
	// picture can only change once a frame, so the extra repaints were pure
	// cost — more so now that a pressure-varying stroke rebuilds a filled
	// outline from every sample it has.
	private overlayRedrawFrame: number | null = null;
	private overlayRedrawPage: number | null = null;

	constructor(private readonly options: AnnotationControllerOptions = {}) {
		this.toolState = options.toolState ?? new ToolState();
		this.ownsHistory = options.history === undefined;
		this.history = options.history ?? new HistoryStack();
		this.store = new AnnotationStore(
			this.history,
			(pageNumber) => this.redrawBase(pageNumber),
			(pageNumber) => this.options.onAnnotationsChanged?.(pageNumber),
		);
		// Last, because the callback repaints through the store above.
		// Another surface over the same shared selection can change the tool
		// or its style at any time, so reconciling happens here rather than
		// in setTool/setColor/setWidth — a change made through a second ink
		// block's strip has to reach this one's toolbar and overlay too.
		this.unsubscribeToolState = this.toolState.subscribe((change) => {
			if (change === 'tool') {
				this.drag = null;
				const tool = this.toolState.getTool();
				if (tool !== 'select') this.toolBeforePickUp = null;
				// A selection only survives in the one tool that can act on
				// it, and the eraser outline only while the eraser is held.
				if (tool !== 'select') this.selection = { pageNumber: -1, ids: new Set() };
				if (tool !== 'eraser') this.eraserCursor = null;
			}
			this.notify();
			this.redrawAllOverlay();
		});
		this.unsubscribePictures = onPictureDecoded(() => {
			for (const pageNumber of this.pages.keys()) this.redrawBase(pageNumber);
		});
	}

	// ---- Page lifecycle ----

	mountPage(pageNumber: number, host: HTMLElement, width: number, height: number): void {
		this.unmountPage(pageNumber);

		const baseCanvas = host.createEl('canvas', { cls: 'inkling-annotation-layer inkling-annotation-base' });
		baseCanvas.width = width;
		baseCanvas.height = height;

		// The overlay sits on top and is the only one that receives pointer
		// events — the base layer is purely a picture underneath it.
		const overlayCanvas = host.createEl('canvas', { cls: 'inkling-annotation-layer inkling-annotation-overlay' });
		overlayCanvas.width = width;
		overlayCanvas.height = height;

		const base = baseCanvas.getContext('2d');
		if (!base) throw new Error('InklingExpanded: could not acquire a 2D context for the annotation layer.');

		const detach = attachPointerGestures(overlayCanvas, () => this.getHandlersFor(pageNumber));
		this.pages.set(pageNumber, {
			base,
			overlayCanvas,
			overlay: null,
			highlightCanvas: null,
			highlight: null,
			highlightDraft: false,
			width,
			height,
			content: host,
			detach,
		});
		this.redrawBase(pageNumber);
		this.redrawOverlay(pageNumber);
	}

	// Seeds a page with previously-saved annotations (read back from the
	// PDF) — bypasses history/onAnnotationsChanged since this is already
	// persisted state, not a new edit.
	seedPage(pageNumber: number, annotations: Annotation[]): void {
		this.store.seedPage(pageNumber, annotations);
	}

	getPageAnnotations(pageNumber: number): Annotation[] {
		return this.store.getPage(pageNumber);
	}

	// Replaces a page's annotations with ones that came from somewhere else
	// — another device's save, merged in (see pdfView.ts). Not an edit made
	// here, so it is no step of undo; and the page's undo history goes,
	// since every entry in it is a whole page as it was before, and undoing
	// one now would take the other device's ink off with it.
	replacePage(pageNumber: number, annotations: Annotation[]): void {
		if (this.drag?.pageNumber === pageNumber) this.drag = null;
		if (this.selection.pageNumber === pageNumber) this.selection = { pageNumber: -1, ids: new Set() };
		const { undo, redo } = this.history.snapshot();
		const elsewhere = (entry: { pageNumber: number }) => entry.pageNumber !== pageNumber;
		this.history.restore({ undo: undo.filter(elsewhere), redo: redo.filter(elsewhere) });
		this.store.setPageLive(pageNumber, annotations);
		this.redrawOverlay(pageNumber);
		this.notify();
	}

	// Re-backs a page's annotation canvases at a new resolution and swaps in
	// `annotations` already reprojected to match (src/pdfView.ts does that
	// reprojection, via pdf.js's viewport, before calling this — it's the
	// only side that knows about pdf.js viewports at all). Used when a
	// pinch-zoomed page gets re-rendered sharper (see
	// AnnotationControllerOptions.onZoomSettled): setting canvas.width/height
	// clears a canvas's contents as a side effect, and the existing
	// annotations' coordinates would no longer line up with the new
	// resolution's pixel grid regardless, so both need to change together.
	// Goes through the store's live-update path (not commitGesture) since
	// this is purely a resolution/coordinate-space migration — the on-disk
	// PDF-space representation is unchanged, so it must not register as an
	// edit (no history entry, no autosave).
	resizePage(pageNumber: number, width: number, height: number, annotations: Annotation[]): void {
		const mount = this.pages.get(pageNumber);
		if (!mount) return;
		mount.base.canvas.width = width;
		mount.base.canvas.height = height;
		mount.overlayCanvas.width = width;
		mount.overlayCanvas.height = height;
		if (mount.highlightCanvas) {
			mount.highlightCanvas.width = width;
			mount.highlightCanvas.height = height;
		}
		mount.width = width;
		mount.height = height;
		this.store.setPageLive(pageNumber, annotations);
		this.redrawOverlay(pageNumber);
	}

	getCanManagePages(): boolean {
		return this.canManagePages;
	}

	setCanManagePages(value: boolean): void {
		this.canManagePages = value;
		this.notify();
	}

	// Whether this is a note, whose background can be changed — an infinite
	// canvas included, which has no pages to add but has a background.
	setIsNote(value: boolean): void {
		this.isNote = value;
		this.notify();
	}

	// How many pages the surface being annotated has, purely so the toolbar
	// can show a "12 / 195" readout. Not derived from `this.pages` — that map
	// only holds pages currently *mounted*, which for a long PDF is the
	// handful near the viewport (see src/pdfView.ts's page recycling), not
	// the document's length. Defaults to a single page, which is what a
	// Markdown ink block is and always stays.
	private pageCount = 1;

	getPageCount(): number {
		return this.pageCount;
	}

	setPageCount(count: number): void {
		if (count === this.pageCount) return;
		this.pageCount = count;
		this.notify();
	}

	// The page the reader is currently on, as the host view understands it.
	getCurrentPageNumber(): number {
		return this.options.getCurrentPage?.() ?? 1;
	}

	// Repaints the toolbar from state this controller doesn't own and can't
	// observe — the current page number, which changes as the host view is
	// scrolled rather than through any call made here. src/pdfView.ts calls
	// this when its own tracking moves to a different page.
	refreshUi(): void {
		this.notify();
	}

	unmountPage(pageNumber: number): void {
		const mount = this.pages.get(pageNumber);
		if (!mount) return;
		if (this.catcher?.pageNumber === pageNumber) this.hideCatcher();
		if (this.pasteOffer?.pageNumber === pageNumber) this.pasteOffer = null;
		mount.detach();
		mount.base.canvas.remove();
		mount.overlayCanvas.remove();
		mount.highlightCanvas?.remove();
		this.pages.delete(pageNumber);
	}

	unmountAll(): void {
		this.cancelScheduledOverlayRedraw();
		this.cancelLongPress();
		for (const pageNumber of [...this.pages.keys()]) this.unmountPage(pageNumber);
		this.selection = { pageNumber: -1, ids: new Set() };
		this.drag = null;
		this.eraserCursor = null;
		this.zoomByPage.clear();
		if (this.ownsHistory) this.history.clear();
		// The PDF view reuses this controller for every document it shows,
		// and seeds a page from the file only when the file has annotations
		// for it. Anything left here would survive onto a page the file says
		// is blank — which is how "Add page" came up showing the ink of the
		// page that used to have its number, and saved it there on the next
		// stroke.
		this.store.forgetAll();
	}

	// End of life for the controller itself, as distinct from unmounting its
	// pages. The shared ToolState outlives every controller over it, so a
	// controller that stayed subscribed would be kept alive by it — and an
	// ink block, rebuilt on every save, would leak one per stroke burst.
	destroy(): void {
		this.unmountAll();
		this.unsubscribeToolState();
		this.unsubscribePictures();
		this.listeners.clear();
	}

	// ---- Tool / style state ----

	// Pure delegation to the shared ToolState. Everything a *mounted
	// surface* has to do about a change — dropping an in-flight drag,
	// clearing a selection the new tool can't act on, repainting — lives in
	// the subscription set up in the constructor instead, so it happens for
	// a change made through any surface rather than only through this one.
	// The exception is restyling a live selection below, which belongs to
	// the surface the user is actually pointing at.

	getTool(): ToolType {
		return this.toolState.getTool();
	}

	setTool(tool: ToolType): void {
		// Another tool picked up ends a crop, keeping it — as done would.
		if (this.cropping && tool !== this.getTool()) void this.applyCrop();
		this.toolState.setTool(tool);
	}

	// A starting tool for this surface, honoured only until the user picks
	// one — see ToolState.suggestTool.
	suggestTool(tool: ToolType): void {
		this.toolState.suggestTool(tool);
	}

	getColor(): string {
		return this.toolState.getColor();
	}

	setColor(color: string): void {
		this.toolState.setColor(color);
		if (this.selection.ids.size > 0) this.restyleSelection({ color });
	}

	getWidth(): number {
		return this.toolState.getWidth();
	}

	// The toolbar width in a page's own canvas pixels — see getInkScale.
	// What every stroke, shape and eraser on that page is made with; the
	// toolbar and the shared state keep the unscaled number.
	private inkWidth(pageNumber: number): number {
		return this.getWidth() * (this.options.getInkScale?.(pageNumber) ?? 1);
	}

	// The colour a stroke being drawn is made in: the tool in hand's.
	private inkColor(): string {
		return this.getColor();
	}

	setWidth(width: number): void {
		this.toolState.setWidth(width);
		// Clamped by the shared state, so read it back rather than restyling
		// a selection with a value it refused.
		if (this.selection.ids.size > 0) this.restyleSelection({ width: this.inkWidth(this.selection.pageNumber) });
	}

	hasSelection(): boolean {
		return this.selection.ids.size > 0;
	}

	isToolbarCollapsed(): boolean {
		return this.toolState.isToolbarCollapsed();
	}

	setToolbarCollapsed(collapsed: boolean): void {
		this.toolState.setToolbarCollapsed(collapsed);
	}

	getToolbarLayout(): ToolbarLayout {
		return this.toolState.getToolbarLayout();
	}

	setToolbarLayout(layout: ToolbarLayout): void {
		this.toolState.setToolbarLayout(layout);
	}

	isReadOnly(): boolean {
		return this.readOnly;
	}

	setReadOnly(readOnly: boolean): void {
		if (readOnly === this.readOnly) return;
		// Before, so an erase it was carrying still lands.
		if (readOnly) {
			this.hideCatcher();
			this.pasteOffer = null;
		}
		this.readOnly = readOnly;
		if (readOnly) {
			// Nothing selected can be acted on any more, and a half-finished
			// gesture would otherwise commit on pointerup into a file we have
			// just decided not to write to.
			this.drag = null;
			this.selection = { pageNumber: -1, ids: new Set() };
			this.eraserCursor = null;
		}
		this.notify();
		this.redrawAllOverlay();
	}

	// Whether a draw/shape/erase/lasso/move/resize gesture is currently
	// mid-flight on any page — src/pdfView.ts checks this before letting an
	// autosave run, so a save landing exactly when the user has a pen down
	// can't compete with live drawing for the main thread (or, worse,
	// serialize a stroke that isn't finished yet).
	isGestureActive(): boolean {
		return this.drag !== null;
	}

	// The current page's pinch-zoom level (1 = no zoom) — for the toolbar's
	// zoom readout.
	getZoom(): number {
		if (this.options.viewZoom) return this.options.viewZoom.get();
		const pageNumber = this.options.getCurrentPage?.();
		if (pageNumber == null) return 1;
		return this.getPageZoom(pageNumber);
	}

	// Zooms the current page by a factor, about its centre — a toolbar or
	// keyboard zoom has no cursor to aim at, and the middle of the page is
	// what the reader is looking at.
	zoomBy(factor: number): void {
		const viewZoom = this.options.viewZoom;
		if (viewZoom) this.zoomViewAboutCentre(viewZoom, viewZoom.get() * factor);
		else this.zoomCurrentPage((scale) => scale * factor);
	}

	resetZoom(): void {
		const viewZoom = this.options.viewZoom;
		if (viewZoom) this.zoomViewAboutCentre(viewZoom, 1);
		else this.zoomCurrentPage(() => 1);
	}

	// How far the toolbar's buttons can take the zoom. A page zoomed on its
	// own cannot go below its fitted size, which is all the room its frame
	// has; a whole view can, to see more pages at once.
	getZoomRange(): { min: number; max: number } {
		const viewZoom = this.options.viewZoom;
		return viewZoom ? { min: viewZoom.min, max: viewZoom.max } : { min: 1, max: MAX_ZOOM };
	}

	private zoomViewAboutCentre(viewZoom: ViewZoom, scale: number): void {
		const centre = viewZoom.centre();
		viewZoom.zoomTo(scale, viewZoom.anchorAt(centre), centre);
		viewZoom.settle();
		this.notify();
	}

	private zoomCurrentPage(next: (scale: number) => number): void {
		const pageNumber = this.options.getCurrentPage?.();
		if (pageNumber == null) return;
		const mount = this.pages.get(pageNumber);
		const placeholder = mount?.content.parentElement;
		if (!mount || !placeholder) return;

		const rect = placeholder.getBoundingClientRect();
		const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
		const scale = zoomAbout(mount.content, placeholder, next(currentZoom(mount.content)), centre);
		this.zoomByPage.set(pageNumber, scale);
		this.notify();
		// Same signal a settled pinch sends, so the page re-renders at a
		// resolution matching the new zoom rather than staying a blown-up
		// copy of the old raster.
		this.options.onZoomSettled?.(pageNumber, scale);
	}

	// One specific page's zoom level, regardless of which page is current —
	// src/pdfView.ts uses this to leave zoomed pages mounted when it recycles
	// scrolled-away ones, since this state is keyed to a mount that recycling
	// would throw away.
	getPageZoom(pageNumber: number): number {
		return this.zoomByPage.get(pageNumber) ?? 1;
	}

	// The page's zoom and pan, to keep for a surface about to be rebuilt,
	// and to put back on the one that replaces it.
	getPageZoomState(pageNumber: number): ContentZoom | null {
		const mount = this.pages.get(pageNumber);
		return mount ? contentZoom(mount.content) : null;
	}

	restorePageZoom(pageNumber: number, zoom: ContentZoom): void {
		const mount = this.pages.get(pageNumber);
		if (!mount) return;
		setContentZoom(mount.content, zoom);
		this.zoomByPage.set(pageNumber, currentZoom(mount.content));
		this.notify();
	}

	// ---- History ----

	get canUndo(): boolean {
		return this.history.canUndo;
	}

	get canRedo(): boolean {
		return this.history.canRedo;
	}

	undo(): void {
		const pageNumber = this.store.applyUndo();
		this.notify();
		if (pageNumber !== undefined) {
			this.redrawOverlay(pageNumber);
			this.options.onAnnotationsChanged?.(pageNumber);
		}
	}

	redo(): void {
		const pageNumber = this.store.applyRedo();
		this.notify();
		if (pageNumber !== undefined) {
			this.redrawOverlay(pageNumber);
			this.options.onAnnotationsChanged?.(pageNumber);
		}
	}

	// ---- Page-level actions ----

	addPage(): void {
		this.options.onAddPage?.();
	}

	canInvert(): boolean {
		return this.options.onToggleInversion !== undefined;
	}

	isInverted(): boolean {
		return this.options.isInverted?.() ?? false;
	}

	toggleInversion(): void {
		this.options.onToggleInversion?.();
	}

	canTakeNotes(): boolean {
		return this.options.onEditNote !== undefined;
	}

	canNavigate(): boolean {
		return this.options.onGoToPage !== undefined;
	}

	goToPage(pageNumber: number): void {
		const clamped = Math.min(Math.max(Math.round(pageNumber), 1), this.pageCount);
		if (!Number.isFinite(clamped)) return;
		this.options.onGoToPage?.(clamped);
	}

	canToggleNavigation(): boolean {
		return this.options.onToggleNavigation !== undefined;
	}

	toggleNavigation(): void {
		this.options.onToggleNavigation?.();
	}

	clearCurrentPage(): void {
		const pageNumber = this.options.getCurrentPage?.();
		if (pageNumber == null) return;
		this.store.clearPage(pageNumber);
		if (this.selection.pageNumber === pageNumber) this.selection = { pageNumber: -1, ids: new Set() };
		this.redrawOverlay(pageNumber);
		this.notify();
	}

	deleteSelection(): void {
		if (this.selection.ids.size === 0) return;
		const { pageNumber, ids } = this.selection;
		const before = this.store.getPage(pageNumber);
		// A locked picture stays: unlock it first.
		this.store.setPageLive(
			pageNumber,
			before.filter((a) => !ids.has(a.id) || isLockedPicture(a)),
		);
		this.store.commitGesture(pageNumber, before);
		this.selection = { pageNumber: -1, ids: new Set() };
		this.redrawOverlay(pageNumber);
		this.putBackTool();
		this.notify();
	}

	// ---- Subscriptions (toolbar reactivity) ----

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	// ---- Gesture handling ----

	private getHandlersFor(pageNumber: number): GestureHandlers {
		return {
			onStart: (point, event) => this.handleStart(pageNumber, point, event),
			onMove: (point) => this.handleMove(pageNumber, point),
			onEnd: (point, event) => this.handleEnd(pageNumber, point, event),
			onCancel: (event) => this.handleCancel(pageNumber, event),
			onHover: (point) => this.handleHover(pageNumber, point),
			onPenButtons: (point, event) => this.followPenButtons(pageNumber, point, event),
			onZoomChange: (scale) => {
				// A view zoom is the host's to keep. Recording it as this
				// page's own would read as a page pinch-zoomed in its frame,
				// which the PDF view keeps mounted rather than recycling.
				if (!this.options.viewZoom) this.zoomByPage.set(pageNumber, scale);
				this.notify();
			},
			onZoomEnd: (scale) => this.options.onZoomSettled?.(pageNumber, scale),
			viewZoom: this.options.viewZoom,
			touchDraws: () => this.toolState.isTouchDrawing() && !this.readOnly,
			claimsTouch: (point) => this.claimsTouch(pageNumber, point),
			onTouchTap: (point) => this.touchTap(pageNumber, point),
			onAbandon: () => this.abandonGesture(),
		};
	}

	private handleHover(pageNumber: number, point: Point | null): void {
		if (point) this.lastPointer = { pageNumber, point };
		else if (this.lastPointer?.pageNumber === pageNumber) this.lastPointer = null;
		if (this.readOnly) return;
		const wasShowing = this.eraserCursor?.pageNumber === pageNumber;
		if (this.getTool() !== 'eraser' || !point) {
			this.eraserCursor = null;
			if (wasShowing) this.redrawOverlay(pageNumber);
			return;
		}
		this.eraserCursor = { pageNumber, point };
		this.redrawOverlay(pageNumber);
	}

	private handleStart(pageNumber: number, point: Point, event?: PointerEvent): void {
		if (this.readOnly) return;
		// Already seen by the pointer layer, which hands every pen event to
		// followPenButtons first. Here too for a start that did not come
		// through it.
		if (event?.pointerType === 'pen') this.followPenButtons(pageNumber, point, event);
		if (this.cropping) {
			if (this.cropping.pageNumber === pageNumber) {
				this.handleCropStart(pageNumber, point);
				return;
			}
			void this.applyCrop();
		}
		this.lastPointer = { pageNumber, point };
		// A paste on offer is taken by a press on its button, and let go of by
		// a press anywhere else — which then does what it would have.
		if (this.pasteOffer) {
			const offer = this.pasteOffer;
			if (offer.pageNumber === pageNumber && pasteButtonAt(offer.at, this.chromeScale(pageNumber), point)) {
				this.pasteAt(pageNumber, offer.at);
				return;
			}
			this.withdrawPasteOffer();
		}
		// Bound once so the switch below narrows it — a getter call in each
		// case would be opaque to the narrowing and force a cast.
		const tool = this.getTool();
		switch (tool) {
			case 'pen':
			case 'highlighter':
				this.drag = {
					pageNumber,
					mode: { kind: 'draw', tool, points: [this.clampToPage(pageNumber, point)], lastMovedAt: performance.now() },
				};
				break;
			case 'line':
			case 'rectangle':
			case 'oval':
			case 'arrow':
				this.drag = {
					pageNumber,
					mode: { kind: 'shape', tool, start: this.clampToPage(pageNumber, point), end: this.clampToPage(pageNumber, point) },
				};
				break;
			case 'eraser':
				this.drag = { pageNumber, mode: { kind: 'erase', before: this.store.getPage(pageNumber) } };
				this.applyErase(pageNumber, point);
				break;
			case 'note':
				// No drag: a note is placed by tapping, and the gesture ends
				// the moment the editor opens.
				void this.editNoteAt(pageNumber, point, null, '');
				break;
			case 'select':
				this.handleSelectStart(pageNumber, point);
				break;
		}
		if (tool !== 'select' && tool !== 'note') this.watchForLongPress(pageNumber, point);
		this.redrawOverlay(pageNumber);
	}

	// See GestureHandlers.claimsTouch: a finger on what a selection offers to
	// touch — its frame, its handles, a picture's buttons — works it, as a pen
	// would.
	private claimsTouch(pageNumber: number, point: Point): boolean {
		// A finger takes a paste on offer as a pen does.
		const offer = this.pasteOffer;
		if (offer?.pageNumber === pageNumber && pasteButtonAt(offer.at, this.chromeScale(pageNumber), point)) return true;
		// A finger works a crop's grips and buttons as a pen does — and a
		// press beside it is the finger's to scroll with, or to tap done.
		const crop = this.cropping;
		if (crop && crop.pageNumber === pageNumber) {
			const chrome = this.chromeScale(pageNumber);
			return !!cropButtonAt(crop.rect, chrome, point) || !!cropHandleAt(crop.rect, chrome, point);
		}
		if (this.readOnly || this.getTool() !== 'select' || this.selection.pageNumber !== pageNumber) return false;
		const selected = this.store.getPage(pageNumber).filter((a) => this.selection.ids.has(a.id));
		if (selected.length === 0) return false;
		const box = unionBoundingBox(selected.map(boundingBox));
		const chrome = this.chromeScale(pageNumber);
		if (selectionButtonAt(box, chrome, point, selected)) return true;
		// A locked picture does not move, so a finger on it scrolls.
		if (selected.some(isLockedPicture)) return false;
		if (handleAt(box, chrome, point)) return true;
		return pointInRect(point, selectionFrame(box, chrome));
	}

	// Lets go of whatever is selected — a tap beside it, or Escape.
	clearSelection(): boolean {
		if (this.pasteOffer) {
			this.withdrawPasteOffer();
			return true;
		}
		// Escape while cropping leaves the picture as it was, and selected.
		if (this.cropping) {
			this.cancelCrop();
			return true;
		}
		if (this.selection.ids.size === 0) return false;
		const pageNumber = this.selection.pageNumber;
		this.selection = { pageNumber: -1, ids: new Set() };
		this.redrawOverlay(pageNumber);
		this.putBackTool();
		this.notify();
		return true;
	}

	private putBackTool(): void {
		const tool = this.toolBeforePickUp;
		this.toolBeforePickUp = null;
		if (tool) this.setTool(tool);
	}

	// A finger's tap on a page. Beside a selection it lets go of it — a pen
	// does the same by starting a lasso there. With the lasso in hand and
	// nothing selected, it picks out the drawing under it, as a pen's tap does.
	touchTap(pageNumber: number, point: Point): void {
		if (this.readOnly) return;
		if (this.pasteOffer) {
			const offer = this.pasteOffer;
			if (offer.pageNumber === pageNumber && pasteButtonAt(offer.at, this.chromeScale(pageNumber), point)) {
				this.pasteAt(pageNumber, offer.at);
				return;
			}
			this.withdrawPasteOffer();
		}
		// A tap beside a crop is done with it.
		if (this.cropping) {
			const chrome = this.chromeScale(this.cropping.pageNumber);
			const on = this.cropping.pageNumber === pageNumber && (cropButtonAt(this.cropping.rect, chrome, point) || cropHandleAt(this.cropping.rect, chrome, point));
			if (!on) void this.applyCrop();
			return;
		}
		if (this.selection.ids.size > 0) {
			this.clearSelection();
			return;
		}
		if (this.getTool() !== 'select') return;
		const hit = [...this.store.getPage(pageNumber)].reverse().find((a) => hitTestAnnotation(a, point));
		if (!hit || hit.kind === 'note') return;
		this.selection = { pageNumber, ids: new Set([hit.id]) };
		this.redrawOverlay(pageNumber);
		this.notify();
	}

	// Picks up the picture under a point, if there is one: selected, with the
	// lasso in hand, ready to move or size. A long press does this, with a
	// pen (below) or a finger (the host's, see pdfView.ts).
	pickUpPictureAt(pageNumber: number, point: Point): boolean {
		if (this.readOnly || this.cropping) return false;
		const picture = [...this.store.getPage(pageNumber)]
			.reverse()
			.find((a) => a.kind === 'image' && pointInRect(point, boundingBox(a)));
		if (!picture) return false;
		this.cancelLongPress();
		this.drag = null;
		const previous = this.getTool();
		this.setTool('select');
		if (previous !== 'select') this.toolBeforePickUp = previous;
		this.selection = { pageNumber, ids: new Set([picture.id]) };
		this.redrawOverlay(pageNumber);
		this.notify();
		return true;
	}

	private watchForLongPress(pageNumber: number, point: Point): void {
		this.cancelLongPress();
		const picture = [...this.store.getPage(pageNumber)]
			.reverse()
			.find((a) => a.kind === 'image' && pointInRect(point, boundingBox(a)));
		if (!picture) return;
		const timer = window.setTimeout(() => {
			this.longPress = null;
			// Still down, and still where it started: not ink after all. What
			// it had begun to draw goes, and the picture is picked up.
			if (this.drag?.pageNumber !== pageNumber) return;
			this.pickUpPictureAt(pageNumber, point);
		}, LONG_PRESS_MS);
		this.longPress = { pageNumber, at: point, timer };
	}

	private cancelLongPress(): void {
		if (this.longPress) window.clearTimeout(this.longPress.timer);
		this.longPress = null;
	}

	// ---- Cropping a picture ----
	//
	// The crop button on a picture's bar starts it: the whole picture to
	// begin with, cut in from its corners and edges, slid about inside it,
	// and done (the check, or a tap beside it) or cancelled (the cross, or
	// Escape). Done cuts the picture's pixels down to the crop — see
	// pictureCrop.ts — as one step of undo.

	isCropping(): boolean {
		return this.cropping !== null;
	}

	private startCrop(pageNumber: number, picture: Annotation): void {
		if (this.readOnly) return;
		const box = boundingBox(picture);
		this.cropping = { pageNumber, id: picture.id, picture: box, rect: { ...box } };
		this.redrawOverlay(pageNumber);
		this.notify();
	}

	private handleCropStart(pageNumber: number, point: Point): void {
		const crop = this.cropping;
		if (!crop) return;
		const chrome = this.chromeScale(pageNumber);
		const button = cropButtonAt(crop.rect, chrome, point);
		if (button === 'apply') {
			void this.applyCrop();
			return;
		}
		if (button === 'cancel') {
			this.cancelCrop();
			return;
		}
		const handle = cropHandleAt(crop.rect, chrome, point);
		if (handle) {
			this.drag = { pageNumber, mode: { kind: 'crop', handle, origin: point, start: { ...crop.rect } } };
			return;
		}
		// Beside it: done, and that press is only that.
		void this.applyCrop();
	}

	// The crop as the grip being dragged makes it: kept inside the picture,
	// and never smaller than MIN_CROP on screen (or the picture, if that is
	// smaller still).
	private moveCrop(pageNumber: number, mode: Extract<DragMode, { kind: 'crop' }>, point: Point): void {
		const crop = this.cropping;
		if (!crop) return;
		const { picture } = crop;
		const dx = point.x - mode.origin.x;
		const dy = point.y - mode.origin.y;
		const start = mode.start;
		const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));
		let { minX, minY, maxX, maxY } = start;
		if (mode.handle === 'inside') {
			const width = maxX - minX;
			const height = maxY - minY;
			minX = clamp(start.minX + dx, picture.minX, picture.maxX - width);
			minY = clamp(start.minY + dy, picture.minY, picture.maxY - height);
			maxX = minX + width;
			maxY = minY + height;
		} else {
			const chrome = this.chromeScale(pageNumber);
			const least = Math.min(MIN_CROP * chrome, picture.maxX - picture.minX, picture.maxY - picture.minY);
			const handle = mode.handle;
			if (handle.includes('w')) minX = clamp(start.minX + dx, picture.minX, start.maxX - least);
			if (handle.includes('e')) maxX = clamp(start.maxX + dx, start.minX + least, picture.maxX);
			if (handle.includes('n')) minY = clamp(start.minY + dy, picture.minY, start.maxY - least);
			if (handle.includes('s')) maxY = clamp(start.maxY + dy, start.minY + least, picture.maxY);
		}
		crop.rect = { minX, minY, maxX, maxY };
		this.scheduleOverlayRedraw(pageNumber);
	}

	private cancelCrop(): void {
		const crop = this.cropping;
		if (!crop) return;
		this.cropping = null;
		if (this.drag?.mode.kind === 'crop') this.drag = null;
		this.redrawOverlay(crop.pageNumber);
		this.notify();
	}

	private async applyCrop(): Promise<void> {
		const crop = this.cropping;
		if (!crop) return;
		this.cropping = null;
		if (this.drag?.mode.kind === 'crop') this.drag = null;
		const { pageNumber, id } = crop;
		this.redrawOverlay(pageNumber);
		this.notify();

		const picture = this.store.getPage(pageNumber).find((a) => a.id === id);
		if (!picture || picture.kind !== 'image' || this.readOnly) return;
		const shown = boundingBox(picture);
		const region = cropRegion(picture.picture, shown, crop.rect);
		// All of it kept: nothing to do.
		if (region.x === 0 && region.y === 0 && region.width === picture.picture.width && region.height === picture.picture.height) return;
		try {
			const doc = this.pages.get(pageNumber)?.base.canvas.ownerDocument ?? document;
			const pixels = await cropPicture(picture.picture, region, doc);
			const before = this.store.getPage(pageNumber);
			const current = before.find((a) => a.id === id);
			// Moved, sized, cropped or gone in the meantime — from another
			// device, or by undo: what was cropped is not there any more.
			if (!current || current.kind !== 'image' || current.picture !== picture.picture || current.start !== picture.start) return;
			// Exactly where the kept pixels were on the page, which a crop
			// rounded out to whole pixels can be a hair beyond the crop drawn.
			const scaleX = (shown.maxX - shown.minX) / picture.picture.width;
			const scaleY = (shown.maxY - shown.minY) / picture.picture.height;
			const start = { x: shown.minX + region.x * scaleX, y: shown.minY + region.y * scaleY };
			const end = { x: start.x + region.width * scaleX, y: start.y + region.height * scaleY };
			this.store.setPageLive(
				pageNumber,
				before.map((a) => (a.id === id ? { ...current, start, end, picture: pixels } : a)),
			);
			this.store.commitGesture(pageNumber, before);
			this.selection = { pageNumber, ids: new Set([id]) };
		} catch (error) {
			console.error('InklingExpanded: could not crop a picture.', error);
			new Notice('InklingExpanded: could not crop the picture.');
		}
		this.redrawOverlay(pageNumber);
		this.notify();
	}

	// Locks a picture in place, or frees it — one step of undo, and saved.
	toggleLock(pageNumber: number, id: string): void {
		if (this.readOnly) return;
		const before = this.store.getPage(pageNumber);
		this.store.setPageLive(
			pageNumber,
			before.map((a) => (a.id === id && a.kind === 'image' ? { ...a, locked: !a.locked } : a)),
		);
		this.store.commitGesture(pageNumber, before);
		this.redrawOverlay(pageNumber);
		this.notify();
	}

	// What a stylus's own controls say.
	//
	// An eraser end (button 5, bit 32) always erases, the way it does on
	// paper. A side button does what the settings say, and comes in two
	// forms:
	//   - Windows, Wacom and most pens elsewhere report it as the right
	//     button: bit 2 of `buttons`. `button` is the one that changed, which
	//     on a pointerup or a move is as likely the side button being let
	//     go, so it is read only on a pointerdown. Held, it lends its tool.
	//   - Android's web view (Obsidian's on every Android tablet — Samsung's
	//     S Pen, Xiaomi's and Lenovo's pens alike) reports it as the *left*
	//     button, bit 1 — the same as the tip on the glass: Chromium maps
	//     BUTTON_STYLUS_PRIMARY to it. Only a pen hovering, with no pressure,
	//     tells them apart. And a pen that touches down with it held never
	//     reaches the page at all: Chromium keeps that touch for selecting
	//     text (StylusTextSelector), which is why holding it to erase froze
	//     the eraser where the pen came down. So while it is held a layer of
	//     text for that selection lies over the page, and the selection is
	//     what says where the pen is — see selectionCatcher.ts.
	//
	// A pen only. A mouse's right button is not a stylus button, and is left
	// to do nothing here.
	private readPenButtons(event: PointerEvent | undefined): PenButtons {
		if (!event || event.pointerType !== 'pen') return { kind: 'unknown' };
		const pressed = event.type === 'pointerdown' ? event.button : -1;
		if (pressed === 5 || (event.buttons & 32) !== 0) return { kind: 'held', tool: 'eraser' };
		const action = this.options.getPenButtonAction?.() ?? 'eraser';
		const lifted = event.type === 'pointerup' || event.type === 'pointercancel' || event.type === 'pointerleave';
		const hovering = !(event.pressure > 0) && !lifted;
		if (pressed === 2 || (event.buttons & 2) !== 0) return action === 'none' ? { kind: 'unknown' } : { kind: 'held', tool: action };
		if (hovering && (event.buttons & 1) !== 0) return action === 'none' ? { kind: 'unknown' } : { kind: 'air-press', tool: action };
		return hovering ? { kind: 'hover-free' } : { kind: 'free' };
	}

	// A stylus button is a tool held, as in Samsung Notes: the toolbar shows
	// the eraser (or whatever the button is set to) from the moment it is
	// pressed — in the air, before writing or in the middle of it — and
	// letting go gives the pen back once the tip is off the glass, so a
	// stroke being erased is not cut short. The lasso is picked up for good:
	// it is more than one gesture — draw round, then drag.
	private followPenButtons(pageNumber: number, point: Point, event: PointerEvent): void {
		if (this.readOnly) return;
		const reading = this.readPenButtons(event);
		switch (reading.kind) {
			case 'unknown':
				return;
			case 'air-press':
				this.holdForAirPress(pageNumber, point, reading.tool);
				return;
			case 'hover-free':
				this.hideCatcher();
				this.putBackButtonTool(pageNumber, point);
				return;
			case 'free':
				this.putBackButtonTool(pageNumber, event.type === 'pointerleave' ? null : point);
				return;
			case 'held':
				break;
		}
		const bound = reading.tool;
		const tool = this.getTool();
		if (tool === bound) return;
		const mode = this.drag?.mode.kind;
		// Pressed in the middle of a selection being drawn, moved or sized:
		// left until the pen lifts.
		if (mode && mode !== 'draw' && mode !== 'shape') return;
		if (mode) this.handleEnd(pageNumber, point);
		if (bound === 'select') {
			this.toolUnderButton = null;
			this.setTool('select');
		} else {
			this.toolUnderButton ??= tool;
			this.setTool(bound);
		}
		// Pressed mid-stroke: what was drawn stays, and the rest of the
		// stroke is the button's.
		if (mode) this.handleStart(pageNumber, point);
		this.handleHover(pageNumber, point);
	}

	// Android's side button, held with the pen in the air: its tool in hand
	// for as long as it is, and — for the eraser — the layer that lets a pen
	// touching down with it held be followed at all.
	private holdForAirPress(pageNumber: number, point: Point, bound: ButtonTool): void {
		if (this.drag && this.drag.mode.kind !== 'erase') return;
		const tool = this.getTool();
		if (bound === 'select') {
			if (tool !== 'select') {
				this.toolUnderButton = null;
				this.setTool('select');
			}
		} else if (tool !== bound) {
			this.toolUnderButton ??= tool;
			this.setTool(bound);
		}
		if (bound === 'eraser') this.showCatcher(pageNumber);
		this.handleHover(pageNumber, point);
	}

	private showCatcher(pageNumber: number): void {
		if (this.catcher?.pageNumber === pageNumber) return;
		this.hideCatcher();
		const mount = this.pages.get(pageNumber);
		if (!mount) return;
		const canvas = mount.overlayCanvas;
		const detach = attachSelectionCatcher(mount.content, canvas, {
			onPoint: (point) => this.eraseWithCatcher(pageNumber, point),
			onEnd: () => this.endCatcherErase(pageNumber),
			onPointer: (event) => {
				const box = canvas.getBoundingClientRect();
				const point = {
					x: (event.clientX - box.left) * (box.width > 0 ? canvas.width / box.width : 1),
					y: (event.clientY - box.top) * (box.height > 0 ? canvas.height / box.height : 1),
				};
				if (event.type === 'pointerleave') {
					this.handleHover(pageNumber, null);
					return;
				}
				// A tip that came down on the layer itself: the button was let go
				// on the way down. The layer goes, and the next stroke is the
				// tool's own.
				if (event.type === 'pointerdown' && event.pressure > 0) {
					this.hideCatcher();
					this.putBackButtonTool(pageNumber, point);
					return;
				}
				this.followPenButtons(pageNumber, point, event);
				if (this.catcher) this.handleHover(pageNumber, point);
			},
		});
		this.catcher = { pageNumber, detach };
	}

	private hideCatcher(): void {
		const catcher = this.catcher;
		if (!catcher) return;
		this.catcher = null;
		// Ends, and so commits, an erase the selection was carrying.
		catcher.detach();
	}

	// The pen, held down with the side button, at `point`: erased along the
	// way from where it last was — the selection moves a cell at a time, and
	// a fast pen skips cells.
	private eraseWithCatcher(pageNumber: number, point: Point): void {
		if (this.readOnly) return;
		if (!this.drag) {
			this.drag = { pageNumber, mode: { kind: 'erase', before: this.store.getPage(pageNumber) } };
			this.catcherLast = null;
		}
		if (this.drag.pageNumber !== pageNumber || this.drag.mode.kind !== 'erase') return;
		const from = this.catcherLast ?? point;
		const step = Math.max(this.eraserRadius(pageNumber) / 2, 1);
		const steps = Math.max(1, Math.ceil(distance(from, point) / step));
		for (let index = 1; index <= steps; index++) {
			const t = index / steps;
			this.applyErase(pageNumber, { x: from.x + (point.x - from.x) * t, y: from.y + (point.y - from.y) * t });
		}
		this.catcherLast = point;
		this.eraserCursor = { pageNumber, point };
		this.scheduleOverlayRedraw(pageNumber);
	}

	private endCatcherErase(pageNumber: number): void {
		this.catcherLast = null;
		const drag = this.drag;
		if (!drag || drag.pageNumber !== pageNumber || drag.mode.kind !== 'erase') return;
		this.store.commitGesture(pageNumber, drag.mode.before);
		this.drag = null;
		this.redrawOverlay(pageNumber);
		this.notify();
	}

	// `at` is where the pen is, when it is over the page: the tool put back
	// shows its cursor there at once — the eraser's ring, if that is the one
	// in hand again — rather than only once the pen next moves.
	private putBackButtonTool(pageNumber: number, at: Point | null = null): void {
		if (this.toolUnderButton === null || this.drag) return;
		const tool = this.toolUnderButton;
		this.toolUnderButton = null;
		this.setTool(tool);
		this.handleHover(pageNumber, at);
	}

	// Drops the gesture under way without committing any of it — a finger
	// that began to draw and turned out to be one of two starting a pinch.
	abandonGesture(): void {
		this.cancelLongPress();
		const drag = this.drag;
		if (!drag) return;
		if (drag.mode.kind === 'erase' || drag.mode.kind === 'move' || drag.mode.kind === 'resize') {
			this.store.setPageLive(drag.pageNumber, drag.mode.before);
		}
		this.drag = null;
		this.redrawOverlay(drag.pageNumber);
		this.notify();
	}

	isTouchDrawing(): boolean {
		return this.toolState.isTouchDrawing();
	}

	setTouchDrawing(on: boolean): void {
		this.toolState.setTouchDrawing(on);
	}

	private handleSelectStart(pageNumber: number, point: Point): void {
		const annotations = this.store.getPage(pageNumber);

		if (this.selection.pageNumber === pageNumber && this.selection.ids.size > 0) {
			const ids = [...this.selection.ids];
			const selected = annotations.filter((a) => this.selection.ids.has(a.id));
			const boxes = selected.map(boundingBox);
			const [only] = selected;
			if (boxes.length > 0) {
				const box = unionBoundingBox(boxes);
				const chrome = this.chromeScale(pageNumber);
				const button = selectionButtonAt(box, chrome, point, selected);
				if (button === 'copy') {
					this.copySelection();
					return;
				}
				if (button === 'lock' && only) {
					this.toggleLock(pageNumber, only.id);
					return;
				}
				if (button === 'delete') {
					// Greyed out while locked, and does nothing then.
					if (!selected.some(isLockedPicture)) this.deleteSelection();
					return;
				}
				if (button === 'crop') {
					if (only?.kind === 'image' && !only.locked) this.startCrop(pageNumber, only);
					return;
				}
			}
			// A locked picture stays put: a press inside its frame begins a
			// lasso like a press anywhere else, which is what lets the writing
			// on a locked picture be picked up without it.
			if (boxes.length > 0 && !selected.some(isLockedPicture)) {
				const box = unionBoundingBox(boxes);
				const chrome = this.chromeScale(pageNumber);
				const handle = handleAt(box, chrome, point);
				if (handle) {
					this.drag = {
						pageNumber,
						mode: { kind: 'resize', before: annotations, ids, box, handle, anchor: oppositeCorner(box, handle) },
					};
					return;
				}
				// Anywhere inside the frame drags the whole selection, not only
				// a press that lands on a line of it: the gaps between letters
				// are most of a selected word, and a drag that started in one
				// used to throw the selection away and begin a new lasso.
				const frame = selectionFrame(box, chrome);
				if (point.x >= frame.minX && point.x <= frame.maxX && point.y >= frame.minY && point.y <= frame.maxY) {
					this.drag = { pageNumber, mode: { kind: 'move', before: annotations, ids, origin: point, box } };
					return;
				}
			}
		}

		// A picture picked up by a long press is let go of by a press beside
		// it, and the tool from before comes back — that press is only that.
		if (this.toolBeforePickUp) {
			this.clearSelection();
			return;
		}

		// Everywhere else the lasso is drawn, the way a pen draws — on ink or
		// beside it. A press that landed on a line used to pick that line up
		// and drag it instead, so a loop begun on the very writing it was
		// meant to go round moved the first letter. What a tap does is
		// decided when it lifts (see handleEnd).
		this.selection = { pageNumber, ids: new Set() };
		this.drag = { pageNumber, mode: { kind: 'lasso', points: [point] } };
		this.watchForPasteHold(pageNumber, point);
		this.notify();
	}

	// ---- Copy and paste ----
	//
	// A selection's bar has a copy button; Ctrl/Cmd+C does the same, and X
	// cuts. To paste, the lasso is held still on the spot — pen or finger —
	// and a paste button comes up there; Ctrl/Cmd+V pastes where the pointer
	// is. A paste is new ink, one step of undo, and comes selected, to be
	// moved or sized into place.

	hasCopied(): boolean {
		return clipboard !== null;
	}

	copySelection(): boolean {
		const { pageNumber, ids } = this.selection;
		if (ids.size === 0) return false;
		const selected = this.store.getPage(pageNumber).filter((a) => ids.has(a.id));
		if (selected.length === 0) return false;
		clipboard = { annotations: selected, unit: this.unitScale(pageNumber) };
		if (pasteHintShown) new Notice('Copied.', 1500);
		else {
			pasteHintShown = true;
			new Notice('Copied. To paste, hold the lasso on the spot it should go — or press Ctrl+V — and tap the paste button.', 6000);
		}
		this.notify();
		return true;
	}

	cutSelection(): boolean {
		if (this.readOnly || !this.copySelection()) return false;
		this.deleteSelection();
		return true;
	}

	// Offers a paste at a spot: a button there, which pastes when pressed.
	offerPasteAt(pageNumber: number, point: Point): boolean {
		if (this.readOnly || !clipboard || !this.pages.has(pageNumber)) return false;
		const previous = this.pasteOffer?.pageNumber;
		this.pasteOffer = { pageNumber, at: point };
		if (previous !== undefined && previous !== pageNumber) this.redrawOverlay(previous);
		this.redrawOverlay(pageNumber);
		return true;
	}

	private withdrawPasteOffer(): void {
		const offer = this.pasteOffer;
		if (!offer) return;
		this.pasteOffer = null;
		this.redrawOverlay(offer.pageNumber);
	}

	// Where a pen or mouse is over a page, if it is — for a paste from the
	// keyboard.
	pointerPosition(): { pageNumber: number; point: Point } | null {
		const at = this.lastPointer;
		return at && this.pages.has(at.pageNumber) ? at : null;
	}

	// The copy, centred on `point` and kept on the page: new ids, the size
	// it had where it was copied, unlocked, and selected.
	pasteAt(pageNumber: number, point: Point): boolean {
		const copied = clipboard;
		const mount = this.pages.get(pageNumber);
		if (this.readOnly || !copied || !mount) return false;
		this.withdrawPasteOffer();
		const factor = this.unitScale(pageNumber) / copied.unit;
		const origin = { x: 0, y: 0 };
		const sized = copied.annotations.map((a) => (factor === 1 ? a : scaleAnnotationAbout(a, origin, factor)));
		const box = unionBoundingBox(sized.map(boundingBox));
		const width = box.maxX - box.minX;
		const height = box.maxY - box.minY;
		// Centred where asked, then moved back onto the page — to its top or
		// left edge if it is larger than the page.
		const keep = (start: number, size: number, room: number) => Math.max(0, Math.min(start, room - size));
		const left = keep(point.x - width / 2, width, mount.width);
		const top = keep(point.y - height / 2, height, mount.height);
		const pasted = sized.map((a) => {
			const moved = translateAnnotation(a, left - box.minX, top - box.minY);
			return moved.kind === 'image' ? { ...moved, id: createId(), locked: false } : { ...moved, id: createId() };
		});
		this.cancelLongPress();
		this.drag = null;
		const previous = this.getTool();
		this.setTool('select');
		if (previous !== 'select') this.toolBeforePickUp ??= previous;
		this.commitNew(pageNumber, pasted);
		this.selection = { pageNumber, ids: new Set(pasted.map((a) => a.id)) };
		this.redrawOverlay(pageNumber);
		this.notify();
		return true;
	}

	private unitScale(pageNumber: number): number {
		const scale = this.options.getUnitScale?.(pageNumber) ?? 1;
		return Number.isFinite(scale) && scale > 0 ? scale : 1;
	}

	// The lasso held still where it came down, with something copied: not a
	// loop after all, but a paste being asked for there.
	private watchForPasteHold(pageNumber: number, point: Point): void {
		if (!clipboard || this.readOnly) return;
		this.cancelLongPress();
		const timer = window.setTimeout(() => {
			this.longPress = null;
			const drag = this.drag;
			if (drag?.pageNumber !== pageNumber || drag.mode.kind !== 'lasso') return;
			this.drag = null;
			this.selection = { pageNumber: -1, ids: new Set() };
			this.offerPasteAt(pageNumber, point);
			this.notify();
		}, LONG_PRESS_MS);
		this.longPress = { pageNumber, at: point, timer };
	}

	// Keeps a drawn point inside the page it is being drawn on.
	//
	// Only drawing is clamped. Erasing and lassoing outside the surface are
	// harmless — there is nothing out there to act on — and clamping a move
	// or resize would change what dragging a selection does, which is a
	// separate decision from this one.
	//
	// The surface's own pixel size is the bound, which is the same space the
	// incoming point is already in: annotate/pointer.ts maps client
	// coordinates through the canvas's displayed size to its backing store,
	// so a zoomed or stretched surface is already accounted for by the time
	// a point arrives here.
	// The two clamps a selection needs, against the same bounds drawing uses.
	// Both no-op when the page is not mounted, since there is then nothing to
	// measure against and refusing to move would be worse than not clamping.
	private clampMove(pageNumber: number, box: Rect, dx: number, dy: number): { dx: number; dy: number } {
		const mount = this.pages.get(pageNumber);
		if (!mount) return { dx, dy };
		return clampTranslation(box, dx, dy, mount.base.canvas.width, mount.base.canvas.height);
	}

	// How much a corner drag scales the selection: how far along the line
	// from the fixed corner through the dragged one the pointer has got.
	// One factor for both directions, so handwriting keeps its proportions
	// — dragging a corner out makes the writing bigger, never wider.
	//
	// Kept to the page: no larger than leaves every edge on it, and no
	// smaller than a few screen pixels, past which a selection could not be
	// found again to undo the shrink.
	private resizeFactor(pageNumber: number, mode: { box: Rect; handle: HandleName; anchor: Point }, point: Point): number {
		const corner = oppositeCorner(mode.box, oppositeHandle(mode.handle));
		const reach = { x: corner.x - mode.anchor.x, y: corner.y - mode.anchor.y };
		const lengthSquared = reach.x * reach.x + reach.y * reach.y;
		if (lengthSquared === 0) return 1;
		let factor = ((point.x - mode.anchor.x) * reach.x + (point.y - mode.anchor.y) * reach.y) / lengthSquared;

		const size = Math.max(mode.box.maxX - mode.box.minX, mode.box.maxY - mode.box.minY);
		if (size > 0) factor = Math.max(factor, (MIN_SELECTION_SIZE * this.chromeScale(pageNumber)) / size);

		const mount = this.pages.get(pageNumber);
		if (mount) {
			const { width, height } = mount.base.canvas;
			// The largest factor that keeps each edge of the box on the page,
			// scaling about the anchor.
			const limit = (from: number, edge: number, bound: number) => {
				const offset = edge - from;
				if (offset > 0) return (bound - from) / offset;
				if (offset < 0) return (0 - from) / offset;
				return Infinity;
			};
			factor = Math.min(
				factor,
				limit(mode.anchor.x, mode.box.minX, width),
				limit(mode.anchor.x, mode.box.maxX, width),
				limit(mode.anchor.y, mode.box.minY, height),
				limit(mode.anchor.y, mode.box.maxY, height),
			);
		}
		return factor;
	}

	// Canvas pixels per screen pixel on this page — what the selection's
	// frame and handles are sized by, so they are the same size on every
	// screen and at every zoom. See the selection notes in render.ts.
	private chromeScale(pageNumber: number): number {
		const mount = this.pages.get(pageNumber);
		if (!mount) return 1;
		const shown = mount.overlayCanvas.getBoundingClientRect().width;
		return shown > 0 ? mount.overlayCanvas.width / shown : 1;
	}

	private clampToPage(pageNumber: number, point: Point): Point {
		const mount = this.pages.get(pageNumber);
		if (!mount) return point;
		return clampPointToBounds(point, mount.base.canvas.width, mount.base.canvas.height);
	}

	private handleMove(pageNumber: number, point: Point): void {
		if (this.readOnly) return;
		const press = this.longPress;
		if (press && Math.hypot(point.x - press.at.x, point.y - press.at.y) > LONG_PRESS_SLOP * this.chromeScale(pageNumber)) {
			this.cancelLongPress();
		}
		if (!this.drag || this.drag.pageNumber !== pageNumber) return;
		const mode = this.drag.mode;

		switch (mode.kind) {
			case 'draw': {
				// Only movement that goes somewhere counts as movement: a pen
				// resting on glass still reports a jittery stream of samples,
				// and treating those as motion would mean the hold gesture
				// could never be performed at all.
				const clamped = this.clampToPage(pageNumber, point);
				const previous = mode.points[mode.points.length - 1];
				if (!previous || Math.hypot(clamped.x - previous.x, clamped.y - previous.y) > HOLD_STILLNESS_PX) {
					mode.lastMovedAt = performance.now();
				}
				mode.points.push(clamped);
				this.scheduleOverlayRedraw(pageNumber);
				break;
			}
			case 'shape':
				mode.end = this.clampToPage(pageNumber, point);
				this.redrawOverlay(pageNumber);
				break;
			case 'erase':
				this.applyErase(pageNumber, point);
				break;
			case 'lasso':
				mode.points.push(point);
				this.redrawOverlay(pageNumber);
				break;
			case 'move': {
				// Limited by where the selection would end up, not by where
				// the pointer is: see clampTranslation. Dragging a selection
				// off the page used to leave it there, invisible only because
				// a canvas discards what falls off it — the same way drawing
				// off the edge did before it was clamped.
				const { dx, dy } = this.clampMove(
					pageNumber,
					mode.box,
					point.x - mode.origin.x,
					point.y - mode.origin.y,
				);
				const next = mode.before.map((a) => (mode.ids.includes(a.id) ? translateAnnotation(a, dx, dy) : a));
				this.store.setPageLive(pageNumber, next);
				// The ring and frame are drawn from where the selection is now,
				// on the live layer, which nothing else repaints during a drag:
				// without this they stayed where the drag began until the pen
				// lifted.
				this.scheduleOverlayRedraw(pageNumber);
				break;
			}
			case 'crop':
				this.moveCrop(pageNumber, mode, point);
				break;
			case 'resize': {
				const factor = this.resizeFactor(pageNumber, mode, point);
				const next = mode.before.map((a) => (mode.ids.includes(a.id) ? scaleAnnotationAbout(a, mode.anchor, factor) : a));
				this.store.setPageLive(pageNumber, next);
				this.scheduleOverlayRedraw(pageNumber);
				break;
			}
		}
	}

	private handleEnd(pageNumber: number, point: Point, event?: PointerEvent): void {
		this.cancelLongPress();
		if (this.readOnly) return;
		if (!this.drag || this.drag.pageNumber !== pageNumber) return;
		const mode = this.drag.mode;

		switch (mode.kind) {
			case 'draw': {
				mode.points.push(this.clampToPage(pageNumber, point));
				if (mode.points.length >= 2) this.commitDrawStroke(pageNumber, mode);
				break;
			}
			case 'shape': {
				mode.end = this.clampToPage(pageNumber, point);
				if (distance(mode.start, mode.end) > 2) this.commitNew(pageNumber, this.shapeFromDraft(pageNumber, mode));
				break;
			}
			case 'erase':
				this.store.commitGesture(pageNumber, mode.before);
				break;
			case 'lasso': {
				const polygon = [...mode.points, point];
				const annotations = this.store.getPage(pageNumber);
				if (isTap(polygon, TAP_SLOP * this.chromeScale(pageNumber))) {
					// A tap rather than a loop: it picks out the one drawing under
					// it, or reopens a note to correct it.
					const hit = [...annotations].reverse().find((a) => hitTestAnnotation(a, point));
					if (hit?.kind === 'note') void this.editNoteAt(pageNumber, hit.at, hit, hit.note);
					else if (hit) this.selection = { pageNumber, ids: new Set([hit.id]) };
					break;
				}
				const hits = annotations.filter((a) => polygonSelectsAnnotation(a, polygon));
				this.selection = { pageNumber, ids: new Set(hits.map((a) => a.id)) };
				break;
			}
			case 'move':
				this.store.commitGesture(pageNumber, mode.before);
				// Put down where it was taken: done with, so no longer selected.
				// The ring and frame go with the lifting of the pen rather than
				// staying behind for a second tap to clear.
				this.selection = { pageNumber: -1, ids: new Set() };
				this.putBackTool();
				break;
			case 'resize':
				// Still selected, so it can be sized again or moved into place.
				this.store.commitGesture(pageNumber, mode.before);
				break;
		}

		this.drag = null;
		this.redrawOverlay(pageNumber);
		this.notify();
		if (event?.pointerType === 'pen') this.followPenButtons(pageNumber, point, event);
	}

	// A pointercancel — the browser deciding mid-gesture to hand the pointer
	// off to a native action (scrolling being the main real-world case; see
	// src/annotate/pointer.ts) — ends a gesture the same way a pointerup
	// would for draw/shape: keep whatever was drawn so far rather than
	// throwing it away, since from the user's perspective they were still
	// mid-stroke, not cancelling on purpose. Erasing is kept for the same
	// reason: Android cancels a stylus gesture made with the side button
	// held — the button is its own text-selection gesture there — and
	// reverting it made the side button seem not to erase at all. Move and
	// resize still revert, since a selection half-moved is safer to undo
	// than to leave where the cancel caught it.
	private handleCancel(pageNumber: number, event?: PointerEvent): void {
		this.cancelLongPress();
		// Included deliberately: this is the path a palm rejection or a lost
		// pointer takes, and for a draw gesture it *commits* what was drawn
		// rather than discarding it. Leaving it ungated would let a stroke
		// that began before read-only engaged still finish.
		if (this.readOnly) return;
		if (!this.drag || this.drag.pageNumber !== pageNumber) return;
		const mode = this.drag.mode;

		switch (mode.kind) {
			case 'draw':
				if (mode.points.length >= 2) this.commitDrawStroke(pageNumber, mode);
				break;
			case 'shape':
				if (distance(mode.start, mode.end) > 2) this.commitNew(pageNumber, this.shapeFromDraft(pageNumber, mode));
				break;
			case 'erase':
				this.store.commitGesture(pageNumber, mode.before);
				break;
			case 'move':
			case 'resize':
				this.store.setPageLive(pageNumber, mode.before);
				break;
		}

		this.drag = null;
		this.redrawOverlay(pageNumber);
		this.notify();
		const after = this.readPenButtons(event).kind;
		if (after === 'free' || after === 'hover-free') this.putBackButtonTool(pageNumber);
	}

	// Accepts either one annotation or a batch — a snapped highlighter stroke
	// (see commitDrawStroke) can become several straight segments, one per
	// text line it swept over, and all of them need to land as a single undo
	// step rather than one each.
	private commitNew(pageNumber: number, annotation: Annotation | Annotation[]): void {
		const additions = Array.isArray(annotation) ? annotation : [annotation];
		if (additions.length === 0) return;
		const before = this.store.getPage(pageNumber);
		this.store.setPageLive(pageNumber, [...before, ...additions]);
		this.store.commitGesture(pageNumber, before);
	}

	// A finished (or cancelled-but-kept) 'draw' gesture — for the highlighter
	// specifically, gives the host view a chance to replace the raw freehand
	// path with straight, text-snapped segments before committing (see
	// AnnotationControllerOptions.onSnapHighlighterStroke). Anything it
	// declines to snap (not a highlighter, no text under the stroke, or no
	// host support) commits as drawn, same as every other tool.
	private commitDrawStroke(pageNumber: number, mode: { tool: DrawToolType; points: Point[]; lastMovedAt: number }): void {
		// Held still at the end of a pen stroke: offer it to recognition.
		// Checked before the highlighter branch below only because a
		// highlighter is never snapped — a straight yellow bar is already
		// what the snapping it does have produces.
		if (mode.tool === 'pen' && (this.options.isShapeRecognitionEnabled?.() ?? false)) {
			if (performance.now() - mode.lastMovedAt >= SHAPE_HOLD_MS) {
				const recognized = recognizeShape(mode.points);
				if (recognized) {
					this.commitNew(pageNumber, {
						id: createId(),
						kind: 'shape',
						tool: recognized.tool,
						color: this.inkColor(),
						width: this.inkWidth(pageNumber),
						start: recognized.start,
						end: recognized.end,
					});
					return;
				}
			}
		}

		if (mode.tool === 'highlighter') {
			const snapped = this.options.onSnapHighlighterStroke?.(pageNumber, mode.points, this.inkColor());
			if (snapped && snapped.length > 0) {
				this.commitNew(pageNumber, snapped);
				return;
			}
		}
		this.commitNew(pageNumber, this.strokeFromDraft(pageNumber, mode));
	}

	// Opens the host’s note editor and applies whatever comes back.
	// `existing` being non-null means this is an edit rather than a new
	// note, and an empty result then deletes it: clearing the text of a
	// note is the only way anyone would expect to remove one.
	private async editNoteAt(
		pageNumber: number,
		point: Point,
		existing: NoteAnnotation | null,
		current: string,
	): Promise<void> {
		if (this.readOnly) return;
		const edit = this.options.onEditNote;
		if (!edit) return;

		const text = (await edit(pageNumber, point, current))?.trim() ?? null;
		// Cancelled. Deliberately distinct from an empty string, which is a
		// decision to delete.
		if (text === null) return;
		if (this.readOnly) return;

		const before = this.store.getPage(pageNumber);
		if (!existing) {
			if (!text) return;
			this.store.setPageLive(pageNumber, [
				...before,
				{
					id: createId(),
					kind: 'note',
					color: this.getColor(),
					width: this.getWidth(),
					at: point,
					note: text,
				},
			]);
		} else if (!text) {
			this.store.setPageLive(
				pageNumber,
				before.filter((annotation) => annotation.id !== existing.id),
			);
		} else {
			this.store.setPageLive(
				pageNumber,
				before.map((annotation) => (annotation.id === existing.id ? { ...existing, note: text } : annotation)),
			);
		}
		this.store.commitGesture(pageNumber, before);
		this.redrawOverlay(pageNumber);
		this.notify();
	}

	private strokeFromDraft(pageNumber: number, mode: { tool: DrawToolType; points: Point[] }): StrokeAnnotation {
		// Thinned here, at the moment the stroke commits, rather than when it
		// is written to the file. A save lands about a second after the pen
		// lifts and re-renders the block from what it wrote — so simplifying
		// there would visibly change the ink after the fact, which is exactly
		// the bug that made a tapered stroke redraw itself flat (see the
		// pressure note in src/markdown/inkBlockFormat.ts). Doing it on commit
		// means what you see the instant you lift the pen is what is stored.
		//
		// After shape recognition and highlighter snapping above, both of
		// which read the full sample set and are better for it.
		//
		// Steadied first (see prepareStroke), so that what is thinned is the
		// line the nib draws rather than the tremor in the samples — thinning
		// a jittery path keeps the jitter's corners, which is how the plain pen
		// used to come out angular.
		const points = simplifyPoints(this.inkPoints(mode), SIMPLIFY_EPSILON);
		const brush = mode.tool === 'pen' ? this.toolState.getBrush() : 'pen';
		return {
			id: createId(),
			kind: 'stroke',
			tool: mode.tool,
			color: this.inkColor(),
			width: this.inkWidth(pageNumber),
			points,
			...(brush !== 'pen' ? { brush } : {}),
		};
	}

	// The points a stroke in progress draws through: its samples, with
	// pressure dropped if the setting says so, and steadied by the pen's nib.
	// Shared by the live stroke and the committed one, so lifting the pen
	// changes nothing on screen.
	//
	// Pressure is stripped rather than never captured, so the pen's switch
	// governs one place — what gets drawn and committed — instead of being
	// checked in the pointer layer, the renderer, and the serializer.
	private inkPoints(mode: { tool: DrawToolType; points: Point[] }): Point[] {
		// Each pen has its own pressure switch (see ToolState.getPressure). A
		// highlighter never varies its width, so it keeps none either.
		const keepPressure = mode.tool === 'pen' && this.toolState.getPressure();
		const raw = keepPressure ? mode.points : mode.points.map(({ x, y }) => ({ x, y }));
		return mode.tool === 'pen' ? prepareStroke(raw, this.toolState.getBrush()) : raw;
	}

	getPressure(brush?: PenBrush): boolean {
		return this.toolState.getPressure(brush);
	}

	setPressure(brush: PenBrush, on: boolean): void {
		this.toolState.setPressure(brush, on);
	}

	getBrush(): PenBrush {
		return this.toolState.getBrush();
	}

	// Puts an annotation the host made — an imported picture — onto a page
	// as one step of undo, and hands it over selected, with the lasso in
	// hand, so it can be moved and sized into place straight away.
	place(pageNumber: number, annotation: Annotation): void {
		if (this.readOnly) return;
		this.setTool('select');
		this.commitNew(pageNumber, annotation);
		this.selection = { pageNumber, ids: new Set([annotation.id]) };
		this.redrawOverlay(pageNumber);
		this.notify();
	}

	// Whether the host can import into this surface, and asking it to: the
	// toolbar's import button. The host owns the menu and the file picking,
	// as it owns everything else outside the drawing.
	canImport(): boolean {
		return !!this.options.onImport;
	}

	openImport(anchor: HTMLElement): void {
		if (!this.readOnly) this.options.onImport?.(anchor);
	}

	canChangeBackground(): boolean {
		return this.isNote && !!this.options.onChangeBackground;
	}

	openBackground(anchor: HTMLElement): void {
		if (!this.readOnly) this.options.onChangeBackground?.(anchor);
	}

	setBrush(brush: PenBrush): void {
		this.toolState.setBrush(brush);
	}

	private shapeFromDraft(pageNumber: number, mode: { tool: ShapeToolType; start: Point; end: Point }): ShapeAnnotation {
		return {
			id: createId(),
			kind: 'shape',
			tool: mode.tool,
			color: this.inkColor(),
			width: this.inkWidth(pageNumber),
			start: mode.start,
			end: mode.end,
		};
	}

	private applyErase(pageNumber: number, point: Point): void {
		this.store.setPageLive(pageNumber, eraseAt(this.store.getPage(pageNumber), point, this.eraserRadius(pageNumber)));
	}

	private eraserRadius(pageNumber: number): number {
		return Math.max(this.inkWidth(pageNumber) * ERASER_RADIUS_FACTOR, MIN_ERASER_RADIUS);
	}

	private restyleSelection(patch: Partial<Pick<Annotation, 'color' | 'width'>>): void {
		const { pageNumber, ids } = this.selection;
		const before = this.store.getPage(pageNumber);
		this.store.setPageLive(
			pageNumber,
			before.map((a) => (ids.has(a.id) ? { ...a, ...patch } : a)),
		);
		this.store.commitGesture(pageNumber, before);
		this.redrawOverlay(pageNumber);
	}

	// ---- Rendering ----

	private scheduleOverlayRedraw(pageNumber: number): void {
		this.overlayRedrawPage = pageNumber;
		if (this.overlayRedrawFrame !== null) return;
		this.overlayRedrawFrame = window.requestAnimationFrame(() => {
			this.overlayRedrawFrame = null;
			const page = this.overlayRedrawPage;
			this.overlayRedrawPage = null;
			if (page !== null) this.redrawOverlay(page);
		});
	}

	private cancelScheduledOverlayRedraw(): void {
		if (this.overlayRedrawFrame === null) return;
		window.cancelAnimationFrame(this.overlayRedrawFrame);
		this.overlayRedrawFrame = null;
		this.overlayRedrawPage = null;
	}

	private redrawAllOverlay(): void {
		for (const pageNumber of this.pages.keys()) this.redrawOverlay(pageNumber);
	}

	private redrawBase(pageNumber: number): void {
		const mount = this.pages.get(pageNumber);
		if (!mount) return;
		const annotations = this.store.getPage(pageNumber);
		renderBase(mount.base, annotations);
		this.options.onPageRepainted?.(pageNumber, 'ink');

		// The layer is created on the first highlight and kept from then on —
		// erasing the last one has to repaint it empty, not leave the last
		// highlight sitting there because there is now nothing to draw.
		const context = mount.highlight ?? (annotations.some(isHighlight) ? this.createHighlightLayer(mount) : null);
		if (context) renderHighlights(context, annotations);
	}

	// Inserts the multiply-blended highlight canvas underneath the ink layer.
	// `insertBefore` rather than an append: both other canvases already exist
	// by the time anything is highlighted, and a highlight painted over the
	// ink would cover the pen strokes it is supposed to sit behind.
	private createHighlightLayer(mount: PageMount): CanvasRenderingContext2D | null {
		const canvas = mount.content.createEl('canvas', {
			cls: 'inkling-annotation-layer inkling-annotation-highlight',
		});
		canvas.width = mount.width;
		canvas.height = mount.height;
		// How strongly the layer is multiplied into the page. Set from here
		// rather than written into styles.css, so the one constant that is
		// also the annotation's /CA and the threshold it is read back by has
		// no fourth copy to fall out of step. The stylesheet consumes it as
		// var(--inkling-highlight-opacity).
		canvas.setCssProps({ '--inkling-highlight-opacity': String(HIGHLIGHTER_OPACITY) });
		mount.content.insertBefore(canvas, mount.base.canvas);

		const context = canvas.getContext('2d');
		if (!context) {
			// Not fatal the way the base layer's is: losing this one costs the
			// highlights their blending, not the page its annotations.
			canvas.remove();
			return null;
		}
		mount.highlightCanvas = canvas;
		mount.highlight = context;
		return context;
	}

	private redrawOverlay(pageNumber: number): void {
		const mount = this.pages.get(pageNumber);
		if (!mount) return;

		const { options, highlightDraft } = this.overlayFor(pageNumber);
		this.redrawHighlightDraft(mount, pageNumber, highlightDraft);

		// Nothing to draw and nothing ever drawn: leave the overlay
		// unallocated. This is the whole point of deferring it — a page being
		// read rather than drawn on reaches here on every mount and would
		// otherwise pay for a full-size canvas to clear it and stop.
		const empty =
			!options.draft &&
			!options.lassoPath &&
			!options.eraserCursor &&
			!options.crop &&
			!options.pasteAt &&
			(!options.selected || options.selected.length === 0);
		if (empty && !mount.overlay) {
			this.options.onPageRepainted?.(pageNumber, 'overlay');
			return;
		}

		const overlay = this.overlayContext(mount);
		renderOverlay(overlay, options);
		this.options.onPageRepainted?.(pageNumber, 'overlay');
	}

	// What the live layer shows on a page right now.
	private overlayFor(pageNumber: number): { options: OverlayOptions; highlightDraft: Annotation | null } {
		const dragMode = this.drag?.pageNumber === pageNumber ? this.drag.mode : null;
		const lassoPath = dragMode?.kind === 'lasso' ? dragMode.points : null;
		const draft = this.draftFor(pageNumber, dragMode);
		// A highlighter's draft is not drawn here. It goes to the multiplied
		// layer underneath, so that what is on screen mid-stroke is what the
		// stroke will look like once it commits; see redrawHighlightDraft.
		const highlightDraft = draft && isHighlight(draft) ? draft : null;
		const overlayDraft = highlightDraft ? null : draft;

		const eraserCursor =
			this.eraserCursor?.pageNumber === pageNumber ? { point: this.eraserCursor.point, radius: this.eraserRadius(pageNumber) } : null;
		const selected =
			this.selection.pageNumber === pageNumber && this.selection.ids.size > 0
				? this.store.getPage(pageNumber).filter((a) => this.selection.ids.has(a.id))
				: undefined;
		// A crop shows instead of the selection's frame — and goes if its
		// picture did, deleted or undone from under it.
		let crop: OverlayOptions['crop'] = null;
		if (this.cropping?.pageNumber === pageNumber) {
			const id = this.cropping.id;
			if (this.store.getPage(pageNumber).some((a) => a.id === id && a.kind === 'image')) crop = { picture: this.cropping.picture, rect: this.cropping.rect };
			else this.cropping = null;
		}
		const pasteAt = this.pasteOffer?.pageNumber === pageNumber ? this.pasteOffer.at : null;
		const chrome = selected || lassoPath || crop || pasteAt ? this.chromeScale(pageNumber) : 1;
		return {
			options: { selected: crop ? undefined : selected, draft: overlayDraft, lassoPath, eraserCursor, crop, pasteAt, chrome },
			highlightDraft,
		};
	}

	// A page's ink, and its live layer, drawn onto someone else's canvas in
	// that canvas's current transform — for the PDF view's detail layer. The
	// annotations are in this page's own canvas space, so a transform that
	// maps that space onto the detail canvas is all the caller supplies.
	drawInkTo(pageNumber: number, ctx: CanvasRenderingContext2D): void {
		drawInk(ctx, this.store.getPage(pageNumber));
	}

	// The highlighter's strokes, the one being drawn included — the layer
	// the overlay never carries (see redrawHighlightDraft).
	drawHighlightsTo(pageNumber: number, ctx: CanvasRenderingContext2D): void {
		drawHighlights(ctx, this.store.getPage(pageNumber), this.overlayFor(pageNumber).highlightDraft);
	}

	// Whether a highlighter stroke is being drawn on the page right now.
	hasHighlightDraft(pageNumber: number): boolean {
		return this.overlayFor(pageNumber).highlightDraft !== null;
	}

	drawOverlayTo(pageNumber: number, ctx: CanvasRenderingContext2D): void {
		drawOverlay(ctx, this.overlayFor(pageNumber).options);
	}

	// Paints the highlight layer with the live highlighter stroke on it, or
	// paints the draft back off it once the gesture ends.
	//
	// The layer is created here as well as in redrawBase, because the first
	// highlight on a page has to be visible while it is being drawn, not
	// only from the moment it commits — and until this, the first stroke had
	// no layer to be drawn on at all.
	private redrawHighlightDraft(mount: PageMount, pageNumber: number, draft: Annotation | null): void {
		// Nothing to draw, and nothing was drawn last time: the layer is
		// already correct, and this is the path every pointermove of every
		// other tool takes.
		if (!draft && !mount.highlightDraft) return;
		mount.highlightDraft = draft !== null;

		const context = mount.highlight ?? this.createHighlightLayer(mount);
		if (context) renderHighlights(context, this.store.getPage(pageNumber), draft);
	}

	// The overlay's drawing context, acquired the first time something
	// actually needs to be drawn on it and kept from then on.
	private overlayContext(mount: PageMount): CanvasRenderingContext2D {
		if (mount.overlay) return mount.overlay;

		const overlay = mount.overlayCanvas.getContext('2d');
		if (!overlay) throw new Error('InklingExpanded: could not acquire a 2D context for the annotation layer.');
		mount.overlay = overlay;
		return overlay;
	}

	private draftFor(pageNumber: number, mode: DragMode | null): Annotation | null {
		if (!mode) return null;
		if (mode.kind === 'draw') {
			const brush = mode.tool === 'pen' ? this.toolState.getBrush() : 'pen';
			return {
				id: DRAFT_ID,
				kind: 'stroke',
				tool: mode.tool,
				color: this.inkColor(),
				width: this.inkWidth(pageNumber),
				points: this.inkPoints(mode),
				...(brush !== 'pen' ? { brush } : {}),
			};
		}
		if (mode.kind === 'shape') {
			return {
				id: DRAFT_ID,
				kind: 'shape',
				tool: mode.tool,
				color: this.inkColor(),
				width: this.inkWidth(pageNumber),
				start: mode.start,
				end: mode.end,
			};
		}
		return null;
	}
}

function pointInRect(point: Point, rect: Rect): boolean {
	return point.x >= rect.minX && point.x <= rect.maxX && point.y >= rect.minY && point.y <= rect.maxY;
}

// The corner of a box across from a handle — the one that stays put while
// that handle is dragged.
function oppositeCorner(box: Rect, handle: HandleName): Point {
	switch (handle) {
		case 'nw':
			return { x: box.maxX, y: box.maxY };
		case 'ne':
			return { x: box.minX, y: box.maxY };
		case 'sw':
			return { x: box.maxX, y: box.minY };
		case 'se':
			return { x: box.minX, y: box.minY };
	}
}

function oppositeHandle(handle: HandleName): HandleName {
	return ({ nw: 'se', ne: 'sw', sw: 'ne', se: 'nw' } as const)[handle];
}
