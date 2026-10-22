import annotationWriterWorkerSource from 'inline-worker:annotation-writer';
import pdfWorkerSource from 'inline-worker:pdf';
import { FileView, ItemView, MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { ToolState } from './annotate';
import { normalizeToolbarLayout } from './annotate/toolbarLayout';
import { collectAnnotations } from './extract/extract';
import { extractionNotePath, mergeIntoNote, renderExtraction } from './extract/extractFormat';
import { compactInkBlocks } from './markdown/compactInkBlocks';
import { registerInkBlock } from './markdown/inkBlock';
import { inkFilePathFor } from './markdown/inkFilePath';
import { registerNoteCreation } from './noteCreation';
import { attachThumbnailMenu } from './pageMenu';
import { readCorePdfPage } from './coreViews';
import { startStylusCheck } from './stylusCheck';
import { BackupModal, listBackups } from './backups';
import { setAnnotationWriterWorkerSourceProvider } from './pdf/annotationWriterClient';
import { CORE_PDF_VIEW_TYPE, PdfAnnotateView, VIEW_TYPE_PDF } from './pdfView';
import { defaultSettings, normalizeSettings, type InklingSettings } from './settings';
import { InklingSettingTab } from './settingsTab';

// Where this device keeps its toolbar layout, and the pen as it was last
// left: the tool in hand and each tool's colour and width. Local storage,
// not the plugin's data.json: that file syncs, and the strip a phone wants
// is not the strip a desktop wants — nor is a stylus's pen width a mouse's.
// Obsidian scopes the keys to the vault.
const TOOLBAR_LAYOUT_KEY = 'inkling-expanded:toolbar-layout';
const TOOL_STATE_KEY = 'inkling-expanded:tool-state';
// Dragging the width slider changes the width on every pixel. Written once
// it stops, not on each one.
const TOOL_STATE_SAVE_DELAY_MS = 400;

export default class InklingPlugin extends Plugin {
	// Leaves we've already added the "Annotate with Inkling" action to —
	// active-leaf-change fires repeatedly for the same leaf, and addAction
	// has no de-dupe of its own, so without this the button would multiply.
	private readonly decoratedViews = new WeakSet<ItemView>();
	// The action buttons added to core PDF views, kept so onunload can take
	// them back off again.
	private readonly actions: HTMLElement[] = [];
	// The blob: URL pdf.js starts its worker from, revoked at unload.
	private pdfWorkerUrl: string | null = null;
	// The selected tool, its color and its width, held once for the whole
	// plugin rather than per drawing surface. A Markdown ink block's
	// controller is destroyed and rebuilt every time the block saves — which
	// is a second after every burst of handwriting — so tool state kept
	// inside one silently reverted to the defaults mid-page. Living here it
	// outlives those rebuilds, and it means the pen carries between blocks
	// and PDFs the way a real one does. See src/annotate/toolState.ts.
	private readonly toolState = new ToolState();
	private reportedLocalSaveFailure = false;
	// Read once on load and handed around by reference, never by
	// snapshot, so changing a setting takes effect without reopening a
	// file. Initialised to the defaults so nothing has to cope with it
	// being absent during the async load below.
	settings: InklingSettings = defaultSettings();

	async onload() {
		this.settings = normalizeSettings(await this.loadData());
		this.addSettingTab(new InklingSettingTab(this.app, this));
		// Applied here rather than inside ToolState, which has no idea
		// settings exist — it is shared with surfaces that have no
		// settings tab behind them.
		this.toolState.setToolbarCollapsed(this.settings.toolbarStartsCollapsed);
		this.loadDeviceToolbar();

		this.configurePdfWorker();
		this.configureAnnotationWriterWorker();

		this.registerView(VIEW_TYPE_PDF, (leaf) => new PdfAnnotateView(leaf, this.toolState, () => this.settings));
		registerNoteCreation(this, () => ({
			template: this.settings.defaultTemplate,
			pageSize: this.settings.pageSize,
			canvasMode: this.settings.defaultCanvasMode,
		}));
		registerInkBlock(this, this.toolState, {
			captionsEnabled: () => this.settings.blockCaptions,
			penButton: () => this.settings.penButton,
			inkFilePathFor: (notePath) =>
				inkFilePathFor(
					notePath,
					this.settings.inkFileLocation,
					this.settings.inkFileFolder,
					(name, source) => this.app.fileManager.getAvailablePathForAttachment(name, source),
				),
		});

		// Obsidian's own core PDF view stays the default for opening a .pdf —
		// full native chrome (page number, zoom, outline) and no pdf-lib
		// parsing cost. Inkling used to unclaim the "pdf" extension outright
		// and replace it everywhere, which is what lost that chrome and made
		// every PDF open pay pdf-lib's parse cost up front, whether or not
		// the user ever intended to annotate. Now editing is opt-in: a
		// "pencil" action added to core PDF leaves below swaps just that leaf
		// into VIEW_TYPE_PDF, and Inkling's own view offers a matching action
		// back to the core view (see PdfAnnotateView.exitEditMode).
		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => this.decorateIfCorePdfLeaf(leaf)));
		this.app.workspace.onLayoutReady(() => {
			for (const leaf of this.app.workspace.getLeavesOfType(CORE_PDF_VIEW_TYPE)) this.decorateIfCorePdfLeaf(leaf);
		});

		this.addCommand({
			// Not "…with Inkling": Obsidian already prefixes a command with
			// the plugin's name in the palette, so saying it again reads as
			// "Inkling: Annotate this PDF with Inkling".
			id: 'annotate-pdf',
			name: 'Annotate this PDF',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(FileView);
				if (!view || view.getViewType() !== CORE_PDF_VIEW_TYPE) return false;
				if (!checking) void this.switchToInkling(view.leaf);
				return true;
			},
		});

		// Undo and redo as palette commands as well as view-scoped keys.
		// Registered with no default hotkey, per Obsidian guidelines: the bare
		// Mod+Z inside the annotate view already covers the ergonomics, and
		// these exist so someone who wants a global binding can make one
		// without us claiming a shortcut out from under another plugin.
		this.addCommand({
			id: 'undo-annotation',
			name: 'Undo annotation',
			checkCallback: (checking) => this.withAnnotateView(checking, (view) => view.undoAnnotation()),
		});

		this.addCommand({
			id: 'check-stylus-input',
			name: 'Check stylus input (side button, eraser, pressure)',
			callback: () => startStylusCheck(activeWindow),
		});

		// The way back from a rebuild that went wrong — see backups.ts.
		this.addCommand({
			id: 'restore-pdf-backup',
			name: 'Restore an earlier version of this PDF',
			checkCallback: (checking) => {
				const file = this.activePdfFile();
				if (!file) return false;
				if (!checking) {
					void listBackups(this.app, file).then((backups) => {
						if (backups.length === 0) new Notice(`Inkling: there is no earlier version of “${file.basename}” on this device.`);
						else new BackupModal(this.app, file, backups).open();
					});
				}
				return true;
			},
		});

		this.addCommand({
			id: 'toggle-touch-drawing',
			name: 'Toggle drawing with finger',
			callback: () => this.toolState.setTouchDrawing(!this.toolState.isTouchDrawing()),
		});

		this.addCommand({
			id: 'redo-annotation',
			name: 'Redo annotation',
			checkCallback: (checking) => this.withAnnotateView(checking, (view) => view.redoAnnotation()),
		});

		this.addCommand({
			id: 'compact-ink-blocks',
			name: 'Compact and repair ink blocks in this note',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
				if (!file) return false;
				if (!checking) void this.compactInkBlocksIn(file);
				return true;
			},
		});

		this.addCommand({
			id: 'extract-annotations',
			name: 'Extract annotations to a note',
			checkCallback: (checking) => {
				const file = this.activePdfFile();
				if (!file) return false;
				if (!checking) void this.extractAnnotations(file);
				return true;
			},
		});
	}

	// The PDF the user is looking at, whichever view is showing it —
	// Inkling’s own or Obsidian’s. Extraction is read-only, so it has no
	// reason to care which.
	private activePdfFile(): TFile | null {
		const view = this.app.workspace.getActiveViewOfType(FileView);
		const file = view?.file ?? null;
		return file && file.extension.toLowerCase() === 'pdf' ? file : null;
	}

	private async extractAnnotations(file: TFile): Promise<void> {
		const notice = new Notice(`Inkling: reading ${file.basename}…`, 0);
		try {
			// Anything still sitting in a debounce belongs in the file before it
			// is read, or the last minute of highlighting is simply missing
			// from the note — and the user has no way to tell that from "the
			// extraction dropped it".
			const view = this.app.workspace.getActiveViewOfType(PdfAnnotateView);
			if (view?.file?.path === file.path) await view.flushPendingWrites();

			const annotations = await collectAnnotations(await this.app.vault.readBinary(file), {
				onProgress: (pageNumber, pageCount) => {
					notice.setMessage(`Inkling: reading ${file.basename} — page ${pageNumber} of ${pageCount}`);
				},
			});

			const path = extractionNotePath(this.settings.extractionNotePattern, file.path);
			const generated = renderExtraction(file.path, annotations, this.settings.colorLabels);

			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				// process, not modify: it reads and writes under one lock, so a
				// note being edited in another pane cannot be clobbered by a
				// stale copy read a moment ago.
				await this.app.vault.process(existing, (contents) => mergeIntoNote(contents, generated));
			} else {
				await this.app.vault.create(path, mergeIntoNote('', generated));
			}

			notice.hide();
			new Notice(
				annotations.length === 0
					? `Inkling: no annotations found in ${file.basename}.`
					: `Inkling: extracted ${annotations.length} annotations from ${file.basename}.`,
			);

			const note = this.app.vault.getAbstractFileByPath(path);
			if (note instanceof TFile) await this.app.workspace.getLeaf('tab').openFile(note);
		} catch (error) {
			notice.hide();
			console.error('Inkling: failed to extract annotations.', error);
			new Notice('Inkling: could not extract annotations from this PDF.');
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// Runs `act` on the active annotate view, or reports that there is none.
	// The checking pass must not act, which is the whole contract of
	// checkCallback and easy to get subtly wrong when it is inlined.
	// Thins the strokes in every ink block in a note, for blocks written
	// before strokes were thinned as they were drawn (see
	// annotate/simplify.ts).
	//
	// Through the vault rather than the open editor, unlike the ink block
	// save path. That path makes a small, targeted replaceRange inside one
	// fence; this rewrites the whole document, and setValue on a view in
	// preview mode does not survive — the view re-syncs from the file and
	// the change is simply gone, which is exactly what happened the first
	// time this was written that way. vault.process is atomic and does not
	// care which mode the note is being viewed in.
	//
	// The cost is that this is not a single editor undo step. It is the one
	// operation in the plugin that deliberately discards detail, so it says
	// so plainly, and Obsidian's own file recovery is the way back.
	private async compactInkBlocksIn(file: TFile): Promise<void> {
		const source = await this.app.vault.read(file);
		const result = compactInkBlocks(source);

		const unreadable = result.skipped > 0 ? ` ${result.skipped} could not be read and were left alone.` : '';

		if (result.blocks === 0) {
			new Notice(`Inkling: nothing to compact in this note.${unreadable}`);
			return;
		}

		try {
			let wrote = false;
			await this.app.vault.process(file, (current) => {
				// Refuses rather than overwrites if the note moved under us
				// between reading it and writing it back. Recomputing here
				// instead would mean silently compacting something the user
				// has not seen the numbers for.
				if (current !== source) return current;
				wrote = true;
				return result.content;
			});

			if (!wrote) {
				new Notice('Inkling: the note changed while compacting, so nothing was written. Try again.');
				return;
			}
		} catch (error) {
			console.error('Inkling: failed to compact ink blocks.', error);
			new Notice('Inkling: could not compact this note. Nothing was changed.');
			return;
		}

		const dropped =
			result.pointsBefore > 0 ? Math.round(((result.pointsBefore - result.pointsAfter) / result.pointsBefore) * 100) : 0;
		const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
		// Named separately because they are different repairs: thinning is
		// about size, an id is about a block being findable at all when it
		// comes to save.
		const ids = result.stamped > 0 ? ` ${result.stamped} block${result.stamped === 1 ? '' : 's'} given an id.` : '';
		new Notice(
			`Inkling: rewrote ${result.blocks} ink block${result.blocks === 1 ? '' : 's'} — ` +
				`${dropped}% fewer points, ${mb(source.length)} to ${mb(result.content.length)}.${ids}${unreadable}`,
			10_000,
		);
	}

	private withAnnotateView(checking: boolean, act: (view: PdfAnnotateView) => void): boolean {
		const view = this.app.workspace.getActiveViewOfType(PdfAnnotateView);
		if (!view) return false;
		if (!checking) act(view);
		return true;
	}

	// Read before anything subscribes, so restoring what was stored is not
	// mistaken for a change and written straight back.
	private loadDeviceToolbar(): void {
		try {
			this.toolState.setToolbarLayout(normalizeToolbarLayout(this.app.loadLocalStorage(TOOLBAR_LAYOUT_KEY)));
			this.toolState.restore(this.app.loadLocalStorage(TOOL_STATE_KEY));
		} catch (error) {
			// Storage that cannot be read costs the toolbar its arrangement
			// and the pen its last settings, not the plugin: both start from
			// their defaults.
			console.warn('Inkling: could not read the toolbar from this device.', error);
		}

		let pendingSave: number | null = null;
		const saveToolState = () => {
			if (pendingSave !== null) window.clearTimeout(pendingSave);
			pendingSave = null;
			this.saveLocally(TOOL_STATE_KEY, this.toolState.snapshot(), 'the pen settings');
		};
		this.register(
			this.toolState.subscribe((change) => {
				if (change === 'layout') {
					this.saveLocally(TOOLBAR_LAYOUT_KEY, this.toolState.getToolbarLayout(), 'the toolbar layout');
				} else if (change === 'tool' || change === 'style') {
					if (pendingSave !== null) window.clearTimeout(pendingSave);
					pendingSave = window.setTimeout(saveToolState, TOOL_STATE_SAVE_DELAY_MS);
				}
			}),
		);
		// A change still waiting out the delay when the plugin stops is
		// written now rather than lost.
		this.register(() => {
			if (pendingSave !== null) saveToolState();
		});
	}

	private saveLocally(key: string, value: unknown, what: string): void {
		try {
			this.app.saveLocalStorage(key, value);
		} catch (error) {
			console.error(`Inkling: could not save ${what} on this device.`, error);
			// Once: storage that refuses one write refuses every write, and
			// the pen changes many times a minute.
			if (this.reportedLocalSaveFailure) return;
			this.reportedLocalSaveFailure = true;
			new Notice(`Inkling: ${what} could not be saved on this device, and will apply only until Obsidian restarts.`);
		}
	}

	onunload(): void {
		// The "annotate" buttons live on Obsidian's *own* PDF views, not on
		// anything this plugin owns and Obsidian would tear down for it — so
		// without this they'd outlive the plugin, still sitting in the
		// toolbar of every open PDF with nothing behind them.
		for (const action of this.actions) action.remove();
		this.actions.length = 0;
		if (this.pdfWorkerUrl) URL.revokeObjectURL(this.pdfWorkerUrl);
		this.pdfWorkerUrl = null;
	}

	private decorateIfCorePdfLeaf(leaf: WorkspaceLeaf | null): void {
		const view = leaf?.view;
		if (!leaf || !(view instanceof ItemView) || view.getViewType() !== CORE_PDF_VIEW_TYPE) return;
		if (this.decoratedViews.has(view)) return;
		this.decoratedViews.add(view);
		// Buttons belonging to PDF views that have since been closed went out
		// of the document with them, but stayed in this array — which only
		// ever grew, for the whole session, one entry per PDF ever opened.
		// Dropping them here keeps it to what actually still needs removing
		// at unload.
		for (let i = this.actions.length - 1; i >= 0; i--) {
			const action = this.actions[i];
			if (action && !action.isConnected) this.actions.splice(i, 1);
		}
		this.actions.push(view.addAction('pencil', 'Annotate with Inkling', () => void this.switchToInkling(leaf)));
		// A long press or right-click on a page thumbnail: copy a link to the
		// page, or delete it. See pageMenu.ts.
		if (view instanceof FileView) {
			attachThumbnailMenu(this.app, view, (el, handler) => this.registerDomEvent(el, 'contextmenu', handler, { capture: true }));
		}
	}

	private async switchToInkling(leaf: WorkspaceLeaf): Promise<void> {
		const view = leaf.view;
		const file = view instanceof FileView ? view.file : null;
		if (!file) return;
		// Carries over whatever page the native view was showing, rather than
		// always reopening at page 1. Read *before* the state swap below,
		// while `leaf`'s view is still the native one whose position this is.
		const page = readCorePdfPage(view);
		await leaf.setViewState({ type: VIEW_TYPE_PDF, state: { file: file.path } }, page === null ? undefined : { page });
	}

	// Both workers are embedded in main.js (see esbuild.config.mjs for why),
	// so pdf.js gets a same-origin blob: URL of the worker's source. Should a
	// module worker still fail to start, pdf.js imports the same URL on the
	// main thread instead, which is slower but still opens the book.
	private configurePdfWorker() {
		this.pdfWorkerUrl = URL.createObjectURL(new Blob([pdfWorkerSource], { type: 'text/javascript' }));
		GlobalWorkerOptions.workerSrc = this.pdfWorkerUrl;
	}

	// See src/pdf/annotationWriter.worker.ts — runs pdf-lib's parse/mutate/
	// save off the main thread so saving a heavily-annotated PDF can't stall
	// pointer input while the user is actively writing. The client builds
	// the worker from a same-origin blob of this source (see its comment).
	private configureAnnotationWriterWorker() {
		setAnnotationWriterWorkerSourceProvider(() => Promise.resolve(annotationWriterWorkerSource));
	}
}
