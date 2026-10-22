// @vitest-environment jsdom
import { PDFDocument } from 'pdf-lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pictureButtonCentres } from '../src/annotate/render';
import type { ImageAnnotation, PicturePixels } from '../src/annotate/types';
import { attachThumbnailMenu, deletePage } from '../src/pageMenu';
import { refreshCoreReaders } from '../src/coreViews';
import { FileView } from './harness/obsidian';
import { readInklingAnnotations, writeInklingAnnotations } from '../src/pdf/annotationSync';
import { removePage } from '../src/pdf/pages';
import { resetObsidianStubs, shownMenus } from './harness/obsidian';
import { mountTestSurface, type TestSurface } from './harness/surface';

// Deleting a page from a PDF, from the thumbnails of Obsidian's own reader;
// and pictures that can be picked up again later, and locked in place.

async function pdfOf(widths: number[]): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	for (const width of widths) doc.addPage([width, 500]);
	return doc.save();
}

const widthsOf = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPages().map((page) => page.getWidth());

describe('removing a page', () => {
	it('takes the page out and leaves the rest in order', async () => {
		const result = await removePage(await pdfOf([100, 200, 300]), 2);
		expect(result.kind).toBe('removed');
		if (result.kind !== 'removed') return;
		expect(await widthsOf(result.bytes)).toEqual([100, 300]);
		expect(result.pageCount).toBe(2);
	});

	it('takes the page’s own content out of the file, not only off the list of pages', async () => {
		const doc = await PDFDocument.create();
		doc.addPage([300, 300]).drawText('keep', { x: 10, y: 10 });
		doc.addPage([300, 300]).drawText('SECRET-REMOVED-TEXT', { x: 10, y: 10 });
		const before = await doc.save({ useObjectStreams: false });
		const result = await removePage(before, 2);
		if (result.kind !== 'removed') throw new Error('refused');
		const reloaded = await PDFDocument.load(result.bytes);
		expect(reloaded.getPageCount()).toBe(1);
		expect(result.bytes.length).toBeLessThan(before.length);
	});

	it('will not delete the only page', async () => {
		expect((await removePage(await pdfOf([100]), 1)).kind).toBe('refused');
	});

	it('will not delete a page that is not there', async () => {
		expect((await removePage(await pdfOf([100, 200]), 3)).kind).toBe('refused');
	});
});

