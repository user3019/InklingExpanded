import { App, Modal, Notice, Plugin, TFile, TFolder, normalizePath, setIcon } from 'obsidian';
import { toArrayBuffer } from './binary';
import { VIEW_TYPE_PDF } from './pdfView';
import {
	CANVAS_MODE_LABELS,
	CANVAS_MODES,
	createHandwrittenNoteBytes,
	TEMPLATE_STYLE_LABELS,
	TEMPLATE_STYLES,
	TemplateStyle,
	type CanvasMode,
	type PageSizeName,
} from './templates';

// The two settings note creation cares about, passed in rather than
// reached for: this module is handed a Plugin, not the Inkling plugin,
// and widening that just to read two fields would tie it to the app
// class for no benefit.
export interface NoteCreationDefaults {
	template: TemplateStyle;
	pageSize: PageSizeName;
	canvasMode: CanvasMode;
}

const DEFAULT_NAME = 'Untitled note';
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|]/g;

class CreateHandwrittenNoteModal extends Modal {
	private name = DEFAULT_NAME;
	private style: TemplateStyle;
	private mode: CanvasMode;

	constructor(
		app: App,
		defaultStyle: TemplateStyle,
		defaultMode: CanvasMode,
		private readonly onSubmit: (name: string, style: TemplateStyle, mode: CanvasMode) => void,
	) {
		super(app);
		// The dropdown opens on the preferred template, but stays a
		// dropdown: a default is a starting point, not a decision made on
		// the user’s behalf every time.
		this.style = defaultStyle;
		this.mode = defaultMode;
	}

