import { PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
	EDGE_ZONE,
	GROW_STEP_X,
	GROW_STEP_Y,
	INFINITE_BASE_HEIGHT,
	INFINITE_BASE_WIDTH,
	MAX_COORDINATE,
	MAX_PAGE_EXTENT,
	boundsOf,
	boxFromView,
	edgesNear,
	growBox,
	isInfiniteCanvasKeywords,
	type PdfBox,
} from '../../src/pdf/infiniteCanvas';
import { createHandwrittenNoteBytes, parseTemplateStyleFromKeywords, setInfiniteCanvasBox } from '../../src/templates';

const START: PdfBox = { left: 0, bottom: 0, right: INFINITE_BASE_WIDTH, top: INFINITE_BASE_HEIGHT };

describe('edgesNear', () => {
	it('finds nothing on an empty canvas', () => {
		expect(edgesNear(START, null, EDGE_ZONE)).toEqual([]);
	});

	it('finds nothing for ink in the middle of the page', () => {
		expect(edgesNear(START, { left: 200, bottom: 300, right: 400, top: 500 }, EDGE_ZONE)).toEqual([]);
	});

	it('finds each edge the ink comes close to', () => {
		const ink = { left: 20, bottom: 300, right: INFINITE_BASE_WIDTH - 10, top: 500 };
		expect(edgesNear(START, ink, EDGE_ZONE).sort()).toEqual(['left', 'right']);
		const low = { left: 200, bottom: 5, right: 300, top: INFINITE_BASE_HEIGHT - 1 };
		expect(edgesNear(START, low, EDGE_ZONE).sort()).toEqual(['bottom', 'top']);
	});
});

describe('growBox', () => {
	it('moves the right and bottom edges out without touching the origin side', () => {
		const growth = growBox(START, ['right', 'bottom']);
		expect(growth?.box).toEqual({ left: 0, bottom: -GROW_STEP_Y, right: INFINITE_BASE_WIDTH + GROW_STEP_X, top: INFINITE_BASE_HEIGHT });
		// Neither moved anything in front of what was on screen.
		expect(growth?.addedLeft).toBe(0);
		expect(growth?.addedTop).toBe(0);
	});

	// The left and top edges grow into negative and higher coordinates, so
	// no stroke ever has to move; the view scrolls by what was added.
	it('grows left into negative coordinates and reports how far', () => {
		const growth = growBox(START, ['left', 'top']);
		expect(growth?.box.left).toBe(-GROW_STEP_X);
		expect(growth?.box.top).toBe(INFINITE_BASE_HEIGHT + GROW_STEP_Y);
		expect(growth?.addedLeft).toBe(GROW_STEP_X);
		expect(growth?.addedTop).toBe(GROW_STEP_Y);
	});

	it('stops at the largest page a PDF reader will open', () => {
		let box = START;
		for (let step = 0; step < 100; step++) box = growBox(box, ['right'])?.box ?? box;
		expect(box.right - box.left).toBeLessThanOrEqual(MAX_PAGE_EXTENT);
		expect(box.right).toBeLessThanOrEqual(MAX_COORDINATE);
		expect(growBox(box, ['right'])).toBeNull();
	});

	it('keeps the extent limit when growing both ways', () => {
		let box = START;
		for (let step = 0; step < 100; step++) box = growBox(box, ['left', 'right', 'top', 'bottom'])?.box ?? box;
		expect(box.right - box.left).toBeLessThanOrEqual(MAX_PAGE_EXTENT);
		expect(box.top - box.bottom).toBeLessThanOrEqual(MAX_PAGE_EXTENT);
		expect(box.left).toBeGreaterThanOrEqual(-MAX_COORDINATE);
	});

	it('is null for no edges', () => {
		expect(growBox(START, [])).toBeNull();
	});
});