describe('the thumbnail menu in Obsidian’s reader', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		resetObsidianStubs();
	});

	function reader() {
		const containerEl = document.body.appendChild(document.createElement('div'));
		const sidebar = containerEl.appendChild(document.createElement('div'));
		const thumbnail = sidebar.appendChild(document.createElement('div'));
		thumbnail.className = 'thumbnail';
		thumbnail.dataset.pageNumber = '3';
		const page = containerEl.appendChild(document.createElement('div'));
		const obsidiansOwn = vi.fn();
		sidebar.addEventListener('contextmenu', obsidiansOwn);
		const view = { containerEl, file: { path: 'Book.pdf', basename: 'Book', extension: 'pdf' } };
		const app = { fileManager: { generateMarkdownLink: () => '[[Book.pdf#page=3]]' } };
		attachThumbnailMenu(app as never, view as never, (el, handler) => el.addEventListener('contextmenu', handler, { capture: true }));
		return { thumbnail, page, obsidiansOwn };
	}

	it('offers to copy a link to the page, and to delete it, in place of Obsidian’s own', () => {
		const { thumbnail, obsidiansOwn } = reader();
		thumbnail.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		expect(shownMenus[0]?.map((item) => item.title)).toEqual(['Copy link to page', 'Delete page']);
		expect(obsidiansOwn).not.toHaveBeenCalled();
	});

	it('leaves a right-click anywhere else to Obsidian', () => {
		const { page } = reader();
		const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
		page.dispatchEvent(event);
		expect(shownMenus).toHaveLength(0);
		expect(event.defaultPrevented).toBe(false);
	});

	it('deletes the page from the file', async () => {
		let onDisk = await pdfOf([100, 200, 300]);
		const vault = {
			readBinary: async () => onDisk.slice().buffer,
			modifyBinary: async (_file: unknown, bytes: ArrayBuffer) => {
				onDisk = new Uint8Array(bytes);
			},
			adapter: { stat: async () => ({ size: onDisk.byteLength }) },
		};
		const deleted = await deletePage({ vault, workspace: { getLeavesOfType: () => [] } } as never, { path: 'Book.pdf' } as never, 1);
		expect(deleted).toBe(true);
		expect(await widthsOf(onDisk)).toEqual([200, 300]);
	});

	// Obsidian reloads the document of a reader whose PDF changes, but not its
	// page count or its thumbnails, which then no longer match.
	it('rebuilds every reader showing the PDF afterwards, at the page it was on', async () => {
		const rebuilt: string[] = [];
		const reader = (path: string, page: number) => {
			const view = Object.assign(Object.create(FileView.prototype) as object, {
				file: { path },
				viewer: { child: { pdfViewer: { pdfViewer: { currentPageNumber: page } } } },
				setEphemeralState: vi.fn(),
			});
			return { view, rebuildView: vi.fn(async () => void rebuilt.push(path)) };
		};
		const book = reader('Book.pdf', 7);
		const other = reader('Other.pdf', 2);
		await refreshCoreReaders({ workspace: { getLeavesOfType: () => [book, other] } } as never, { path: 'Book.pdf' } as never);
		expect(rebuilt).toEqual(['Book.pdf']);
		expect(book.view.setEphemeralState).toHaveBeenCalledWith({ subpath: '#page=7' });
	});
});

const pixels: PicturePixels = { format: 'jpeg', width: 4, height: 2, data: new Uint8Array(64) };
function picture(locked = false): ImageAnnotation {
	return { id: 'ink-pic', kind: 'image', color: '#000000', width: 1, start: { x: 200, y: 100 }, end: { x: 400, y: 200 }, picture: pixels, ...(locked ? { locked } : {}) };
}

