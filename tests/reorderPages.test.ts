// @vitest-environment jsdom
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachThumbnailDrag, applyPageOrder } from '../src/pageMenu';
import { ReaderPageWatch } from '../src/readerPageWatch';
import { ManagePagesModal, type PageSource } from '../src/managePagesModal';
import type { PlannedPage } from '../src/pdf/pages';
import { FileView, TFile } from './harness/obsidian';
import { installSurfaceStubs, makePointerEvent } from './harness/surface';

// Moving pages from Obsidian's reader: the dialog, a mouse dragging a
// thumbnail, and a reader kept right when another device moves them.

const file = new TFile('Book.pdf');

async function pdfOf(widths: number[]): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	for (const width of widths) doc.addPage([width, 700]);
	return doc.save();
}

const widths = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPages().map((page) => page.getWidth());

function vaultWith(start: Uint8Array) {
	let onDisk = start;
	return {
		get bytes() {
			return onDisk;
		},
		set bytes(value: Uint8Array) {
			onDisk = value;
		},
		configDir: 'config-folder',
		readBinary: vi.fn(async () => onDisk.slice().buffer),
		modifyBinary: vi.fn(async (_file: unknown, written: ArrayBuffer) => {
			onDisk = new Uint8Array(written);
		}),
		adapter: {
			stat: vi.fn(async () => ({ size: onDisk.byteLength, mtime: 1 })),
			exists: vi.fn(async () => true),
			mkdir: vi.fn(async () => {}),
			writeBinary: vi.fn(async () => {}),
			list: vi.fn(async () => ({ files: [], folders: [] })),
			remove: vi.fn(async () => {}),
		},
	};
}

const noSource = async (count: number): Promise<PageSource> => ({ numPages: count, draw: async () => {}, close: () => {} });

describe('the dialog for managing pages', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		installSurfaceStubs();
		Element.prototype.scrollIntoView = () => undefined;
	});

	async function open(count: number, onSave: (order: number[]) => void, plans: (plan: PlannedPage[]) => void = () => undefined) {
		const save_ = (plan: PlannedPage[]) => {
			plans(plan);
			onSave(plan.map(({ page }) => page));
		};
		const modal = new ManagePagesModal({} as never, file as never, 1, () => noSource(count), save_, () => undefined);
		modal.onOpen();
		await Promise.resolve();
		await Promise.resolve();
		const rows = () => Array.from(modal.contentEl.querySelectorAll<HTMLElement>('.inkling-reorder-row'));
		const handle = (index: number) => rows()[index]?.querySelector<HTMLElement>('.inkling-layout-handle') as HTMLElement;
		const save = () => modal.contentEl.querySelector<HTMLElement>('.inkling-layout-save')?.click();
		return { modal, rows, handle, save };
	}

	function dragBy(handle: HTMLElement, rows: number, step: number) {
		handle.setPointerCapture = () => undefined;
		handle.hasPointerCapture = () => true;
		handle.releasePointerCapture = () => undefined;
		handle.dispatchEvent(makePointerEvent('pointerdown', { pointerType: 'touch', pointerId: 5, clientX: 10, clientY: 100, button: 0 }));
		handle.dispatchEvent(makePointerEvent('pointermove', { pointerType: 'touch', pointerId: 5, clientX: 10, clientY: 100 + rows * step }));
		handle.dispatchEvent(makePointerEvent('pointerup', { pointerType: 'touch', pointerId: 5, clientX: 10, clientY: 100 + rows * step }));
	}

	it('moves a page with a finger on its handle, and saves the order', async () => {
		vi.stubGlobal('requestAnimationFrame', () => 1);
		const onSave = vi.fn();
		const { rows, handle, save } = await open(4, onSave);
		// No layout under jsdom: rows are one row-height apart by their height.
		rows().forEach((row) => Object.defineProperty(row, 'offsetHeight', { value: 80 }));
		dragBy(handle(0), 2, 80);
		expect(rows().map((row) => row.dataset.page)).toEqual(['2', '3', '1', '4']);
		save();
		expect(onSave).toHaveBeenCalledWith([2, 3, 1, 4]);
		vi.unstubAllGlobals();
	});

	it('moves a page with the arrow keys too', async () => {
		const onSave = vi.fn();
		const { handle, save } = await open(3, onSave);
		handle(2).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
		save();
		expect(onSave).toHaveBeenCalledWith([1, 3, 2]);
	});

	const pick = (rows: () => HTMLElement[], index: number) => rows()[index]?.querySelector<HTMLElement>('.inkling-layout-label')?.click();
	const press = (modal: ManagePagesModal, cls: string) => modal.contentEl.querySelector<HTMLElement>(cls)?.click();

	it('moves a whole selection together, in the order it was in', async () => {
		const onSave = vi.fn();
		const { modal, rows, handle, save } = await open(5, onSave);
		pick(rows, 0);
		pick(rows, 2);
		expect(modal.contentEl.querySelector('.inkling-pages-count')?.textContent).toBe('2 selected');
		handle(2).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
		save();
		expect(onSave).toHaveBeenCalledWith([2, 4, 1, 3, 5]);
	});

	it('turns, duplicates and deletes what is selected', async () => {
		const plans = vi.fn();
		const { modal, rows, save } = await open(3, () => undefined, plans);
		pick(rows, 1);
		press(modal, '.inkling-pages-right');
		press(modal, '.inkling-pages-copy');
		expect(rows().map((row) => row.querySelector('.inkling-layout-label')?.textContent)).toEqual(['Page 1', 'Page 2 · 90°', 'Page 2 (copy) · 90°', 'Page 3']);
		pick(rows, 3);
		press(modal, '.inkling-pages-delete');
		expect(rows()).toHaveLength(2);
		save();
		expect(plans).toHaveBeenCalledWith([{ page: 1 }, { page: 2, turn: 90 }]);
	});

	it('will not delete every page', async () => {
		const { modal, rows } = await open(2, () => undefined);
		press(modal, '.inkling-pages-all');
		expect(modal.contentEl.querySelector<HTMLButtonElement>('.inkling-pages-delete')?.disabled).toBe(true);
		press(modal, '.inkling-pages-delete');
		expect(rows()).toHaveLength(2);
	});
});

