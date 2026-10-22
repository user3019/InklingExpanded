import { App, FileView, Menu, Modal, Notice, TFile } from 'obsidian';
import { toArrayBuffer } from './binary';
import { removePage } from './pdf/pages';
import { writeBinarySafely } from './vaultWrite';
import { refreshCoreReaders } from './coreViews';
import { backUp } from './backups';

// The annotate view's type (pdfView.ts's VIEW_TYPE_PDF), named here rather
// than imported: pdfView.ts is the heavy module, and this menu runs in
// Obsidian's own reader.
const ANNOTATE_VIEW_TYPE = 'inkling-pdf-view';

// A menu on the page thumbnails of Obsidian's own PDF reader — a long press
// on a tablet, a right-click on a desktop — that can delete a page.
//
// Obsidian puts a menu there already, with one item, "Copy link to page",
// and no way for a plugin to add to it. So this one is shown instead, with
// that item first, exactly as Obsidian words and builds it, and the delete
// after it. It listens on the whole view in the capture phase, which is
// before Obsidian's own listener on the sidebar, and only for a thumbnail:
// a right-click anywhere else in the reader is left to Obsidian.
//
// The thumbnail's markup is pdf.js's (`.thumbnail` with `data-page-number`),
// which Obsidian keeps. Read defensively: a reader that changed it simply
// gets Obsidian's own menu back.

export function attachThumbnailMenu(app: App, view: FileView, register: (el: HTMLElement, handler: (event: MouseEvent) => void) => void): void {
	register(view.containerEl, (event) => {
		const target = event.target instanceof Element ? event.target : null;
		const thumbnail = target?.closest<HTMLElement>('.thumbnail');
		const pageNumber = Number(thumbnail?.dataset.pageNumber);
		const file = view.file;
		if (!thumbnail || !Number.isInteger(pageNumber) || pageNumber < 1 || !file || file.extension !== 'pdf') return;
		event.preventDefault();
		event.stopPropagation();

		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle('Copy link to page')
				.setIcon('lucide-copy')
				.onClick(() => {
					const link = app.fileManager.generateMarkdownLink(file, '', `#page=${pageNumber}`, `${file.basename}, page ${pageNumber}`);
					void view.containerEl.win.navigator.clipboard.writeText(link);
				}),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle('Delete page')
				.setIcon('trash-2')
				.setWarning(true)
				.onClick(() => new DeletePageModal(app, file, pageNumber).open()),
		);
		menu.showAtMouseEvent(event);
	});
}

// Asked first, because it cannot be undone from here: the page is gone from
// the file, not hidden.
class DeletePageModal extends Modal {
	constructor(
		app: App,
		private readonly file: TFile,
		private readonly pageNumber: number,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(`Delete page ${this.pageNumber}?`);
		this.contentEl.createEl('p', {
			text: `Page ${this.pageNumber} of “${this.file.basename}” is removed from the PDF for good, with everything drawn or written on it.`,
		});
		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.type = 'button';
		cancel.addEventListener('click', () => this.close());
		const remove = buttons.createEl('button', { cls: 'mod-warning', text: 'Delete page' });
		remove.type = 'button';
		remove.addEventListener('click', () => {
			this.close();
			void deletePage(this.app, this.file, this.pageNumber);
		});
		remove.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// Removes the page and writes the file. Obsidian's reader reloads a PDF that
// changes, and so does Inkling's annotate view, so whatever has it open
// shows the result.
export async function deletePage(app: App, file: TFile, pageNumber: number): Promise<boolean> {
	try {
		// The same PDF open to annotate, here: what is drawn there and not
		// saved yet goes into the file first, so the page is deleted from the
		// file as it really is — and that view then takes the deletion in as
		// it would one from another device.
		for (const leaf of app.workspace.getLeavesOfType(ANNOTATE_VIEW_TYPE)) {
			const view = leaf.view as Partial<{ file: TFile | null; flushPendingWrites(): Promise<void> }>;
			if (view.file?.path === file.path) await view.flushPendingWrites?.();
		}
		const before = await app.vault.readBinary(file);
		const result = await removePage(before, pageNumber);
		if (result.kind === 'refused') {
			new Notice(`Inkling: page ${pageNumber} was not deleted — ${result.reason}.`);
			return false;
		}
		await backUp(app, file, before, 'delete-page');
		await writeBinarySafely(app.vault, file, toArrayBuffer(result.bytes));
		await refreshCoreReaders(app, file);
		new Notice(`Inkling: deleted page ${pageNumber}. ${result.pageCount} ${result.pageCount === 1 ? 'page' : 'pages'} left.`);
		return true;
	} catch (error) {
		console.error('Inkling: failed to delete a page.', error);
		new Notice(`Inkling: could not delete page ${pageNumber}.`);
		return false;
	}
}