describe('a picture placed earlier', () => {
	let surface: TestSurface;
	beforeEach(() => {
		document.body.innerHTML = '';
		// Only the timeouts: the surface needs its own animation frames.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		surface = mountTestSurface(800, 450);
		surface.controller.seedPage(1, [picture()]);
		surface.controller.setTool('pen');
	});

	const hold = (x: number, y: number, ms: number) => {
		surface.pointer('pointerdown', x, y, { pointerType: 'pen' });
		vi.advanceTimersByTime(ms);
	};

	it('is picked up again by pressing and holding on it, pen in hand', () => {
		hold(300, 150, 600);
		surface.pointer('pointerup', 300, 150, { pointerType: 'pen' });
		expect(surface.controller.hasSelection()).toBe(true);
		expect(surface.controller.getTool()).toBe('select');
		// And nothing was drawn by the press.
		expect(surface.annotations()).toHaveLength(1);
		vi.useRealTimers();
	});

	it('is written on, not picked up, by a pen that moves', () => {
		surface.pointer('pointerdown', 300, 150, { pointerType: 'pen' });
		surface.pointer('pointermove', 340, 170, { pointerType: 'pen' });
		vi.advanceTimersByTime(600);
		surface.pointer('pointerup', 340, 170, { pointerType: 'pen' });
		expect(surface.controller.getTool()).toBe('pen');
		expect(surface.annotations()).toHaveLength(2);
		vi.useRealTimers();
	});

	it('locks from the button above it, and then stays put but can still be selected to unlock', () => {
		hold(300, 150, 600);
		surface.pointer('pointerup', 300, 150, { pointerType: 'pen' });
		vi.useRealTimers();
		const box = { minX: 200, minY: 100, maxX: 400, maxY: 200 };
		const lock = pictureButtonCentres(box, 1).lock;
		surface.drawStroke([[lock.x, lock.y]], { pointerType: 'pen' });
		const [locked] = surface.annotations();
		expect(locked?.kind === 'image' && locked.locked).toBe(true);
		expect(surface.controller.hasSelection()).toBe(true);

		// A drag from inside its frame does not move it.
		surface.drawStroke([
			[300, 150],
			[500, 300],
		]);
		const [still] = surface.annotations();
		expect(still?.kind === 'image' && still.start).toEqual({ x: 200, y: 100 });
	});

	it('is not taken by a lasso round the writing on it once locked', () => {
		vi.useRealTimers();
		surface.controller.seedPage(1, [
			picture(true),
			{ id: 'ink', kind: 'stroke', tool: 'pen', color: '#000000', width: 3, points: [{ x: 250, y: 150 }, { x: 350, y: 150 }] },
		]);
		surface.controller.setTool('select');
		surface.drawStroke([
			[180, 80],
			[420, 80],
			[420, 220],
			[180, 220],
			[185, 85],
		]);
		surface.drawStroke([
			[300, 150],
			[300, 250],
		]);
		const ink = surface.annotations().find((a) => a.id === 'ink');
		const pic = surface.annotations().find((a) => a.id === 'ink-pic');
		expect(ink?.kind === 'stroke' && ink.points[0]?.y).toBe(250);
		expect(pic?.kind === 'image' && pic.start).toEqual({ x: 200, y: 100 });
	});

	it('is not deleted while locked', () => {
		vi.useRealTimers();
		surface.controller.seedPage(1, [picture(true)]);
		surface.controller.setTool('select');
		surface.pointer('pointerdown', 300, 150, { pointerType: 'pen' });
		surface.pointer('pointerup', 300, 150, { pointerType: 'pen' });
		surface.controller.deleteSelection();
		expect(surface.annotations()).toHaveLength(1);
	});

	it('keeps its lock in the PDF, as the flag other readers honour', async () => {
		vi.useRealTimers();
		const doc = await PDFDocument.create();
		doc.addPage([612, 792]);
		writeInklingAnnotations(doc, 0, [picture(true)]);
		const flags = doc.getPage(0).node.Annots()?.lookup(0)?.toString();
		expect(flags).toContain('/F 132');
		const reloaded = await PDFDocument.load(await doc.save());
		const [read] = readInklingAnnotations(reloaded, 0);
		expect(read?.kind === 'image' && read.locked).toBe(true);
	});
});

describe('a picture, by finger', () => {
	let surface: TestSurface;
	const box = { minX: 200, minY: 100, maxX: 400, maxY: 200 };
	beforeEach(() => {
		document.body.innerHTML = '';
		surface = mountTestSurface(800, 450);
		surface.controller.seedPage(1, [picture()]);
		surface.controller.setTool('pen');
	});
	const finger = (type: string, x: number, y: number) => surface.pointer(type, x, y, { pointerType: 'touch', pointerId: 9 });

	it('is picked up by the host’s long press, which the view turns into a page and a point', () => {
		expect(surface.controller.pickUpPictureAt(1, { x: 300, y: 150 })).toBe(true);
		expect(surface.controller.hasSelection()).toBe(true);
		expect(surface.controller.pickUpPictureAt(1, { x: 600, y: 400 })).toBe(false);
	});

	it('moves once picked up, with a finger on its frame', () => {
		surface.controller.pickUpPictureAt(1, { x: 300, y: 150 });
		finger('pointerdown', 300, 150);
		finger('pointermove', 350, 170);
		finger('pointerup', 350, 170);
		const [moved] = surface.annotations();
		expect(moved?.kind === 'image' && moved.start).toEqual({ x: 250, y: 120 });
	});

	it('leaves a finger anywhere else to scroll, drawing nothing', () => {
		surface.controller.pickUpPictureAt(1, { x: 300, y: 150 });
		finger('pointerdown', 700, 400);
		finger('pointermove', 650, 350);
		finger('pointerup', 650, 350);
		const [still] = surface.annotations();
		expect(still?.kind === 'image' && still.start).toEqual({ x: 200, y: 100 });
		expect(surface.annotations()).toHaveLength(1);
	});

	it('is deleted from the bin beside the lock, by finger too', () => {
		surface.controller.pickUpPictureAt(1, { x: 300, y: 150 });
		const bin = pictureButtonCentres(box, 1).delete;
		finger('pointerdown', bin.x, bin.y);
		finger('pointerup', bin.x, bin.y);
		expect(surface.annotations()).toHaveLength(0);
	});

	it('keeps the bin from deleting a locked picture', () => {
		surface.controller.seedPage(1, [picture(true)]);
		surface.controller.pickUpPictureAt(1, { x: 300, y: 150 });
		const bin = pictureButtonCentres(box, 1).delete;
		surface.drawStroke([[bin.x, bin.y]]);
		expect(surface.annotations()).toHaveLength(1);
	});

	it('puts its buttons under it when there is no room above, at the top of the page', () => {
		const top = { minX: 200, minY: 5, maxX: 400, maxY: 105 };
		expect(pictureButtonCentres(top, 1).lock.y).toBeGreaterThan(top.maxY);
	});
});

