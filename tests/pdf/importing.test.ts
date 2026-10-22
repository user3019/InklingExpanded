// @vitest-environment jsdom
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eraseAt } from '../../src/annotate/eraser';
import { scaleAnnotationAbout } from '../../src/annotate/geometry';
import type { ImageAnnotation, PicturePixels } from '../../src/annotate/types';
import { placePicture } from '../../src/importing';
import { readInklingAnnotations, writeInklingAnnotations } from '../../src/pdf/annotationSync';
import { createHandwrittenNoteBytes } from '../../src/templates';
import { shownMenus } from '../harness/obsidian';
import { openPdfView } from '../harness/pdfView';
import { installSurfaceStubs, mountTestSurface } from '../harness/surface';

// Pictures and the pages of other PDFs, brought into a PDF.

// A tiny real JPEG would need an encoder; the PDF only carries the bytes,
// and these stand in for them.
const jpeg: PicturePixels = { format: 'jpeg', width: 40, height: 20, data: new Uint8Array(Array.from({ length: 300 }, (_, i) => i % 251)) };
const rgba: PicturePixels = {
	format: 'rgba',
	width: 3,
	height: 2,
	data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]),
};

function picture(id: string, pixels: PicturePixels, box = { x: 100, y: 100, w: 200, h: 100 }): ImageAnnotation {
	return { id, kind: 'image', color: '#000000', width: 1, start: { x: box.x, y: box.y }, end: { x: box.x + box.w, y: box.y + box.h }, picture: pixels };
}

async function blank(): Promise<PDFDocument> {
	const doc = await PDFDocument.create();
	doc.addPage([612, 792]);
	return doc;
}

async function reload(doc: PDFDocument): Promise<PDFDocument> {
	return PDFDocument.load(await doc.save(), { updateMetadata: false });
}

function imageObjects(doc: PDFDocument): number {
	return doc.context
		.enumerateIndirectObjects()
		.filter(([, object]) => object instanceof PDFRawStream && object.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() === 'Image').length;
}

describe('a picture in a PDF', () => {
	it('comes back as the same JPEG, in the same box', async () => {
		const doc = await blank();
		writeInklingAnnotations(doc, 0, [picture('ink-j', jpeg)]);
		const [read] = readInklingAnnotations(await reload(doc), 0);
		expect(read?.kind).toBe('image');
		if (read?.kind !== 'image') return;
		expect(read.picture.format).toBe('jpeg');
		expect([...read.picture.data]).toEqual([...jpeg.data]);
		expect([read.start, read.end]).toEqual([{ x: 100, y: 100 }, { x: 300, y: 200 }]);
	});

	it('keeps a transparent picture’s transparency', async () => {
		const doc = await blank();
		writeInklingAnnotations(doc, 0, [picture('ink-r', rgba)]);
		const [read] = readInklingAnnotations(await reload(doc), 0);
		expect(read?.kind === 'image' && [...read.picture.data]).toEqual([...rgba.data]);
	});

	it('is drawn by other PDF readers, as a stamp showing the picture', async () => {
		const doc = await blank();
		writeInklingAnnotations(doc, 0, [picture('ink-j', jpeg)]);
		const annotation = doc.getPage(0).node.Annots()?.lookup(0);
		expect(annotation?.toString()).toContain('/Subtype /Stamp');
		expect(annotation?.toString()).toContain('/AP');
	});

	it('keeps its pixels in the file once when moved, rather than writing them again', async () => {
		const doc = await blank();
		writeInklingAnnotations(doc, 0, [picture('ink-j', jpeg)]);
		writeInklingAnnotations(doc, 0, [picture('ink-j', jpeg, { x: 150, y: 120, w: 200, h: 100 })]);
		expect(imageObjects(doc)).toBe(1);
		const [read] = readInklingAnnotations(await reload(doc), 0);
		expect(read?.kind === 'image' && read.start).toEqual({ x: 150, y: 120 });
	});

	it('takes its pixels with it when deleted', async () => {
		const doc = await blank();
		writeInklingAnnotations(doc, 0, [picture('ink-r', rgba)]);
		writeInklingAnnotations(doc, 0, []);
		expect(imageObjects(doc)).toBe(0);
	});
});

