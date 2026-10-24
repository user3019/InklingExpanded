import { App, FileView, TFile } from 'obsidian';

// Obsidian's own PDF reader, from the outside — none of this is public API,
// so all of it is read defensively and does nothing when the shape is not
// what it expects.

const CORE_PDF_VIEW = 'pdf';

// This plugin's own annotate view (pdfView.ts takes its type from here), and
// what the rest of the plugin may ask of one that has a PDF open — without
// importing the view, which is the heavy module.
export const ANNOTATE_VIEW_TYPE = 'inkling-pdf-view';

export interface AnnotateViewHooks {
	file: TFile | null;
	flushPendingWrites(): Promise<void>;
	prepareForRestore(): Promise<void>;
	finishRestore(file: TFile): Promise<void>;
}

// Every annotate view with `file` open, in this window or any other.
export function annotateViewsOf(app: App, file: TFile): AnnotateViewHooks[] {
	const views: AnnotateViewHooks[] = [];
	for (const leaf of app.workspace.getLeavesOfType(ANNOTATE_VIEW_TYPE)) {
		const view = leaf.view as Partial<AnnotateViewHooks>;
		if (view.file?.path === file.path && typeof view.flushPendingWrites === 'function') views.push(view as AnnotateViewHooks);
	}
	return views;
}

// The page Obsidian's own PDF view is currently showing. Its ephemeral
// state is no help here — verified against the running app, the core PDF
// view's getEphemeralState() returns `{}` no matter where it's scrolled, so
// simply passing that through carried nothing over and the editor always
// opened at page 1 (what looked like it working was Obsidian's own
// per-file position memory, not us). This reads the live viewer instead,
// which is undocumented internals, hence the fully defensive walk and the
// null result callers must handle.
export function readCorePdfPage(view: unknown): number | null {
	const page = (
		view as {
			viewer?: { child?: { pdfViewer?: { pdfViewer?: { currentPageNumber?: unknown } } } };
		}
	)?.viewer?.child?.pdfViewer?.pdfViewer?.currentPageNumber;
	return typeof page === 'number' && Number.isFinite(page) && page >= 1 ? page : null;
}

// Rebuilds every reader showing `file`, at the page each was on.
//
// Obsidian's reader does reload a PDF that changes, but only the document:
// its page count in the toolbar and its strip of thumbnails stay as they
// were, so after a page was added or inserted the numbers no longer matched
// and the new pages had no thumbnail. Rebuilding the view from scratch —
// what Obsidian itself does when a view's settings change — makes all of it
// new. Called after every change this plugin makes to a PDF's pages.
export async function refreshCoreReaders(app: App, file: TFile): Promise<void> {
	for (const leaf of app.workspace.getLeavesOfType(CORE_PDF_VIEW)) {
		const view = leaf.view;
		if (!(view instanceof FileView) || view.file?.path !== file.path) continue;
		const page = readCorePdfPage(view);
		const rebuild = (leaf as unknown as { rebuildView?: () => Promise<void> }).rebuildView;
		if (typeof rebuild !== 'function') continue;
		try {
			await rebuild.call(leaf);
			if (page !== null) leaf.view.setEphemeralState({ subpath: `#page=${page}` });
		} catch (error) {
			console.warn('Inkling: could not refresh a PDF reader after changing its pages.', error);
		}
	}
}