describe('boxFromView and boundsOf', () => {
	it('orders corners whichever way round the file wrote them', () => {
		expect(boxFromView([612, 792, -100, -50])).toEqual({ left: -100, bottom: -50, right: 612, top: 792 });
	});

	it('bounds a set of points', () => {
		expect(boundsOf([])).toBeNull();
		expect(boundsOf([{ x: 3, y: 9 }, { x: -2, y: 4 }])).toEqual({ left: -2, bottom: 4, right: 3, top: 9 });
	});
});

describe('a new infinite canvas', () => {
	it('is marked as one, and keeps its template', async () => {
		const pdf = await PDFDocument.load(await createHandwrittenNoteBytes('dot-grid', 'a4', 'infinite'));
		const keywords = pdf.getKeywords();
		expect(isInfiniteCanvasKeywords(keywords)).toBe(true);
		expect(parseTemplateStyleFromKeywords(keywords)).toBe('dot-grid');
	});

	it('starts at the base size, whatever the page-size setting', async () => {
		const pdf = await PDFDocument.load(await createHandwrittenNoteBytes('lined', 'a4', 'infinite'));
		expect(pdf.getPageCount()).toBe(1);
		const { width, height } = pdf.getPage(0).getSize();
		expect([width, height]).toEqual([INFINITE_BASE_WIDTH, INFINITE_BASE_HEIGHT]);
	});

	it('draws its ruling as one pattern, not a shape per dot', async () => {
		const bytes = await createHandwrittenNoteBytes('dot-grid', 'letter', 'infinite');
		const pdf = await PDFDocument.load(bytes);
		const resources = pdf.getPage(0).node.Resources();
		expect(resources?.get(PDFName.of('Pattern'))).toBeDefined();
		// A fixed page of dots is tens of kilobytes; a pattern is a tile.
		expect(bytes.length).toBeLessThan(4000);
	});

	it('has no pattern when blank', async () => {
		const pdf = await PDFDocument.load(await createHandwrittenNoteBytes('blank', 'letter', 'infinite'));
		expect(pdf.getPage(0).node.Resources()?.get(PDFName.of('Pattern'))).toBeUndefined();
	});

	it('is not marked infinite when made as pages', async () => {
		const pdf = await PDFDocument.load(await createHandwrittenNoteBytes('lined', 'letter', 'pages'));
		expect(isInfiniteCanvasKeywords(pdf.getKeywords())).toBe(false);
	});
});

describe('growing a canvas', () => {
	// What the view relies on: pdf.js reads a box that has grown into
	// negative coordinates back as exactly that box, so its viewport maps
	// every stroke to where it was.
	it('round-trips a box with a negative origin through pdf.js', async () => {
		const pdf = await PDFDocument.load(await createHandwrittenNoteBytes('dot-grid', 'letter', 'infinite'));
		const grown = growBox(START, ['left', 'bottom', 'right'])?.box;
		expect(grown).toBeDefined();
		if (!grown) return;
		setInfiniteCanvasBox(pdf.getPage(0), grown);
		const bytes = await pdf.save();

		const { getDocument } = await import('pdfjs-dist');
		const document = await getDocument({ data: bytes }).promise;
		try {
			const page = await document.getPage(1);
			expect(boxFromView(page.view)).toEqual(grown);
			// A point drawn at the old origin is still at the old origin.
			const viewport = page.getViewport({ scale: 1 });
			const [x, y] = viewport.convertToViewportPoint(0, 0) as [number, number];
			expect(x).toBeCloseTo(GROW_STEP_X, 5);
			expect(y).toBeCloseTo(INFINITE_BASE_HEIGHT, 5);
		} finally {
			await document.destroy();
		}
	});

	it('moves a crop box along with the media box', async () => {
		const pdf = await PDFDocument.load(await createHandwrittenNoteBytes('blank', 'letter', 'infinite'));
		const page = pdf.getPage(0);
		page.setCropBox(0, 0, INFINITE_BASE_WIDTH, INFINITE_BASE_HEIGHT);
		const grown = { left: -10, bottom: -20, right: 700, top: 900 };
		setInfiniteCanvasBox(page, grown);
		expect(page.getCropBox()).toEqual({ x: -10, y: -20, width: 710, height: 920 });
	});
});