	onOpen(): void {
		this.setTitle('New handwritten note');
		this.modalEl.addClass('inkling-create-note');
		this.contentEl.addClass('inkling-create-note-modal');

		const nameField = this.contentEl.createDiv({ cls: 'inkling-create-field' });
		nameField.createEl('label', { cls: 'inkling-create-label', text: 'Name', attr: { for: 'inkling-create-name' } });
		const nameInput = nameField.createEl('input', { cls: 'inkling-create-name', attr: { id: 'inkling-create-name', type: 'text' } });
		nameInput.placeholder = DEFAULT_NAME;
		nameInput.value = this.name;
		nameInput.addEventListener('input', () => (this.name = nameInput.value));
		nameInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') this.submit();
		});
		nameField.createDiv({ cls: 'inkling-create-hint', text: 'Saved as a PDF beside the note you have open.' });

		// Tiles to tap rather than dropdowns: on a tablet a dropdown is a
		// second screen to open and close, and a tile shows what it is.
		this.choices(
			'Paper',
			CANVAS_MODES.map((mode) => ({
				value: mode,
				label: CANVAS_MODE_LABELS[mode],
				hint: mode === 'infinite' ? 'Grows as you write' : 'Add pages as you go',
				icon: mode === 'infinite' ? 'infinity' : 'files',
			})),
			() => this.mode,
			(mode) => (this.mode = mode),
		);
		this.choices(
			'Background',
			TEMPLATE_STYLES.map((style) => ({ value: style, label: TEMPLATE_STYLE_LABELS[style], pattern: style })),
			() => this.style,
			(style) => (this.style = style),
		);

		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.type = 'button';
		cancel.addEventListener('click', () => this.close());
		const create = buttons.createEl('button', { cls: 'mod-cta', text: 'Create' });
		create.type = 'button';
		create.addEventListener('click', () => this.submit());

		nameInput.focus();
		nameInput.select();
	}

	// A row of tiles, one per option, of which one is chosen.
	private choices<T extends string>(
		title: string,
		options: Array<{ value: T; label: string; hint?: string; icon?: string; pattern?: TemplateStyle }>,
		current: () => T,
		choose: (value: T) => void,
	): void {
		const group = this.contentEl.createDiv({ cls: 'inkling-create-field' });
		group.createDiv({ cls: 'inkling-create-label', text: title });
		const row = group.createDiv({ cls: 'inkling-choice-row' });
		row.setAttribute('role', 'radiogroup');
		row.setAttribute('aria-label', title);
		const tiles: Array<{ value: T; tile: HTMLButtonElement }> = [];
		const show = () => {
			for (const { value, tile } of tiles) {
				const chosen = value === current();
				tile.toggleClass('is-chosen', chosen);
				tile.setAttribute('aria-checked', String(chosen));
			}
		};
		for (const option of options) {
			const tile = row.createEl('button', { cls: 'inkling-choice' });
			tile.type = 'button';
			tile.setAttribute('role', 'radio');
			const preview = tile.createDiv({ cls: 'inkling-choice-preview' });
			if (option.pattern) preview.addClass(`is-${option.pattern}`);
			if (option.icon) setIcon(preview, option.icon);
			tile.createDiv({ cls: 'inkling-choice-label', text: option.label });
			if (option.hint) tile.createDiv({ cls: 'inkling-choice-hint', text: option.hint });
			tile.addEventListener('click', () => {
				choose(option.value);
				show();
			});
			tiles.push({ value: option.value, tile });
		}
		show();
	}

	private submit(): void {
		const name = this.name.trim();
		if (!name) return;
		this.close();
		this.onSubmit(name, this.style, this.mode);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function sanitizeFilename(name: string): string {
	return name.replace(INVALID_FILENAME_CHARS, '-').trim() || DEFAULT_NAME;
}

function getUniqueNotePath(app: App, folder: TFolder, baseName: string): string {
	const safeName = sanitizeFilename(baseName);
	const folderPath = folder.isRoot() ? '' : `${folder.path}/`;

	let candidate = normalizePath(`${folderPath}${safeName}.pdf`);
	let suffix = 1;
	while (app.vault.getAbstractFileByPath(candidate)) {
		candidate = normalizePath(`${folderPath}${safeName} ${++suffix}.pdf`);
	}
	return candidate;
}

async function createHandwrittenNote(
	app: App,
	folder: TFolder,
	baseName: string,
	style: TemplateStyle,
	pageSize: PageSizeName,
	mode: CanvasMode,
): Promise<TFile> {
	const path = getUniqueNotePath(app, folder, baseName);
	const bytes = await createHandwrittenNoteBytes(style, pageSize, mode);
	return app.vault.createBinary(path, toArrayBuffer(bytes));
}

function getTargetFolder(app: App): TFolder {
	return app.workspace.getActiveFile()?.parent ?? app.vault.getRoot();
}

function openCreateNoteModal(app: App, folder: TFolder, defaults: NoteCreationDefaults): void {
	new CreateHandwrittenNoteModal(app, defaults.template, defaults.canvasMode, (name, style, mode) => {
		void (async () => {
			try {
				const file = await createHandwrittenNote(app, folder, name, style, defaults.pageSize, mode);
				// A brand-new handwritten note is created specifically to be
				// written on right away — opened straight into Inkling's edit
				// view rather than `openFile`'s default extension resolution,
				// which (now that Inkling no longer claims .pdf outright, see
				// main.ts) would otherwise land on Obsidian's read-only core
				// PDF view first.
				await app.workspace.getLeaf(true).setViewState({ type: VIEW_TYPE_PDF, state: { file: file.path } });
			} catch (error) {
				console.error('Inkling: failed to create handwritten note.', error);
				new Notice('Inkling: could not create the handwritten note.');
			}
		})();
	}).open();
}

export function registerNoteCreation(plugin: Plugin, getDefaults: () => NoteCreationDefaults): void {
	const createInCurrentFolder = () => openCreateNoteModal(plugin.app, getTargetFolder(plugin.app), getDefaults());

	plugin.addCommand({
		id: 'create-handwritten-note',
		name: 'Create handwritten note',
		callback: createInCurrentFolder,
	});

	// The command palette and a folder's context menu are both a hunt on a
	// tablet; the side panel is one tap. Same icon as the folder menu entry,
	// so the two read as the same action.
	plugin.addRibbonIcon('pen-line', 'Create handwritten note', createInCurrentFolder);

	plugin.registerEvent(
		plugin.app.workspace.on('file-menu', (menu, file) => {
			if (!(file instanceof TFolder)) return;
			menu.addItem((item) =>
				item
					.setTitle('New handwritten note')
					.setIcon('pen-line')
					.onClick(() => openCreateNoteModal(plugin.app, file, getDefaults())),
			);
		}),
	);
}
