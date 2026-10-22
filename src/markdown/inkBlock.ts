import { Editor, MarkdownPostProcessorContext, MarkdownRenderChild, Notice, Plugin, setIcon, setTooltip } from 'obsidian';
import {
	AnnotationController,
	buildToolbar,
	capturePointer,
	findScrollParent,
	HistoryStack,
	scaleAnnotationUniform,
	ToolState,
	type Annotation,
} from '../annotate';
import type { ContentZoom } from '../annotate/pointer';
import { createId } from '../annotate/id';
import { MAX_CANVAS_PIXELS } from '../pdf/renderScale';
import { INK_BLOCK_LANGUAGE, InkBlockData, emptyInkBlock } from './inkBlockFormat';
import { InNoteStorage } from './inNoteStorage';
import type { BlockRefusal, InkBlockStorage, StorageHost, StorageWriteResult } from './inkBlockStorage';
import { inkFenceMarkdown, isInkFileFence, isVaultPath, parseInkFence } from './inkFence';
import { emptyFileBlock } from './inkFile';
import { InkFileStorage } from './inkFileStorage';
import { InkFileStores } from './inkFileStore';
import { vaultInkFileIO } from './inkFileVaultIO';
import { InkRescueStore, browserRescueStorage } from './inkRecovery';

// Batches rapid successive strokes into one write, the same reasoning as
// the PDF view's own debounce: every save rewrites a region of the user's
// note, and handwriting arrives as a burst of short strokes.
const WRITE_DEBOUNCE_MS = 800;

// How long to wait before retrying a write that landed mid-gesture. Saving
// rewrites the block's source, which makes Obsidian re-render it — doing
// that under a pen still on the surface would yank the drawing surface out
// from under the stroke in progress.
const GESTURE_RETRY_MS = 250;

// Undo histories, and pinch-zoom, kept across the re-render a block’s own
// save causes.
//
// A block’s controller is destroyed and rebuilt roughly a second after
// the pen comes up, and the history used to go with it — so undo could
// never reach past your last pause, on the one surface people draw on
// most. Keeping it out here, and handing it back to the rebuilt
// controller, is the same move ToolState made for the pen itself.
//
// Keyed by note path and block id, and holding the scale the entries were
// recorded at: an entry holds coordinates, so a block rebuilt at a
// different surface resolution — a resized window, a zoom — carries every
// entry across to its own (see InkBlockView.rescaleHistory).
//
// The zoom is kept for the same reason the history is. It lived on the
// block's zoomable element, which every save throws away, so a block you
// had zoomed into to write small sprang back to its full view a second
// after each pause.
interface RetainedHistory {
	history: HistoryStack;
	scale: number;
	zoom: ContentZoom | null;
}

const retainedHistories = new Map<string, RetainedHistory>();

// Bounded so a long session over a big vault cannot accumulate one per
// block ever rendered. Map preserves insertion order, so the oldest goes
// first — and losing an undo history for a block nobody has touched in a
// hundred blocks is not a loss anyone notices.
const MAX_RETAINED_HISTORIES = 32;

function retainedHistoryFor(key: string): RetainedHistory {
	const existing = retainedHistories.get(key);
	if (existing) return existing;

	const retained: RetainedHistory = { history: new HistoryStack(), scale: 1, zoom: null };
	retainedHistories.set(key, retained);
	while (retainedHistories.size > MAX_RETAINED_HISTORIES) {
		const oldest = retainedHistories.keys().next().value;
		if (oldest === undefined) break;
		retainedHistories.delete(oldest);
	}
	return retained;
}

// How much sharper than the note’s column a block’s canvas may be backed.
//
// The surface is stored 800 units wide and shown at whatever width the
// note’s column happens to be, so backing the canvas at the stored size —
// which is what it used to do — stretched it, by about 2.25x on a
// high-DPI desktop. Ink came out visibly soft on exactly the screens
// people read on.
//
// Capped because the cost is real: a canvas is width x height x 4 bytes,
// twice over (see PageMount), for every block in the note.
const MAX_SURFACE_SCALE = 3;

// How far outside the viewport a block mounts its canvases. Wide enough
// that scrolling at a normal speed always meets a block that is already
// drawn, rather than a blank sheet filling in late.
const SURFACE_MOUNT_MARGIN = '400px 0px';

// How far outside it a block gives them up again — deliberately much
// further out than it mounts at.
//
// One margin for both meant a block sitting right on the boundary
// mounted and released on every small scroll, and each cycle allocates
// two canvases, redraws every stroke, and throws it all away again. A
// scroll that rocks back and forth by a few dozen pixels — which is
// what reading looks like — did that repeatedly.
//
// The gap between the two is the hysteresis: crossing in is not the same
// place as crossing back out, so nothing oscillates. The cost is that a
// block up to 1200px away still holds its canvases, which is the memory
// Phase E set out to bound; three times the mount margin keeps that well
// short of what it was before, when every block in the note held them.
const SURFACE_RELEASE_MARGIN = '1200px 0px';

// Ink that was drawn but could not be written to the note, kept alive
// across the re-render that would otherwise throw it away.
//
// A block that fails to save leaves the drawing on screen and nothing in
// the file. That looks fine — until anything re-renders the note, at
// which point the block reloads from the file and the work is simply
// gone. This is what that failure cost in practice, and it is not
// acceptable for a save to be able to lose work quietly.
//
// Module-level for the same reason the open-tool-strip set is: an
// InkBlockView does not survive its own note's re-render, so anything
// meant to outlive one cannot live on it. Keyed by note path and block
// id, so two blocks — or two notes — cannot collide.
//
// It was a plain Map until a save that failed and a quit in the same
// session turned out to lose the drawing anyway. See markdown/inkRecovery
// for what it holds and where, and — the part that is genuinely new — why a
// held drawing has to prove the file has not moved on before it is adopted.
const unsavedInk = new InkRescueStore(browserRescueStorage());

