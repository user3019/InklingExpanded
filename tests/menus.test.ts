// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openedModals, resetObsidianStubs } from './harness/obsidian';
import { openPdfView } from './harness/pdfView';
import { installSurfaceStubs } from './harness/surface';
import { registerNoteCreation } from '../src/noteCreation';

// The dialogs and panels around the drawing: the new-note dialog, the
// outline and find panel, and the note editor.

beforeEach(() => {
	document.body.innerHTML = '';
	resetObsidianStubs();
	installSurfaceStubs();
});

describe('the new-note dialog', () => {
	function openDialog() {
		const created: Array<{ path: string }> = [];
		const plugin = {
			app: {
				workspace: { getActiveFile: () => null, on: () => ({}), getLeaf: () => ({ setViewState: async () => undefined }) },
				vault: {
					getRoot: () => ({ path: '/', isRoot: () => true }),
					getAbstractFileByPath: () => null,
					createBinary: vi.fn(async (path: string) => {
						created.push({ path });
						return { path };
					}),
				},
			},
			addCommand: vi.fn((command: { callback: () => void }) => command.callback()),
			registerEvent: vi.fn(),
			addRibbonIcon: vi.fn(() => document.createElement('div')),
		};
		registerNoteCreation(plugin as never, () => ({ template: 'blank', pageSize: 'letter', canvasMode: 'pages' }));
		const modal = openedModals.at(-1) as unknown as { onOpen(): void; contentEl: HTMLElement; close(): void };
		modal.onOpen();
		document.body.appendChild(modal.contentEl);
		return { content: modal.contentEl, created, plugin };
	}

	const tiles = (content: HTMLElement, group: string) =>
		Array.from(content.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] .inkling-choice`));

	it('offers paper and background as tiles, the defaults chosen', () => {
		const { content } = openDialog();
		expect(tiles(content, 'Paper').map((tile) => tile.textContent)).toEqual(['PagesAdd pages as you go', 'Infinite canvasGrows as you write']);
		expect(tiles(content, 'Background')).toHaveLength(3);
		expect(tiles(content, 'Paper')[0]?.getAttribute('aria-checked')).toBe('true');
		expect(tiles(content, 'Background')[0]?.getAttribute('aria-checked')).toBe('true');
	});

	it('shows each background as a sample of its ruling', () => {
		const { content } = openDialog();
		const previews = tiles(content, 'Background').map((tile) => tile.querySelector('.inkling-choice-preview')?.className);
		expect(previews).toEqual(['inkling-choice-preview is-blank', 'inkling-choice-preview is-lined', 'inkling-choice-preview is-dot-grid']);
	});

	it('creates the note with what was chosen', async () => {
		const { content, created } = openDialog();
		const name = content.querySelector<HTMLInputElement>('.inkling-create-name');
		if (!name) throw new Error('no name field');
		name.value = 'Lecture 3';
		name.dispatchEvent(new Event('input'));
		tiles(content, 'Paper')[1]?.click();
		tiles(content, 'Background')[2]?.click();
		expect(tiles(content, 'Paper')[1]?.getAttribute('aria-checked')).toBe('true');
		content.querySelector<HTMLButtonElement>('.mod-cta')?.click();
		await vi.waitFor(() => expect(created).toHaveLength(1));
		expect(created[0]?.path).toBe('Lecture 3.pdf');
	});
});

describe('the outline and find panel', () => {
	function openPanel() {
		const harness = openPdfView();
		const view = harness.view as unknown as {
			contentEl: HTMLElement;
			buildNavigationPanel(): void;
			toggleNavigationPanel(open?: boolean): void;
			runFind: (query: string, status: HTMLElement, results: HTMLElement) => Promise<void>;
			navPanel: HTMLElement | null;
		};
		const toolbar = view.contentEl.createDiv({ cls: 'inkling-toolbar' });
		view.buildNavigationPanel();
		return { view, toolbar };
	}

	it('hangs from the tool strip, over the pages, instead of pushing them down', () => {
		const { view, toolbar } = openPanel();
		expect(view.navPanel?.parentElement).toBe(toolbar);
	});

	it('searches as it is typed, once typing pauses', async () => {
		vi.useFakeTimers();
		const { view } = openPanel();
		const find = vi.spyOn(view, 'runFind').mockResolvedValue();
		const input = view.navPanel?.querySelector<HTMLInputElement>('.inkling-nav-find-input');
		if (!input) throw new Error('no find field');
		input.value = 'momentum';
		input.dispatchEvent(new Event('input'));
		expect(find).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(400);
		expect(find).toHaveBeenCalledWith('momentum', expect.anything(), expect.anything());
		vi.useRealTimers();
	});

	it('closes from its own button and on Escape', () => {
		const { view } = openPanel();
		view.toggleNavigationPanel(true);
		view.navPanel?.querySelector<HTMLButtonElement>('.inkling-nav-close')?.click();
		expect(view.navPanel?.hidden).toBe(true);
		view.toggleNavigationPanel(true);
		view.navPanel?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(view.navPanel?.hidden).toBe(true);
	});
});

describe('the note editor', () => {
	function openEditor(existing: string) {
		const harness = openPdfView();
		const view = harness.view as unknown as {
			contentEl: HTMLElement;
			pageCanvases: Map<number, HTMLCanvasElement>;
			editNote(page: number, point: { x: number; y: number }, existing: string): Promise<string | null>;
		};
		const placeholder = view.contentEl.createDiv({ cls: 'inkling-pdf-page-placeholder' });
		placeholder.dataset.pageNumber = '1';
		const result = view.editNote(1, { x: 10, y: 10 }, existing);
		const card = placeholder.querySelector<HTMLElement>('.inkling-note-editor');
		return { result, card };
	}

	it('offers to delete a note being edited, which removes it', async () => {
		const { result, card } = openEditor('Check this derivation');
		expect(card?.querySelector('.inkling-note-title')?.textContent).toBe('Edit note');
		card?.querySelector<HTMLButtonElement>('.inkling-note-delete')?.click();
		expect(await result).toBe('');
	});

	it('has nothing to delete for a new note', async () => {
		const { result, card } = openEditor('');
		expect(card?.querySelector('.inkling-note-title')?.textContent).toBe('New note');
		expect(card?.querySelector('.inkling-note-delete')).toBeNull();
		card?.querySelector<HTMLButtonElement>('.mod-cta')?.click();
		expect(await result).toBe('');
	});

	it('saves on Ctrl+Enter and cancels on Escape', async () => {
		const saved = openEditor('');
		const field = saved.card?.querySelector<HTMLTextAreaElement>('.inkling-note-text');
		if (!field) throw new Error('no field');
		field.value = 'Exam question';
		field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
		expect(await saved.result).toBe('Exam question');

		const cancelled = openEditor('Keep me');
		cancelled.card?.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(await cancelled.result).toBeNull();
	});
});