describe('a picture on the page', () => {
	it('is left alone by the eraser, which is for ink', () => {
		const kept = eraseAt([picture('p', jpeg)], { x: 150, y: 150 }, 20);
		expect(kept).toHaveLength(1);
	});

	it('scales in proportion from a corner', () => {
		const scaled = scaleAnnotationAbout(picture('p', jpeg), { x: 100, y: 100 }, 2);
		expect(scaled.kind === 'image' && [scaled.start, scaled.end]).toEqual([{ x: 100, y: 100 }, { x: 500, y: 300 }]);
	});

	it('first lands in the middle of what is on screen, at most most of the page, in its own proportions', () => {
		const box = placePicture({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 }, { width: 400, height: 200 }, { x: 500, y: 300 });
		expect(box.maxX - box.minX).toBeCloseTo(600, 5);
		expect(box.maxY - box.minY).toBeCloseTo(300, 5);
		expect((box.minY + box.maxY) / 2).toBeCloseTo(300, 5);
	});

	it('stays on the page when the middle of the view is near its edge', () => {
		const box = placePicture({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 }, { width: 100, height: 100 }, { x: 990, y: 10 });
		expect(box.maxX).toBeLessThanOrEqual(1000);
		expect(box.minY).toBeGreaterThanOrEqual(0);
	});

	it('is handed over selected, with the lasso in hand, and undone in one step', () => {
		const surface = mountTestSurface(800, 450);
		surface.controller.setTool('pen');
		surface.controller.place(1, picture('p', jpeg));
		expect(surface.controller.getTool()).toBe('select');
		expect(surface.controller.hasSelection()).toBe(true);
		surface.controller.undo();
		expect(surface.annotations()).toHaveLength(0);
	});

	it('is drawn beneath the ink, so it can be written on', () => {
		const surface = mountTestSurface(800, 450);
		surface.controller.seedPage(1, [
			{ id: 's', kind: 'stroke', tool: 'pen', color: '#000000', width: 3, points: [{ x: 0, y: 0 }, { x: 50, y: 50 }] },
			picture('p', jpeg),
		]);
		const ops = surface.baseCalls().map((call) => call.op);
		// No decoder under jsdom, so the picture is its placeholder fill.
		expect(ops.indexOf('fillRect')).toBeLessThan(ops.lastIndexOf('stroke'));
	});
});

describe('importing in the PDF view', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		installSurfaceStubs();
		shownMenus.length = 0;
	});

	async function openView(bytes: Uint8Array) {
		const harness = openPdfView();
		const internals = harness.view as unknown as {
			app: { vault: Record<string, unknown> & { adapter: { stat: unknown } } };
			infiniteBox: unknown;
			onLoadFile: (file: unknown) => Promise<void>;
			showImportMenu(anchor: HTMLElement): void;
			insertPdfPages(bytes: ArrayBuffer, name: string): Promise<void>;
		};
		let onDisk = bytes;
		const vault = internals.app.vault;
		vault.readBinary = vi.fn(async () => onDisk.slice().buffer);
		vault.modifyBinary = vi.fn(async (_file: unknown, written: ArrayBuffer) => {
			onDisk = new Uint8Array(written);
		});
		vault.adapter.stat = vi.fn(async () => ({ size: onDisk.byteLength }));
		internals.onLoadFile = vi.fn(async () => {});
		return { internals, pages: async () => (await PDFDocument.load(onDisk)).getPageCount(), sizes: async () => (await PDFDocument.load(onDisk)).getPages().map((page) => page.getWidth()) };
	}

	it('inserts every page of another PDF after the page on screen', async () => {
		const target = await PDFDocument.create();
		target.addPage([612, 792]);
		target.addPage([612, 792]);
		const source = await PDFDocument.create();
		source.addPage([300, 300]);
		source.addPage([400, 400]);
		const { internals, sizes } = await openView(await target.save());

		await internals.insertPdfPages((await source.save()).slice().buffer, 'Handout');

		expect(await sizes()).toEqual([612, 300, 400, 612]);
	});

	it('offers PDF pages and pictures, from the vault and the device', async () => {
		const { internals } = await openView(await createHandwrittenNoteBytes('lined'));
		internals.showImportMenu(document.body.createDiv());
		expect(shownMenus[0]?.map((item) => item.title)).toEqual([
			'PDF pages from the vault',
			'PDF pages from this device',
			'Picture from the vault',
			'Picture from this device',
		]);
	});

	it('offers only pictures on an infinite canvas, which stays one page', async () => {
		const { internals } = await openView(await createHandwrittenNoteBytes('lined', 'letter', 'infinite'));
		internals.infiniteBox = { left: 0, bottom: 0, right: 612, top: 792 };
		internals.showImportMenu(document.body.createDiv());
		expect(shownMenus[0]?.map((item) => item.title)).toEqual(['Picture from the vault', 'Picture from this device']);
	});
});