describe('letting go of a picture', () => {
	let surface: TestSurface;
	beforeEach(() => {
		document.body.innerHTML = '';
		surface = mountTestSurface(800, 450);
		surface.controller.seedPage(1, [picture()]);
		surface.controller.setTool('pen');
		surface.controller.pickUpPictureAt(1, { x: 300, y: 150 });
	});

	it('happens with a finger’s tap beside it, and the pen is back in hand', () => {
		surface.pointer('pointerdown', 700, 400, { pointerType: 'touch', pointerId: 5 });
		surface.pointer('pointerup', 700, 400, { pointerType: 'touch', pointerId: 5 });
		expect(surface.controller.hasSelection()).toBe(false);
		expect(surface.controller.getTool()).toBe('pen');
	});

	it('happens with a pen’s tap beside it too, which draws nothing', () => {
		surface.drawStroke([[700, 400]], { pointerType: 'pen' });
		expect(surface.controller.hasSelection()).toBe(false);
		expect(surface.controller.getTool()).toBe('pen');
		expect(surface.annotations()).toHaveLength(1);
	});

	it('does not happen when the finger scrolls instead of tapping', () => {
		surface.pointer('pointerdown', 700, 400, { pointerType: 'touch', pointerId: 5 });
		surface.pointer('pointermove', 700, 300, { pointerType: 'touch', pointerId: 5 });
		surface.pointer('pointerup', 700, 300, { pointerType: 'touch', pointerId: 5 });
		expect(surface.controller.hasSelection()).toBe(true);
	});

	it('brings the pen back after the picture is moved into place', () => {
		surface.drawStroke([
			[300, 150],
			[350, 180],
		]);
		expect(surface.controller.hasSelection()).toBe(false);
		expect(surface.controller.getTool()).toBe('pen');
	});

	it('happens on Escape, through the controller', () => {
		expect(surface.controller.clearSelection()).toBe(true);
		expect(surface.controller.getTool()).toBe('pen');
		expect(surface.controller.clearSelection()).toBe(false);
	});
});

describe('a finger’s tap with the lasso in hand', () => {
	it('picks out the drawing under it, as a pen’s tap does', () => {
		document.body.innerHTML = '';
		const surface = mountTestSurface(800, 450);
		surface.controller.seedPage(1, [picture()]);
		surface.controller.setTool('select');
		surface.pointer('pointerdown', 300, 150, { pointerType: 'touch', pointerId: 6 });
		surface.pointer('pointerup', 300, 150, { pointerType: 'touch', pointerId: 6 });
		expect(surface.controller.hasSelection()).toBe(true);
	});
});
