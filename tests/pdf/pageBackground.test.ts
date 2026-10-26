// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodePDFRawStream, degrees, PDFArray, PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFonts } from 'pdf-lib';
import { classifyStream, isTemplateDrawing, setPageBackground } from '../../src/pdf/pageBackground';
import { createHandwrittenNoteBytes, readTemplateStyle } from '../../src/templates';
import { isInfiniteCanvasKeywords } from '../../src/pdf/infiniteCanvas';
import { shownMenus } from '../harness/obsidian';
import { openPdfView } from '../harness/pdfView';
import { installSurfaceStubs } from '../harness/surface';

// What a page draws, stream by stream, as text.
async function contentsOf(bytes: Uint8Array, pageNumber: number): Promise<string[]> {
	const doc = await PDFDocument.load(bytes);
	const raw = doc.getPage(pageNumber - 1).node.get(PDFName.of('Contents'));
	const entries = raw instanceof PDFArray ? raw.asArray() : raw ? [raw] : [];
	return entries.map((entry) => {
		const stream = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
		if (!(stream instanceof PDFRawStream)) return '';
		return new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode());
	});
}

const changed = async (...args: Parameters<typeof setPageBackground>): Promise<Uint8Array> => {
	const result = await setPageBackground(...args);
	if (result.kind !== 'changed') throw new Error(result.reason);
	return result.bytes;
};

const RULE = '0.7 0.78 0.92 RG';
const DOTS = '0.55 0.55 0.6 rg';

describe('changing a page’s background', () => {
	it('replaces the ruling of a note page made before backgrounds were marked', async () => {
		const note = await createHandwrittenNoteBytes('lined');
		expect((await contentsOf(note, 1)).join('')).toContain(RULE);

		const dotted = await changed(note, 1, 'dot-grid');
		const contents = await contentsOf(dotted, 1);
		expect(contents).toHaveLength(1);
		expect(contents[0]).toContain('/InklingBackground BMC');
		expect(contents[0]).toContain(DOTS);
		expect(contents.join('')).not.toContain(RULE);
	});

	it('replaces its own background again rather than piling them up', async () => {
		const note = await createHandwrittenNoteBytes('blank');
		const once = await changed(note, 1, 'lined');
		const twice = await changed(once, 1, 'dot-grid');
		const contents = await contentsOf(twice, 1);
		expect(contents.filter((text) => text.includes('/InklingBackground BMC'))).toHaveLength(1);
		expect(contents.join('')).not.toContain(RULE);
	});

	it('leaves a page blank when asked to', async () => {
		const note = await createHandwrittenNoteBytes('dot-grid');
		const blank = await changed(note, 1, 'blank');
		expect((await contentsOf(blank, 1)).join('').trim()).toBe('');
		expect(readTemplateStyle(await PDFDocument.load(blank))).toBe('blank');
	});

	it('keeps what an imported page shows, and puts the ruling under it', async () => {
		const doc = await PDFDocument.create();
		doc.setKeywords(['inkling:template=blank']);
		doc.addPage();
		const page = doc.addPage();
		page.drawText('Chapter one', { font: await doc.embedFont(StandardFonts.Helvetica), x: 50, y: 700 });
		const lined = await changed(await doc.save(), 2, 'lined');
		const contents = await contentsOf(lined, 2);
		expect(contents[0]).toContain('/InklingBackground BMC');
		expect(contents.join('')).toContain('BT');
		expect(contents.join('')).toContain('Tj');
	});

	it('keeps a black line drawing on an imported page, and puts the ruling under it', async () => {
		const doc = await PDFDocument.create();
		doc.setKeywords(['inkling:template=blank']);
		const page = doc.addPage();
		// Drawn with no colour of its own, as many PDFs draw their diagrams.
		const diagram = doc.context.flateStream('q 2 w 100 100 m 300 300 l S 100 300 m 300 100 l S Q');
		page.node.set(PDFName.of('Contents'), doc.context.register(diagram));
		const lined = await changed(await doc.save(), 1, 'lined');
		const contents = await contentsOf(lined, 1);
		expect(contents).toHaveLength(2);
		expect(contents[0]).toContain('/InklingBackground BMC');
		expect(contents[1]).toContain('100 100 m 300 300 l S');
	});

	it('changes only the page asked for, or every page', async () => {
		const doc = await PDFDocument.load(await createHandwrittenNoteBytes('lined'));
		doc.addPage();
		doc.addPage();
		const three = await doc.save();

		const one = await changed(three, 2, 'dot-grid');
		expect((await contentsOf(one, 1)).join('')).toContain(RULE);
		expect((await contentsOf(one, 2)).join('')).toContain(DOTS);
		// One page of several: what new pages get stays the note's.
		expect(readTemplateStyle(await PDFDocument.load(one))).toBe('lined');

		const all = await changed(three, 'all', 'dot-grid');
		for (const pageNumber of [1, 2, 3]) expect((await contentsOf(all, pageNumber)).join('')).toContain(DOTS);
		expect(readTemplateStyle(await PDFDocument.load(all))).toBe('dot-grid');
	});

	it('keeps an infinite canvas infinite, with its pattern', async () => {
		const canvas = await createHandwrittenNoteBytes('dot-grid', 'letter', 'infinite');
		const lined = await changed(canvas, 'all', 'lined');
		const doc = await PDFDocument.load(lined);
		expect(isInfiniteCanvasKeywords(doc.getKeywords())).toBe(true);
		expect(readTemplateStyle(doc)).toBe('lined');
		const contents = await contentsOf(lined, 1);
		expect(contents).toHaveLength(1);
		expect(contents[0]).toContain('/InklingBackground scn');
	});

	it('refuses a page that is not there', async () => {
		const result = await setPageBackground(await createHandwrittenNoteBytes('blank'), 4, 'lined');
		expect(result.kind).toBe('refused');
	});
});