// The pencil on the block's tool toggle, drawn here rather than asked for
// from the host.
//
// This button lost its icon twice on a phone — first pencil-ruler, then
// pen-tool — while every icon in the tool strip beside it drew correctly.
// The icon set belongs to Obsidian, it is not the same on mobile as on
// desktop, and a plugin has no way to ask which names a given build knows:
// setIcon leaves an empty <svg> for one it does not, which is a blank
// button and no error. Guessing at a name old enough to be safe is a guess
// that can only be checked by shipping it to a device.
//
// Two paths cost nothing and cannot go missing. Shaped and styled like a
// Lucide glyph — stroke, round caps, currentColor — so it still sits with
// the rest of the app's chrome, and sized in the stylesheet in absolute
// units so no theme variable can collapse it either.
function drawPencil(host: HTMLElement): void {
	const svg = host.createSvg('svg', {
		cls: 'inkling-block-toggle-icon',
		attr: {
			viewBox: '0 0 24 24',
			fill: 'none',
			stroke: 'currentColor',
			'stroke-width': '2',
			'stroke-linecap': 'round',
			'stroke-linejoin': 'round',
			'aria-hidden': 'true',
		},
	});
	svg.createSvg('path', { attr: { d: 'M12 20h9' } });
	svg.createSvg('path', { attr: { d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z' } });
}

function countOf(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function recoveryKey(sourcePath: string, blockId: string): string {
	return `${sourcePath}::${blockId}`;
}

// Blocks whose canvases were attached a moment ago, by note path and block id.
//
// This exists for one case: a block rebuilt by its own save. Saving rewrites
// the fence, Obsidian re-renders that section, and the block is destroyed and
// rebuilt about a second after the pen comes up — which is already why the
// tool strip, the undo history and the note's scroll position are all kept
// outside the view that owns them.
//
// The rebuilt block is created at full size, because the aspect ratio holds
// the space, but its canvases wait on an IntersectionObserver reporting it
// visible, and that report comes a frame or more later. For that window the
// block is correctly sized and completely empty, so the ink disappears and
// comes back: the flash people notice after writing, and worse on a tablet,
// where a higher pixel ratio makes the canvases slower to attach.
//
// Deferring is right for every other block — a note holding thirty-nine of
// them must not allocate seventy-eight canvases to be scrolled past — and
// wrong only for the one the user is drawing in, which is certainly on screen
// because they are looking at it.
const recentlyMounted = new Map<string, number>();

// Long enough to cover the write debounce and the re-render it causes, short
// enough that a block scrolled away from and returned to still gets the
// ordinary deferred treatment.
const REMOUNT_WINDOW_MS = 5000;

// Bounded like the retained histories above, and for the same reason.
const MAX_RECENTLY_MOUNTED = 32;

function markRecentlyMounted(key: string): void {
	// Deleted first so re-setting moves it to the end, which is what makes
	// the eviction below drop the least recently mounted.
	recentlyMounted.delete(key);
	recentlyMounted.set(key, Date.now());
	if (recentlyMounted.size > MAX_RECENTLY_MOUNTED) {
		const oldest = recentlyMounted.keys().next().value;
		if (oldest !== undefined) recentlyMounted.delete(oldest);
	}
}

function wasRecentlyMounted(key: string): boolean {
	const at = recentlyMounted.get(key);
	if (at === undefined) return false;
	if (Date.now() - at <= REMOUNT_WINDOW_MS) return true;
	recentlyMounted.delete(key);
	return false;
}

// How much sharper than its stored size a block canvas should be backed,
// given the element it has to fill and the screen it is on.
function surfaceScale(containerEl: HTMLElement, storedWidth: number): number {
	const cssWidth = containerEl.clientWidth;
	if (!cssWidth || storedWidth <= 0) return 1;
	const density = window.devicePixelRatio || 1;
	// Never *below* the stored size: shrinking the backing store to fit a
	// narrow phone column would throw away detail the file already holds,
	// and the ink would come back coarser than it was drawn.
	return Math.min(Math.max((cssWidth * density) / storedWidth, 1), MAX_SURFACE_SCALE);
}

// How densely a block is backed while zoomed: as many canvas pixels per
// screen pixel as at its unzoomed size, so ink zoomed into stays as sharp
// as ink seen whole — within what one canvas may hold (MAX_CANVAS_PIXELS,
// the limit a phone or tablet browser puts on it), and never less than the
// unzoomed backing.
function zoomedScale(base: number, zoom: number, storedWidth: number, storedHeight: number): number {
	const budget = storedWidth > 0 && storedHeight > 0 ? Math.sqrt(MAX_CANVAS_PIXELS / (storedWidth * storedHeight)) : base;
	return Math.max(base, Math.min(base * zoom, budget));
}

// Re-backing a block costs a redraw of everything on it, so a zoom that
// barely changes how sharp it needs to be does not trigger one. Downwards
// only once it is far denser than needed, which frees the memory a deep
// zoom took.
const REBACK_UP = 1.15;
const REBACK_DOWN = 1.5;

// Only the block’s own single drawing surface is ever mounted into a given
// controller, so the page-keyed API the controller shares with the PDF view
// (where the key is a real page number) always gets the same key here.
const BLOCK_PAGE = 1;

// Blocks the user has opened for editing, by note path and block id.
//
// Module-level for the same reason tool state is plugin-level: an
// InkBlockView does not survive its own save. Writing a block rewrites the
// fence, Obsidian re-renders that section, and the render child — toolbar
// and all — is torn down and rebuilt about a second after the pen comes up.
// Without this, every stroke would close the block you were drawing in.
//
// Keyed by id rather than by the fence's starting line, which is what this
// used to use. A line number is only identity for as long as nothing above
// the block moves, and prose edited above one left an entry pointing at
// whichever block now starts on that line. That was worth living with when
// the cost was a tool strip opening uninvited; it is not now that the same
// entry decides which block accepts ink.
const openToolStrips = new Set<string>();

// Manual resizing, via the drag handle along a block's bottom edge.
//
// Height only, never width. The surface always spans the note's column, so
// the stored width is what fixes the scale between stored coordinates and
// screen pixels — changing it would rescale every stroke already drawn
// rather than give more room. Height is free to change because it only adds
// or removes space below; nothing already drawn moves.
//
// Shrinking past existing ink is allowed and non-destructive: strokes are
// kept in full and simply fall outside the visible area, so dragging back
// down brings them straight back.
const MIN_BLOCK_HEIGHT = 120;
const MAX_BLOCK_HEIGHT = 4000;

// One live ink block in a rendered note. Instances are created per render —
// Obsidian re-runs the post-processor whenever the block's section is
// re-rendered — so everything here is torn down through the render child
// below rather than assumed to live as long as the file is open.
class InkBlockView implements StorageHost {
	private readonly controller: AnnotationController;
	private data: InkBlockData;
	private disposeToolbar: (() => void) | null = null;
	private writeHandle: number | null = null;
	private readonly toolbarHost: HTMLElement;
	// Assigned in the constructor; held because resizing (see applyHeight)
	// restates the aspect ratio that gives this element its height.
	private readonly surfaceEl!: HTMLElement;
	private detached = false;

	// Identifies this block across the re-render its own save causes — see
	// openToolStrips. Null when the block's position can't be read, in which
	// case the tool strip simply isn't remembered.
	private readonly stripKey: string;

	// This block's own identity, as its storage names it.
	private readonly blockId: string;
	// Whether the storage has shown this block anything yet. Nothing is drawn,
	// seeded or saved before it has: a block that waits on a file must not
	// accept ink it has nowhere to put, nor seed an empty store over it.
	private loaded = false;
	// Why this block may not be saved, if it may not. Can change underneath a
	// rendered block — a sync conflict resolves, or a file comes back.
	private refusal: BlockRefusal | null = null;
	// A save in flight. Counts as unsaved work: what is on screen may be newer
	// than what the storage holds until it lands.
	private writing = false;

	// How many surface units there are per stored unit. The block is
	// stored 800 wide whatever screen drew it; the canvas is backed at
	// the width it is actually shown at, times the display density, so
	// ink is drawn at the resolution it is looked at. Everything the
	// controller holds is in surface units, everything in the file is in
	// stored units, and this is the only thing between them.
	// How many surface units there are per stored unit — measured when the
	// surface is actually mounted, because at construction the block is
	// not in the layout yet and reports a width of zero. Everything the
	// controller holds is in surface units, everything in the file is in
	// stored units, and this is the only thing between them.
	private scale = 1;
	// What the surface would be backed at unzoomed: the block's own column
	// width times the screen's density (see surfaceScale). `scale` is this,
	// raised while the block is zoomed.
	private baseScale = 1;
	private readonly retained: RetainedHistory;
	// The element the canvases are mounted into, and whether they
	// currently are. See watchVisibility.
	private readonly contentEl: HTMLElement;
	private observers: IntersectionObserver[] = [];
	// The drag handle along the block's bottom edge, shown only while the
	// tool strip is open. See setResizeHandleVisible.
	private resizeHandleEl: HTMLElement | null = null;
	private bannerEl: HTMLElement | null = null;
	// The pending frame in watchVisibility, so detaching before it runs
	// cannot leave a callback pointing at a torn-down block.
	private watchHandle: number | null = null;
	private mounted = false;
	// The canvases' backing size while mounted, so a block whose data changes
	// size underneath it can tell its surface no longer matches.
	private mountedSize: { width: number; height: number } | null = null;
	// Ink on screen that a save was refused, failed, or is waiting to retry.
	// Until one succeeds, the screen is the only copy with it in, so nothing
	// the storage shows may be put over it.
	private holdingUnsaved = false;
	// The caption line or field, whichever the block last built.
	private captionEl: HTMLElement | null = null;
	// Whether the file’s annotations have been handed to the store yet.
	// Once they have, the store is the live truth and a remount must not
	// overwrite it.
	private seeded = false;

	constructor(
		private readonly plugin: Plugin,
		private readonly ctx: MarkdownPostProcessorContext,
		private readonly containerEl: HTMLElement,
		private readonly storage: InkBlockStorage,
		toolState: ToolState,
		private readonly captionsEnabled: () => boolean,
		penButton?: () => 'eraser' | 'highlighter' | 'select' | 'none',
	) {
		this.blockId = storage.blockId;
		// Until the storage shows something. Its size is what the block holds
		// space with, so a block waiting on a file reserves the default.
		this.data = { ...emptyInkBlock(), id: this.blockId };

		// The same key the recovery map uses, and for the same reason: it is
		// the one name for this block that survives its own save.
		this.stripKey = recoveryKey(ctx.sourcePath, this.blockId);

		this.retained = retainedHistoryFor(recoveryKey(ctx.sourcePath, this.blockId));

		this.controller = new AnnotationController({
			toolState,
			// Kept outside the controller so undo survives this block being
			// rebuilt by its own save. See retainedHistories.
			history: this.retained.history,
			getCurrentPage: () => BLOCK_PAGE,
			onAnnotationsChanged: () => this.scheduleWrite(),
			// Backed denser while zoomed (see zoomedScale), and a pen is
			// measured against the block as it is shown, not against how
			// many pixels happen to be behind it — so the same pen makes the
			// same line zoomed in or out.
			getInkScale: () => this.scale / this.baseScale,
			onZoomSettled: () => this.onZoomSettled(),
			getPenButtonAction: penButton,
		});
		// No pages to add or remove inside a note — that's a handwritten-note
		// concept, and the toolbar hides the control when this is false.
		this.controller.setCanManagePages(false);
		// Ready to write immediately. The shared default is the select tool,
		// which suits the PDF view (where you often open a file to read, and
		// reach for a tool deliberately) but not a block you added
		// specifically to handwrite into — landing in select mode there
		// means a stylus does nothing at all until the toolbar is opened.
		// A suggestion, not an assignment: this runs again on every save's
		// re-render, and forcing the pen there would snatch the lasso back
		// from anyone who had deliberately switched to it.
		this.controller.suggestTool('pen');

		containerEl.addClass('inkling-ink-block');
		this.toolbarHost = containerEl.createDiv({ cls: 'inkling-ink-block-toolbar-host' });

		// Mirrors the PDF view's placeholder > content > canvases nesting:
		// the gesture layer finds a page's zoomable wrapper and its clipping
		// box by walking up from the canvas it's attached to, so pinch-zoom
		// and panning work here for free by matching that shape.
		const surface = containerEl.createDiv({ cls: 'inkling-ink-block-surface' });
		this.surfaceEl = surface;
		const content = surface.createDiv({ cls: 'inkling-ink-block-content' });

		// Width comes from the note's own column; the stored size sets the
		// proportions. Pointer input is mapped through the canvas backing
		// scale (see annotate/pointer.ts), so a block drawn on a phone and
		// reopened on a desktop still puts every stroke where it was drawn.
		surface.setCssProps({ '--inkling-block-aspect': `${this.data.width} / ${this.data.height}` });
		this.contentEl = content;

		// Blocks open closed to editing, and the toggle below is what opens
		// them. A note is read far more often than it is drawn in, and a
		// surface that takes ink the moment anything touches it is a surface
		// that collects stray marks from a stylus resting on the way past —
		// on the one screen, a tablet, where the pen is also how you scroll.
		//
		// This is separate from a refusal, which means the block must *never*
		// be written. That one is permanent and the toggle cannot lift it;
		// this one is the user's to change whenever they like.
		this.controller.setReadOnly(true);

		this.buildToolbarToggle();
		// Built for every block and shown only while the block is open and may
		// be saved: a handle that appears to resize a block and then silently
		// forgets would be worse than not having one.
		this.buildResizeHandle();

		// After everything the storage may call back into exists. An in-note
		// block answers synchronously, so its banner and caption land now, in
		// the same order in the DOM as they always did.
		storage.open(this);

		// Last: a block rebuilt by its own save mounts synchronously, and
		// mounting seeds the surface from what the storage just showed.
		this.watchVisibility();
	}

	show(data: InkBlockData): boolean {
		if (this.detached) return false;

		if (!this.loaded) {
			this.loaded = true;
			// Ink from a save that failed before this block was re-rendered is
			// strictly newer than what the storage holds — that is what the
			// failed save was trying to update. Adopting it here, and saving
			// again below, is what turns a failed save into a delayed one
			// rather than into lost work.
			//
			// Declined unless it matches the block as stored now: across a quit,
			// sync can have brought back a newer version of this block from
			// another device, and putting a held drawing over that would
			// overwrite work rather than rescue it.
			const rescued = unsavedInk.get(this.storage.rescuePath, this.blockId, this.storage.rescueSource());
			this.data = rescued ? { ...rescued, id: this.blockId } : { ...data, id: this.blockId };
			this.applyAspect();
			// A block scrolled into view before its storage answered mounted at
			// the default size, and the seed below does not re-back a canvas.
			this.fitSurface();
			// After any refusal the block starts with, which decides whether a
			// caption may be written: a block that must never be saved over must
			// not offer a field whose only purpose is to save something over it.
			this.buildCaption();
			this.applyEditability();
			if (this.mounted && !this.seeded) this.seed();
			// So the rescued ink is on screen before the save that persists it
			// is attempted.
			if (rescued && this.writable()) this.scheduleWrite();
			return true;
		}

		// Never over unsaved work. The storage merges it at the next save
		// instead, which keeps both.
		if (this.hasUnsavedWork()) return false;
		this.data = { ...data, id: this.blockId };
		this.applyAspect();
		// Resized elsewhere — another device, or a second view of this block.
		this.fitSurface();
		this.refreshCaption();
		// Only if the store has already been given this block's annotations;
		// otherwise the next mount seeds from the data set just above, which
		// is the same answer one step later.
		if (this.seeded) this.controller.seedPage(BLOCK_PAGE, this.toSurface(this.data.annotations));
		return true;
	}

	refuse(refusal: BlockRefusal): void {
		this.refusal = refusal;
		this.bannerEl?.remove();
		this.buildBanner(refusal);
		this.refreshCaption();
		// Told directly, not left to the toggle. The controller learns its
		// read-only state inside setOpen, so a block whose tool strip is
		// already open would keep taking ink until the next time someone
		// closed and reopened it — which is the whole window this refusal
		// exists to close.
		this.applyEditability();
	}

	lift(): void {
		this.refusal = null;
		this.bannerEl?.remove();
		this.bannerEl = null;
		this.refreshCaption();
		// The mirror of refuse, and the reason that one is not enough on its
		// own: a repaired block whose strip was already open looked editable
		// and silently refused every stroke, because the controller was never
		// told the refusal had been lifted.
		this.applyEditability();
	}

	isRefused(): boolean {
		return this.refusal !== null;
	}

	hasUnsavedWork(): boolean {
		return this.writeHandle !== null || this.writing || this.holdingUnsaved || this.controller.isGestureActive();
	}

	isDetached(): boolean {
		return this.detached;
	}

	private writable(): boolean {
		return this.loaded && this.refusal === null;
	}

	private applyEditability(): void {
		const open = this.disposeToolbar !== null;
		this.controller.setReadOnly(!open || !this.writable());
		this.setResizeHandleVisible(open && this.writable());
	}

	private applyAspect(): void {
		this.surfaceEl.setCssProps({ '--inkling-block-aspect': `${this.data.width} / ${this.data.height}` });
	}

	// Re-backs a mounted surface at the size this.data now gives the block,
	// when that is not the size it was mounted at. Whatever the page holds is
	// carried across in stored units; a caller about to seed replaces it anyway.
	private fitSurface(): void {
		if (!this.mounted) return;
		// A surface not laid out yet measures zero wide, and surfaceScale reads
		// that as 1 — a soft canvas. The scale it mounted at stays until it
		// can be measured.
		const scale = this.surfaceEl.clientWidth ? this.targetScale() : this.scale;
		this.rebackSurface(scale);
	}

	// The scale the surface should be backed at now, for its width and its
	// zoom.
	private targetScale(): number {
		if (this.surfaceEl.clientWidth) this.baseScale = surfaceScale(this.surfaceEl, this.data.width);
		return zoomedScale(this.baseScale, this.retained.zoom?.scale ?? 1, this.data.width, this.data.height);
	}

	// Re-backs the mounted surface at `scale`, carrying the ink on it and
	// every undo entry across in proportion.
	private rebackSurface(scale: number): void {
		const width = this.data.width * scale;
		const height = this.data.height * scale;
		if (this.mountedSize?.width === width && this.mountedSize.height === height) return;

		const factor = scale / this.scale;
		const annotations = this.controller.getPageAnnotations(BLOCK_PAGE);
		this.controller.resizePage(
			BLOCK_PAGE,
			width,
			height,
			factor === 1 ? annotations : annotations.map((a) => scaleAnnotationUniform(a, factor)),
		);
		this.scale = scale;
		this.rescaleHistory();
		this.mountedSize = { width, height };
	}

	// Brings the retained undo history into the surface's current scale.
	// Entries hold coordinates; one recorded at another scale and replayed
	// as it is would put the ink back in the wrong place, which is why this
	// used to clear the history instead — and why resizing a window, or now
	// zooming, used to cost every undo.
	private rescaleHistory(): void {
		const from = this.retained.scale;
		this.retained.scale = this.scale;
		if (!(from > 0) || Math.abs(from - this.scale) < 0.001) return;
		const factor = this.scale / from;
		const history = this.retained.history;
		history.restore(history.snapshot(), (entry) => ({
			...entry,
			before: entry.before.map((a) => scaleAnnotationUniform(a, factor)),
			after: entry.after.map((a) => scaleAnnotationUniform(a, factor)),
		}));
	}

	// A pinch, a Ctrl+wheel or the toolbar has settled on a zoom: kept for
	// the block's next rebuild, and the surface backed for it.
	private onZoomSettled(): void {
		const zoom = this.controller.getPageZoomState(BLOCK_PAGE);
		if (!zoom || !this.mounted) return;
		this.retained.zoom = zoom.scale === 1 && zoom.x === 0 && zoom.y === 0 ? null : zoom;
		const target = this.targetScale();
		if (target > this.scale * REBACK_UP || target < this.scale / REBACK_DOWN) this.rebackSurface(target);
	}

	private seed(): void {
		this.seeded = true;
		this.controller.seedPage(BLOCK_PAGE, this.toSurface(this.data.annotations));
	}

	// One line under the block saying what the drawing is.
	//
	// The setting governs whether a caption can be *written*, never whether
	// one already written is *shown*. A caption written on a device where the
	// setting is on syncs to one where it is off, and hiding text someone
	// wrote is worse than showing it.
	private buildCaption(): void {
		if (!this.captionsEnabled() || !this.writable()) {
			const text = this.data.caption?.trim();
			if (!text) return;
			// Text, never markup. A caption comes out of the user's own note,
			// which syncs between devices and can be hand-edited, so it is
			// exactly as untrusted as the stroke data beside it.
			const caption = this.containerEl.createDiv({ cls: 'inkling-ink-block-caption', text });
			if (this.resizeHandleEl) this.containerEl.insertBefore(caption, this.resizeHandleEl);
			this.captionEl = caption;
			return;
		}

		const input = this.containerEl.createEl('input', { cls: 'inkling-ink-block-caption-input' });
		this.captionEl = input;
		if (this.resizeHandleEl) this.containerEl.insertBefore(input, this.resizeHandleEl);
		input.type = 'text';
		input.value = this.data.caption ?? '';
		input.placeholder = 'Describe this block';
		input.setAttribute('aria-label', 'Caption for this ink block');
		// change rather than input: a save rewrites the fence and re-renders
		// the block, which would take the field out from under the cursor
		// after every keystroke. change fires when the field is done with.
		input.addEventListener('change', () => this.commitCaption(input.value));
		input.addEventListener('blur', () => this.commitCaption(input.value));
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') input.blur();
		});
	}

	// Built again from what the block now holds and whether it may now be
	// saved. A field left showing an older caption would write it back the
	// next time it was left. Not while someone is typing in it: their edit is
	// newer than anything the storage could show.
	private refreshCaption(): void {
		if (!this.loaded) return;
		if (this.captionEl && this.captionEl === this.containerEl.ownerDocument.activeElement) return;
		this.captionEl?.remove();
		this.captionEl = null;
		this.buildCaption();
	}

	private commitCaption(value: string): void {
		const trimmed = value.trim();
		const next = trimmed ? trimmed : undefined;
		// Nothing to write when nothing changed. blur fires on every pass
		// through the field, and a no-op edit to a block is still a rewritten
		// note re-uploaded through a replicating vault.
		if (next === this.data.caption) return;
		this.data = { ...this.data, caption: next };
		this.scheduleWrite();
	}

	private buildBanner(refusal: BlockRefusal): void {
		const banner = this.containerEl.createDiv({ cls: 'inkling-ink-block-banner' });
		this.bannerEl = banner;
		this.surfaceEl.insertAdjacentElement('afterend', banner);
		setIcon(banner.createDiv({ cls: 'inkling-ink-block-banner-icon' }), 'alert-triangle');
		banner.createDiv({ cls: 'inkling-ink-block-banner-text', text: refusal.message });

		if (!refusal.recoverable) return;
		this.buildRecoveryAction(banner, refusal.recoverable.kept, refusal.recoverable.dropped);
	}

	// Two clicks rather than a modal. The action is not reversible and says
	// so before it happens, and a confirmation that stays inside the block —
	// next to the count it is talking about — reads better on a phone than a
	// dialog that covers the thing being decided about.
	private buildRecoveryAction(banner: HTMLElement, kept: number, dropped: number): void {
		const button = banner.createEl('button', {
			cls: 'inkling-ink-block-banner-action',
			text: `Keep the ${countOf(kept, 'annotation')} that survived`,
		});
		button.type = 'button';
		let armed = false;
		button.addEventListener('click', () => {
			if (!armed) {
				armed = true;
				button.setText(`Discard ${countOf(dropped, 'annotation')} and keep ${kept}?`);
				button.addClass('is-armed');
				return;
			}
			this.recoverWhatSurvived();
		});
	}

	// Writing what parsed, deliberately, at the user's word. The block stops
	// being read-only and saves in the ordinary way — which rewrites the
	// fence, re-renders the section, and gives back a block with no banner,
	// its resize handle, and everything else a healthy one has.
	private recoverWhatSurvived(): void {
		this.lift();
		void this.write();
	}

	private buildToolbarToggle(): void {
		// An icon button, matching the tool strip it opens — a lone "Tools"
		// text button sitting above every ink block in a note read like a
		// piece of the note's own content rather than plugin chrome.
		const toggle = this.toolbarHost.createEl('button', { cls: 'inkling-ink-block-toggle' });
		toggle.type = 'button';
		drawPencil(toggle);
		// Stated up front rather than left to setOpen below, which no-ops
		// when asked for the state it's already in: a collapsed toggle still
		// has to announce itself as collapsed, not as un-expandable.
		toggle.setAttribute('aria-expanded', 'false');

		const setOpen = (open: boolean) => {
			if (open === (this.disposeToolbar !== null)) return;
			if (open) {
				// Built on demand, not for every block on screen: a note can
				// hold many of these, and a full tool strip apiece would crowd
				// out the writing they're meant to sit alongside.
				this.disposeToolbar = buildToolbar(this.toolbarHost, this.controller, { app: this.plugin.app });
			} else {
				this.disposeToolbar?.();
				this.disposeToolbar = null;
			}

			// What the button is actually for. The strip is the visible half;
			// this is the half that decides whether the surface takes ink at
			// all, so a block nobody has asked to edit cannot collect a stray
			// mark from a pen on its way past.
			//
			// A block that may not be saved stays closed to writing whatever
			// this says — that decision is not the user's to reverse, because
			// what would be written over is what we failed to understand.
			this.applyEditability();

			const label = open ? 'Done editing this block' : 'Edit this block';
			setTooltip(toggle, label);
			toggle.setAttribute('aria-label', label);
			toggle.toggleClass('is-active', open);
			toggle.setAttribute('aria-expanded', String(open));
		};

		// Never a no-op on the first call, whatever setOpen decides below:
		// the label has to say something before anything is toggled.
		setTooltip(toggle, 'Edit this block');
		toggle.setAttribute('aria-label', 'Edit this block');

		toggle.addEventListener('click', () => {
			const open = this.disposeToolbar === null;
			setOpen(open);
			// Recorded only on a real click. A strip that came and went with a
			// re-render must not count as the user having opened or closed
			// anything.
			if (open) openToolStrips.add(this.stripKey);
			else openToolStrips.delete(this.stripKey);
		});

		setOpen(openToolStrips.has(this.stripKey));
	}

	// Applies a new drawing-surface height. Both parts have to move
	// together: the aspect ratio is what gives the surface its on-screen
	// height, and the canvases' backing store is what gives the drawing
	// space its extra room. Width is untouched, so the coordinate-to-screen
	// scale is unchanged and nothing already drawn shifts or resizes.
	private applyHeight(height: number): void {
		const clamped = Math.round(Math.min(Math.max(height, MIN_BLOCK_HEIGHT), MAX_BLOCK_HEIGHT));
		if (clamped === this.data.height) return;

		this.data = { ...this.data, height: clamped };
		this.applyAspect();
		// Goes through the store's live-update path, so a resize counts as
		// exactly that rather than an edit: no history entry of its own, and
		// no change notification recursing back into the save path.
		this.controller.resizePage(
			BLOCK_PAGE,
			this.data.width * this.scale,
			clamped * this.scale,
			this.controller.getPageAnnotations(BLOCK_PAGE),
		);
		if (this.mounted) this.mountedSize = { width: this.data.width * this.scale, height: clamped * this.scale };
	}

	// Shows or hides the resize handle along with the tool strip.
	//
	// The handle spans the block's whole bottom edge, which put a drag target
	// between every block and the prose under it. Scrolling a note by dragging
	// — which is how a note gets read on a touchscreen — caught it, and the
	// block stretched instead of the page moving.
	//
	// Resizing is a deliberate act and a rare one, so it now lives behind the
	// same "Tools" toggle the pens do: no strip open, no handle to catch. A
	// block being read has nothing draggable on it at all.
	private setResizeHandleVisible(visible: boolean): void {
		if (!this.resizeHandleEl) return;
		this.resizeHandleEl.hidden = !visible;
		this.surfaceEl.toggleClass('inkling-has-handle', visible);
	}

	private buildResizeHandle(): void {
		const handle = this.containerEl.createDiv({ cls: 'inkling-ink-block-handle' });
		this.resizeHandleEl = handle;
		// Lets the surface square off the corners the handle joins on to.
		// Set here rather than found with a :has() selector, since this is
		// the code that decides the handle exists at all.
		//
		// Built once but shown only while the tool strip is open, and the
		// strip's own state decides which — a block whose strip the user left
		// open comes back with its handle, and every other block comes back
		// without one. See setResizeHandleVisible.
		this.setResizeHandleVisible(this.disposeToolbar !== null && this.writable());
		handle.setAttribute('aria-label', 'Drag to resize this ink block');
		setTooltip(handle, 'Drag to resize');

		let drag: { pointerId: number; startY: number; startHeight: number } | null = null;
		// Coalesces a burst of pointermoves into one resize per frame —
		// re-backing two canvases and repainting every stroke on each move
		// event would make dragging stutter on a long drawing.
		let pendingHeight: number | null = null;
		let frame: number | null = null;

		const flush = () => {
			frame = null;
			if (pendingHeight === null) return;
			this.applyHeight(pendingHeight);
			pendingHeight = null;
		};

		handle.addEventListener('pointerdown', (event: PointerEvent) => {
			drag = { pointerId: event.pointerId, startY: event.clientY, startHeight: this.data.height };
			capturePointer(handle, event.pointerId);
			// Stops the drag from also scrolling the note on touch, the same
			// reason the drawing canvases set touch-action: none.
			event.preventDefault();
		});

		handle.addEventListener('pointermove', (event: PointerEvent) => {
			if (!drag || event.pointerId !== drag.pointerId) return;
			// The handle moves in CSS pixels but height is stored in the
			// surface's own coordinate space, so the drag distance has to be
			// converted through the current on-screen scale — otherwise a
			// drag moves the edge by a different amount than the pointer on
			// every screen width but one.
			const cssWidth = this.surfaceEl.getBoundingClientRect().width;
			const perCssPixel = cssWidth > 0 ? this.data.width / cssWidth : 1;
			pendingHeight = drag.startHeight + (event.clientY - drag.startY) * perCssPixel;
			frame ??= window.requestAnimationFrame(flush);
		});

		const end = (event: PointerEvent) => {
			if (!drag || event.pointerId !== drag.pointerId) return;
			drag = null;
			if (frame !== null) {
				window.cancelAnimationFrame(frame);
				frame = null;
			}
			flush();
			this.scheduleWrite();
		};

		handle.addEventListener('pointerup', end);
		handle.addEventListener('pointercancel', end);
	}

	// ---- Surface mounting ----

	// A block only holds canvases while it is somewhere near the screen.
	//
	// Measured on the note that prompted this: fourteen blocks, and every
	// one of them mounted a base and an overlay canvas whether or not
	// anyone was looking at it — 38 MB of backing store at the stored size,
	// and 118 MB once those canvases were backed at display resolution.
	// Parsing all fourteen blocks, by contrast, takes 9 ms. The JSON was
	// never the problem; the canvases were.
	//
	// This is the same trade the PDF view makes for pages, for the same
	// reason and with the same margin: render ahead of the reader so a
	// block is ready before it is seen, and let go of the ones they have
	// scrolled well past.
	// Waits for the block to be in the layout, then watches it.
	//
	// The wait is the point. An IntersectionObserver's root has to be the
	// element that actually scrolls — Obsidian's `.markdown-preview-view`,
	// not the viewport — and at construction time this block is not in the
	// document yet, so there is nothing to find. That is the same reason
	// mountSurface measures its width when it mounts rather than here.
	//
	// Getting the root wrong is not a small miss: a margin measured against
	// the viewport buys nothing at all, because an ancestor that scrolls
	// clips the block to empty long before the viewport does. Observed with
	// a block 73px below the fold and a 400px margin — `isIntersecting` was
	// false against the viewport and true against the scroller. So the
	// look-ahead below only exists when the root is right, and without it a
	// block mounts at the instant it becomes visible and is drawn late.
	private watchVisibility(): void {
		let framesLeft = 5;

		// Whether this is a block coming straight back from its own save. See
		// recentlyMounted: it is the one case where waiting to be told the
		// block is visible shows the user an empty block instead of their ink.
		const remounting = wasRecentlyMounted(recoveryKey(this.ctx.sourcePath, this.blockId));

		const start = (): void => {
			if (this.detached) return;

			// Retried rather than assumed: one frame is normally enough, but
			// a block inside a folded section or an inactive tab can take
			// longer to land. Falling back to the viewport after a few tries
			// is a worse look-ahead, never a broken block.
			if (!this.surfaceEl.isConnected && framesLeft-- > 0) {
				this.watchHandle = window.requestAnimationFrame(start);
				return;
			}
			this.watchHandle = null;

			const root = findScrollParent(this.surfaceEl);

			// Straight back on screen, without waiting for the observer's first
			// report. Guarded on a measurable width because that is what
			// mountSurface scales the canvases by: a block inside a folded
			// section measures zero, and mounting it now would back it at the
			// stored size and leave it there. Those wait, as they always did.
			if (remounting && this.surfaceEl.clientWidth > 0) this.mountSurface();

			// Two observers rather than one, because mounting and releasing
			// happen at different distances and a single observer only has
			// the one boundary. Each ignores the edge that is not its own.
			const mount = new IntersectionObserver(
				(entries) => {
					if (entries.some((entry) => entry.isIntersecting)) this.mountSurface();
				},
				{ root, rootMargin: SURFACE_MOUNT_MARGIN },
			);
			const release = new IntersectionObserver(
				(entries) => {
					if (entries.every((entry) => !entry.isIntersecting)) this.releaseSurface();
				},
				{ root, rootMargin: SURFACE_RELEASE_MARGIN },
			);

			for (const observer of [mount, release]) {
				observer.observe(this.surfaceEl);
				this.observers.push(observer);
			}
		};

		// A remount skips the frame's wait entirely when the element is
		// already in the document, which on a re-render it usually is.
		if (remounting && this.surfaceEl.isConnected) {
			start();
			return;
		}
		this.watchHandle = window.requestAnimationFrame(start);
	}

	private mountSurface(): void {
		if (this.mounted || this.detached) return;
		this.mounted = true;

		// Measured here rather than in the constructor: a block is not in
		// the layout when its post-processor runs, so it reports a width of
		// zero and every canvas came out backed at the stored size — which
		// is exactly the softness this was meant to fix.
		const previous = this.scale;
		this.scale = this.targetScale();
		const width = this.data.width * this.scale;
		const height = this.data.height * this.scale;

		this.controller.mountPage(BLOCK_PAGE, this.contentEl, width, height);
		this.mountedSize = { width, height };
		// Zoomed where it was before the save that rebuilt it.
		if (this.retained.zoom) this.controller.restorePageZoom(BLOCK_PAGE, this.retained.zoom);

		if (!this.seeded) {
			// Only ever on the first mount, and only once the storage has shown
			// this block something. mountPage repaints from the store, which is
			// the live truth once anything has been drawn, so reseeding on a
			// remount would put the stored version back and throw away every
			// stroke made since.
			if (this.loaded) this.seed();
		} else if (Math.abs(previous - this.scale) > 0.001) {
			// The column changed width, or the note moved to another screen.
			// Everything in the store is in the old surface units and has to
			// come with it.
			const factor = this.scale / previous;
			this.controller.resizePage(
				BLOCK_PAGE,
				width,
				height,
				this.controller.getPageAnnotations(BLOCK_PAGE).map((a) => scaleAnnotationUniform(a, factor)),
			);
		}
		this.rescaleHistory();
		markRecentlyMounted(recoveryKey(this.ctx.sourcePath, this.blockId));
	}

	private releaseSurface(): void {
		if (!this.mounted) return;
		// Never mid-stroke: unmounting would take the surface out from under
		// a pen that is still down. A gesture cannot outlast a scroll by
		// much, so the next callback picks it up.
		if (this.controller.isGestureActive()) return;
		this.mounted = false;
		this.mountedSize = null;
		// The store keeps this page’s annotations, so remounting redraws them
		// without touching the file.
		this.controller.unmountPage(BLOCK_PAGE);
	}

	scheduleWrite(): void {
		if (this.detached || !this.writable()) return;
		if (this.writeHandle !== null) window.clearTimeout(this.writeHandle);
		this.writeHandle = window.setTimeout(() => void this.write(), WRITE_DEBOUNCE_MS);
	}

	private async write(): Promise<void> {
		this.writeHandle = null;
		if (this.detached || !this.loaded) return;

		// Refused after it was drawn in — an in-note block found damaged by a
		// sync, or an ink file deleted inside the debounce. What is on screen
		// was never saved, and the refusal is exactly why it cannot be now, so
		// it is held somewhere that survives a quit rather than dropped.
		if (this.refusal !== null) {
			if (this.seeded) {
				this.data = { ...this.data, annotations: this.toStored(this.controller.getPageAnnotations(BLOCK_PAGE)) };
			}
			unsavedInk.hold(this.storage.rescuePath, this.blockId, this.data, this.storage.rescueSource());
			unsavedInk.persist(this.storage.rescuePath, this.blockId);
			this.holdingUnsaved = true;
			this.storage.heldWhileRefused?.();
			return;
		}

		// Saving can re-render this block; doing that mid-stroke would destroy
		// the surface the stroke is being drawn on. Gestures are short, so
		// waiting one out costs nothing.
		if (this.controller.isGestureActive()) {
			this.writeHandle = window.setTimeout(() => void this.write(), GESTURE_RETRY_MS);
			return;
		}

		// The store is only the truth once it has been seeded. A block that
		// has never been mounted — one recovering unsaved ink while still
		// scrolled off screen, most importantly — has an *empty* store, and
		// writing that would erase the drawing this save exists to protect.
		if (this.seeded) {
			this.data = { ...this.data, annotations: this.toStored(this.controller.getPageAnnotations(BLOCK_PAGE)) };
		}
		// Held from here on, not only on failure. Every path a storage takes can
		// end without writing, and each of those used to leave the drawing on
		// screen and nothing stored, which the next re-render then discarded.
		// Holding first and forgetting on success means the only way to lose
		// ink is to lose the session.
		unsavedInk.hold(this.storage.rescuePath, this.blockId, this.data, this.storage.rescueSource());

		// The storage call starts synchronously, before the first await, so a
		// block flushing its save as it is torn down still gets it started.
		this.writing = true;
		let result: StorageWriteResult;
		try {
			result = await this.storage.write(this.data);
		} finally {
			this.writing = false;
		}

		// Before afterWrite, which may show the storage's version of the block:
		// a save that did not land must already count as unsaved work by then,
		// or that version goes on screen over the ink the save was for.
		switch (result.kind) {
			case 'saved':
				this.holdingUnsaved = false;
				unsavedInk.forget(this.storage.rescuePath, this.blockId);
				break;
			case 'retry':
				// Written out before the retry rather than after the last one.
				// Retries usually resolve within a few seconds, but those are
				// seconds in which the only copy is in memory, and a crash is
				// exactly the event this exists for.
				this.holdingUnsaved = true;
				unsavedInk.persist(this.storage.rescuePath, this.blockId);
				if (this.writeHandle !== null) window.clearTimeout(this.writeHandle);
				this.writeHandle = window.setTimeout(() => void this.write(), result.afterMs);
				break;
			case 'held':
				this.holdingUnsaved = true;
				unsavedInk.persist(this.storage.rescuePath, this.blockId);
				break;
		}
		this.storage.afterWrite?.();
	}

	// Stored units to surface units and back. The only two places the two
	// spaces meet: everything the controller sees is surface, everything
	// in the file is stored.
	private toSurface(annotations: Annotation[]): Annotation[] {
		if (this.scale === 1) return annotations;
		return annotations.map((annotation) => scaleAnnotationUniform(annotation, this.scale));
	}

	private toStored(annotations: Annotation[]): Annotation[] {
		if (this.scale === 1) return annotations;
		return annotations.map((annotation) => scaleAnnotationUniform(annotation, 1 / this.scale));
	}

	detach(): void {
		if (this.watchHandle !== null) {
			window.cancelAnimationFrame(this.watchHandle);
			this.watchHandle = null;
		}
		for (const observer of this.observers) observer.disconnect();
		this.observers = [];
		if (this.writeHandle !== null) {
			window.clearTimeout(this.writeHandle);
			this.writeHandle = null;
			// Flush before tearing down, or ink drawn in the last moment
			// before a re-render (scrolling far enough away is enough to
			// cause one) would be lost.
			void this.write();
		}
		this.detached = true;
		this.storage.close();
		this.disposeToolbar?.();
		this.disposeToolbar = null;
		// destroy, not unmountAll: this controller is one of many built over
		// the plugin-wide ToolState, and only this drops its subscription to
		// it. Every save rebuilds this view, so a controller left subscribed
		// would be a controller leaked per save.
		this.controller.destroy();
	}
}

// Binds a block's lifetime to the rendered element, so one that scrolls out
// of the rendered region — or a note that closes — takes its controller,
// toolbar and pending write down with it.
class InkBlockChild extends MarkdownRenderChild {
	private view: InkBlockView | null = null;

	constructor(
		containerEl: HTMLElement,
		private readonly create: () => InkBlockView,
	) {
		super(containerEl);
	}

	onload(): void {
		this.view = this.create();
	}

	onunload(): void {
		this.view?.detach();
		this.view = null;
	}
}

export interface InkBlockOptions {
	captionsEnabled: () => boolean;
	/** What holding a stylus's side button does (see the setting). */
	penButton?: () => 'eraser' | 'highlighter' | 'select' | 'none';
	/** Where a new block's ink file goes, for a note at this path. */
	inkFilePathFor: (notePath: string) => Promise<string>;
}

// The block is created in the ink file before its fence goes into the note.
//
// A fence naming a block its file does not hold is a missing block — pasted
// from another vault, or arrived before its file did — and is refused rather
// than saved, because saving it would put a new drawing where an existing one
// may yet arrive. Creating the entry first is what lets that rule be absolute:
// a block this command inserted is never mistaken for one that is missing.
// An empty block costs about forty bytes.
async function insertInkFileBlock(stores: InkFileStores, editor: Editor, resolvePath: () => Promise<string>): Promise<void> {
	// Where the command was run, taken before anything is awaited: typing or
	// clicking elsewhere meanwhile moves the selection, and the block belongs
	// where it was asked for.
	const from = editor.getCursor('from');
	const before = editor.getValue();
	let path: string;
	try {
		path = await resolvePath();
	} catch {
		new Notice('Inkling: could not work out where this note’s ink file goes, so no ink block was inserted.');
		return;
	}
	if (!isVaultPath(path)) {
		new Notice(`Inkling: ${path} is not a place in the vault an ink file can go, so no ink block was inserted. Check where new ink files go in settings.`);
		return;
	}
	const id = createId();
	const store = stores.acquire(path);
	try {
		await store.load();
		const outcome = await store.createBlock(id, emptyFileBlock());
		if (outcome.kind !== 'written') {
			new Notice(`Inkling: could not add a drawing to ${path}, so no ink block was inserted.`);
			return;
		}
		// Trailing newline so the cursor ends up on a fresh line after the
		// block rather than inside the fence.
		const fence = `${inkFenceMarkdown({ file: path, id, extra: [] })}\n`;
		if (editor.getValue() === before) {
			editor.replaceSelection(fence);
		} else {
			// The note changed, so a selection that was there may not be now:
			// inserted at its start rather than put over whatever is there.
			// A start past a shortened note goes at its end.
			const last = editor.lineCount() - 1;
			const at = from.line > last ? { line: last, ch: editor.getLine(last).length } : { line: from.line, ch: Math.min(from.ch, editor.getLine(from.line).length) };
			editor.replaceRange(fence, at);
		}
	} finally {
		stores.release(path);
	}
}

export interface InkBlockRegistration {
	/** Settles once every ink file store has run what it has queued. */
	whenIdle(): Promise<void>;
}

export function registerInkBlock(plugin: Plugin, toolState: ToolState, options: InkBlockOptions): InkBlockRegistration {
	// Once per load. Entries belong to blocks that may never be opened again,
	// so nothing else will ever expire them, and localStorage is small enough
	// that a fortnight of abandoned drawings is worth sweeping out.
	unsavedInk.purgeExpired();

	// One per load, shared by every block naming the same ink file.
	const vault = plugin.app.vault;
	const stores = new InkFileStores(vaultInkFileIO(vault));
	plugin.registerEvent(vault.on('modify', (file) => stores.fileChanged(file.path)));
	plugin.registerEvent(vault.on('create', (file) => stores.fileChanged(file.path)));
	plugin.registerEvent(vault.on('delete', (file) => stores.fileDeleted(file.path)));
	plugin.registerEvent(vault.on('rename', (file, oldPath) => stores.fileRenamed(oldPath, file.path)));

	plugin.registerMarkdownCodeBlockProcessor(INK_BLOCK_LANGUAGE, (source, el, ctx) => {
		ctx.addChild(
			new InkBlockChild(el, () => {
				// Decided by the fence's own content, so a vault can hold both
				// formats indefinitely and neither is a fallback for the other.
				const storage = isInkFileFence(source)
					? new InkFileStorage(stores, parseInkFence(source))
					: new InNoteStorage(plugin, ctx, el, source);
				return new InkBlockView(plugin, ctx, el, storage, toolState, options.captionsEnabled, options.penButton);
			}),
		);
	});

	plugin.addCommand({
		id: 'insert-ink-block',
		name: 'Insert ink annotation block',
		// Command palette only, per the plan — no ribbon icon, so it's
		// reachable the same way on desktop and mobile.
		editorCallback: (editor, ctx) => {
			const notePath = ctx.file?.path;
			if (!notePath) {
				new Notice('Inkling: this note has no file yet, so there is nowhere to name its ink file.');
				return;
			}
			void insertInkFileBlock(stores, editor, () => options.inkFilePathFor(notePath));
		},
	});

	return { whenIdle: () => stores.whenIdle() };
}