describe('writing a new page order', () => {
	it('moves the pages in the file, keeps a backup first, and rebuilds the reader', async () => {
		const vault = vaultWith(await pdfOf([300, 400, 500]));
		const rebuildView = vi.fn(async () => {});
		const reader = Object.assign(Object.create(FileView.prototype) as object, { file: { path: 'Book.pdf' } });
		const app = { vault, workspace: { getLeavesOfType: (type: string) => (type === 'pdf' ? [{ view: reader, rebuildView }] : []) } };

		expect(await applyPageOrder(app as never, file as never, [3, 1, 2])).toBe(true);

		expect(await widths(vault.bytes)).toEqual([500, 300, 400]);
		expect(vault.adapter.writeBinary).toHaveBeenCalledTimes(1);
		expect(String(vault.adapter.writeBinary.mock.calls[0]?.[0 as never])).toContain('@move-page.pdf');
		expect(rebuildView).toHaveBeenCalled();
	});

	it('saves what an open annotate view has first', async () => {
		const vault = vaultWith(await pdfOf([300, 400]));
		const flushPendingWrites = vi.fn(async () => {});
		const annotate = { file: { path: 'Book.pdf' }, flushPendingWrites };
		const app = { vault, workspace: { getLeavesOfType: (type: string) => (type === 'inkling-pdf-view' ? [{ view: annotate }] : []) } };
		await applyPageOrder(app as never, file as never, [2, 1]);
		expect(flushPendingWrites).toHaveBeenCalled();
	});
});