describe('a background on a PDF the plugin did not make', () => {
	it('lines a book without turning it into a note', async () => {
		const book = await PDFDocument.create();
		book.addPage([500, 700]);
		book.addPage([500, 700]);
		const lined = await changed(await book.save(), 'all', 'lined');
		const doc = await PDFDocument.load(lined);
		expect((await contentsOf(lined, 2)).join('')).toContain(RULE);
		// No note's marking: Add page goes on adding pages the book's size.
		expect(doc.getKeywords()).toBeUndefined();
	});

	// Where the first ruled line lands on screen, for a page turned by
	// `rotation`: its two ends in the page's own space, through the stream's
	// cm, then turned the way a reader shows the page (clockwise).
	async function firstLineOnScreen(rotation: number) {
		const scan = await PDFDocument.create();
		scan.addPage([600, 800]).setRotation(degrees(rotation));
		const [text = ''] = await contentsOf(await changed(await scan.save(), 1, 'lined'), 1);
		const cm = /([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm/.exec(text);
		const line = /([-\d.]+) ([-\d.]+) m ([-\d.]+) ([-\d.]+) l S/.exec(text);
		if (!cm || !line) throw new Error('no ruling');
		const [a, b, c, d, e, f] = cm.slice(1).map(Number) as [number, number, number, number, number, number];
		const [u1, v1, u2, v2] = line.slice(1).map(Number) as [number, number, number, number];
		const onPage = (u: number, v: number) => ({ x: a * u + c * v + e, y: b * u + d * v + f });
		// The page, 600 wide and 800 high, as a reader shows it, y down: a
		// quarter turn clockwise takes its left edge to the top and its top
		// edge to the right.
		const shown = ({ x, y }: { x: number; y: number }) =>
			rotation === 90 ? { x: y, y: x } : rotation === 180 ? { x: 600 - x, y } : rotation === 270 ? { x: 800 - y, y: 600 - x } : { x, y: 800 - y };
		return [shown(onPage(u1, v1)), shown(onPage(u2, v2))] as const;
	}

	it('rules a page turned sideways across the screen, not up it', async () => {
		for (const rotation of [0, 90, 180, 270]) {
			const [start, end] = await firstLineOnScreen(rotation);
			// Level on screen, a line-height below the top, edge to edge.
			expect(start.y).toBeCloseTo(end.y, 6);
			expect(start.y).toBeCloseTo(24, 6);
			expect(Math.min(start.x, end.x)).toBeCloseTo(0, 6);
			expect(Math.max(start.x, end.x)).toBeCloseTo(rotation % 180 === 0 ? 600 : 800, 6);
		}
	});
});

describe('recognising an old background', () => {
	it('takes paths in the ruling’s colours for one', () => {
		expect(isTemplateDrawing('q 0.7 0.78 0.92 RG 0.75 w 0 768 m 612 768 l S Q')).toBe(true);
		expect(isTemplateDrawing('q /Pattern cs /InklingBackground scn -1 -1 2 2 re f Q')).toBe(true);
	});

	it('does not take paths in no colour of their own — black — for one', () => {
		// A diagram on an imported page: lines with no colour set are black.
		expect(isTemplateDrawing('q 1 w 0 0 m 100 100 l S Q')).toBe(false);
		expect(isTemplateDrawing('0 0 100 50 re f')).toBe(false);
	});

	it('does not take a ruled line beside a black one for one', () => {
		expect(isTemplateDrawing('0 0 m 10 0 l S 0.7 0.78 0.92 RG 0 24 m 612 24 l S')).toBe(false);
		// Black again after the ruling's colour is restored away with Q.
		expect(isTemplateDrawing('q 0.7 0.78 0.92 RG 0 24 m 612 24 l S Q 0 48 m 612 48 l S')).toBe(false);
		// A fill in black under a ruling's stroke colour.
		expect(isTemplateDrawing('0.7 0.78 0.92 RG 0 0 10 10 re f')).toBe(false);
	});

	it('takes a stream that paints nothing for nothing', () => {
		expect(classifyStream('q')).toBe('nothing');
		expect(classifyStream('Q')).toBe('nothing');
		expect(classifyStream('q 0.7 0.78 0.92 RG 0 24 m 612 24 l S Q')).toBe('ruling');
	});

	it('does not take a diagram, text or a picture for one', () => {
		expect(isTemplateDrawing('q 1 0 0 RG 0 0 m 10 10 l S Q')).toBe(false);
		expect(isTemplateDrawing('BT /F1 12 Tf (Hello) Tj ET')).toBe(false);
		expect(isTemplateDrawing('q 100 0 0 100 0 0 cm /Im0 Do Q')).toBe(false);
	});
});

describe('the background menu in the PDF view', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		installSurfaceStubs();
		shownMenus.length = 0;
	});

	it('offers each background for this page and for all, and changes the file', async () => {
		const harness = openPdfView();
		const internals = harness.view as unknown as {
			app: { vault: Record<string, unknown> & { adapter: { stat: unknown } } };
			currentPageNumber: number;
			onLoadFile: (file: unknown) => Promise<void>;
			showBackgroundMenu(anchor: HTMLElement): void;
		};
		const note = await PDFDocument.load(await createHandwrittenNoteBytes('lined'));
		note.addPage();
		let onDisk = await note.save();
		const vault = internals.app.vault;
		vault.readBinary = vi.fn(async () => onDisk.slice().buffer);
		vault.modifyBinary = vi.fn(async (_file: unknown, written: ArrayBuffer) => {
			onDisk = new Uint8Array(written);
		});
		vault.adapter.stat = vi.fn(async () => ({ size: onDisk.byteLength }));
		internals.onLoadFile = vi.fn(async () => {});
		Object.defineProperty(internals, 'currentPageNumber', { get: () => 2, configurable: true });

		internals.showBackgroundMenu(document.body.createDiv());
		const items = shownMenus[0] ?? [];
		expect(items.map((item) => item.title)).toEqual(['This page (2)', 'Blank', 'Lined', 'Dot grid', 'All pages', 'Blank', 'Lined', 'Dot grid']);
		expect(items.filter((item) => item.label).map((item) => item.title)).toEqual(['This page (2)', 'All pages']);

		items[3]?.click();
		await vi.waitFor(async () => expect((await contentsOf(onDisk, 2)).join('')).toContain(DOTS));
		expect((await contentsOf(onDisk, 1)).join('')).toContain(RULE);
	});
});
