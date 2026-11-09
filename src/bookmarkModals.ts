import { App, Modal } from 'obsidian';

// Naming a bookmark, and being asked before one with others under it goes.

export class BookmarkNameModal extends Modal {
	constructor(
		app: App,
		private readonly heading: string,
		private readonly initial: string,
		private readonly onName: (title: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.heading);
		const input = this.contentEl.createEl('input', { cls: 'inkling-bookmark-name', type: 'text', value: this.initial });
		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.type = 'button';
		cancel.addEventListener('click', () => this.close());
		const save = buttons.createEl('button', { cls: 'mod-cta inkling-bookmark-save', text: 'Save' });
		save.type = 'button';
		const finish = () => {
			const title = input.value.trim();
			if (!title) return;
			this.close();
			this.onName(title);
		};
		save.addEventListener('click', finish);
		input.addEventListener('keydown', (event) => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			finish();
		});
		input.focus();
		input.select();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class RemoveBookmarkModal extends Modal {
	constructor(
		app: App,
		private readonly title: string,
		private readonly onRemove: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle('Remove this bookmark?');
		this.contentEl.createEl('p', { text: `“${this.title}” is removed from the PDF, with the bookmarks under it.` });
		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.type = 'button';
		cancel.addEventListener('click', () => this.close());
		const remove = buttons.createEl('button', { cls: 'mod-warning', text: 'Remove' });
		remove.type = 'button';
		remove.addEventListener('click', () => {
			this.close();
			this.onRemove();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