describe('dragging a thumbnail with a mouse', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		installSurfaceStubs();
	});

	it('moves the page to where it is let go, and is not also a click', async () => {
		const vault = vaultWith(await pdfOf([300, 400, 500]));
		const app = { vault, workspace: { getLeavesOfType: () => [] } };
		const containerEl = document.body.appendChild(document.createElement('div'));
		const thumbnails = [0, 1, 2].map((index) => {
			const thumbnail = containerEl.appendChild(document.createElement('div'));
			thumbnail.className = 'thumbnail';
			thumbnail.dataset.pageNumber = String(index + 1);
			thumbnail.getBoundingClientRect = () => new DOMRect(0, index * 100, 80, 100);
			return thumbnail;
		});
		const view = { containerEl, file: { path: 'Book.pdf', extension: 'pdf' } };
		const handlers = new Map<string, (event: Event) => void>();
		attachThumbnailDrag(app as never, view as never, (type, handler) => handlers.set(type, handler));
		vi.stubGlobal('requestAnimationFrame', () => 1);
		const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);

		const at = (type: string, y: number) => makePointerEvent(type, { pointerType: 'mouse', pointerId: 1, clientX: 40, clientY: y, button: 0 });
		const down = at('pointerdown', 50);
		Object.defineProperty(down, 'target', { value: thumbnails[0] });
		handlers.get('pointerdown')?.(down);
		document.dispatchEvent(at('pointermove', 120));
		expect(document.querySelector('.inkling-page-drop-line')).not.toBeNull();
		document.dispatchEvent(at('pointermove', 260));
		document.dispatchEvent(at('pointermove', 260));
		// The frame that works out the gap.
		const tick = raf.mock.calls.at(-1)?.[0];
		tick?.(0);
		document.dispatchEvent(at('pointerup', 260));

		expect(document.querySelector('.inkling-page-drop-line')).toBeNull();
		const click = new Event('click', { cancelable: true, bubbles: true });
		document.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(true);
		await vi.waitFor(async () => expect(await widths(vault.bytes)).toEqual([400, 500, 300]));
		raf.mockRestore();
		vi.unstubAllGlobals();
	});

	it('leaves a click alone', async () => {
		const containerEl = document.body.appendChild(document.createElement('div'));
		const thumbnail = containerEl.appendChild(document.createElement('div'));
		thumbnail.className = 'thumbnail';
		thumbnail.dataset.pageNumber = '1';
		const handlers = new Map<string, (event: Event) => void>();
		const view = { containerEl, file: { path: 'Book.pdf', extension: 'pdf' } };
		attachThumbnailDrag({} as never, view as never, (type, handler) => handlers.set(type, handler));
		const down = makePointerEvent('pointerdown', { pointerType: 'mouse', pointerId: 1, clientX: 40, clientY: 50, button: 0 });
		Object.defineProperty(down, 'target', { value: thumbnail });
		handlers.get('pointerdown')?.(down);
		document.dispatchEvent(makePointerEvent('pointerup', { pointerType: 'mouse', pointerId: 1, clientX: 40, clientY: 50, button: 0 }));
		const click = new Event('click', { cancelable: true, bubbles: true });
		document.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(false);
	});
});

describe('a reader, when another device changes the file', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	async function watching(start: Uint8Array) {
		const vault = vaultWith(start);
		const rebuildView = vi.fn(async () => {});
		const target = Object.assign(new TFile('Watched.pdf'), { stat: { size: 1000 } });
		const reader = Object.assign(Object.create(FileView.prototype) as object, { file: { path: 'Watched.pdf' } });
		const app = { vault, workspace: { getLeavesOfType: (type: string) => (type === 'pdf' ? [{ view: reader, rebuildView }] : []) } };
		const watch = new ReaderPageWatch(app as never);
		watch.readerOpened(target as never);
		await vi.advanceTimersByTimeAsync(2000);
		return { vault, rebuildView, target, watch };
	}

	it('is rebuilt when the pages were moved there', async () => {
		const { vault, rebuildView, target, watch } = await watching(await pdfOf([300, 400]));
		const doc = await PDFDocument.load(vault.bytes);
		const moved = doc.getPage(1);
		doc.removePage(1);
		doc.insertPage(0, moved);
		vault.bytes = await doc.save();
		watch.fileChanged(target as never);
		await vi.advanceTimersByTimeAsync(7000);
		expect(rebuildView).toHaveBeenCalledTimes(1);
	});

	it('is left alone when only ink changed there', async () => {
		const { vault, rebuildView, target, watch } = await watching(await pdfOf([300, 400]));
		const doc = await PDFDocument.load(vault.bytes);
		doc.setTitle('New title');
		vault.bytes = await doc.save();
		watch.fileChanged(target as never);
		await vi.advanceTimersByTimeAsync(7000);
		expect(rebuildView).not.toHaveBeenCalled();
	});
});
