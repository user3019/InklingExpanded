// @vitest-environment jsdom
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../src/annotate';
import { EDGE_ZONE, GROW_STEP_X, GROW_STEP_Y, INFINITE_BASE_HEIGHT, INFINITE_BASE_WIDTH, type Edge, type PdfBox } from '../../src/pdf/infiniteCanvas';
import { createHandwrittenNoteBytes } from '../../src/templates';
import { openPdfView } from '../harness/pdfView';
import { installSurfaceStubs } from '../harness/surface';

// The view's half of an infinite canvas: deciding when to grow, writing the
// grown box into the file, and swapping the grown page in where the old one
// was without reloading anything.
//
// pdf.js cannot render under jsdom, so getDocument hands back a document
// that reads the real box out of the bytes it is given and maps points
// through it the way a pdf.js viewport does: origin at the box's top left,
// y flipped. Everything else — pdf-lib, the writer, the controller — is real.

vi.mock('pdfjs-dist', async (importOriginal) => {
	const actual = await importOriginal<typeof import('pdfjs-dist')>();
	return {
		...actual,
		getDocument: (source: { data: ArrayBuffer }) => ({
			promise: PDFDocument.load(source.data).then((pdf) => {
				const { x, y, width, height } = pdf.getPage(0).getMediaBox();
				return fakeDocument({ left: x, bottom: y, right: x + width, top: y + height });
			}),
		}),
	};
});

const SCALE = 2;
// The length of the placeholder file the harness's fake writer saves.
const HARNESS_SAVE_BYTES = 400;
const START: PdfBox = { left: 0, bottom: 0, right: INFINITE_BASE_WIDTH, top: INFINITE_BASE_HEIGHT };

function boxViewport(box: PdfBox, scale: number) {
	return {
		scale,
		width: (box.right - box.left) * scale,
		height: (box.top - box.bottom) * scale,
		convertToViewportPoint: (x: number, y: number) => [(x - box.left) * scale, (box.top - y) * scale],
		convertToPdfPoint: (x: number, y: number) => [x / scale + box.left, box.top - y / scale],
	};
}

function fakeDocument(box: PdfBox) {
	const page = {
		view: [box.left, box.bottom, box.right, box.top],
		rotate: 0,
		getViewport: ({ scale }: { scale: number }) => boxViewport(box, scale),
		render: () => ({ promise: Promise.resolve() }),
		getTextContent: async () => ({ items: [] }),
	};
	return { numPages: 1, getPage: async () => page, destroy: vi.fn(async () => {}) };
}

function stroke(id: string, points: Array<[number, number]>): Annotation {
	return { id, kind: 'stroke', tool: 'pen', color: '#000000', width: 4, points: points.map(([x, y]) => ({ x, y })) };
}

async function openCanvas() {
	installSurfaceStubs();
	const harness = openPdfView();
	const internals = harness.view as unknown as {
		app: { vault: Record<string, unknown> & { adapter: { stat: unknown } } };
		pdf: unknown;
		infiniteBox: PdfBox | null;
		layoutScales: Map<number, number>;
		viewports: Map<number, ReturnType<typeof boxViewport>>;
		pageCanvases: Map<number, HTMLCanvasElement>;
		onLoadFile: (file: unknown) => Promise<void>;
		growInfiniteCanvas(edges: Edge[]): Promise<void>;
		history: { push(entry: unknown): void; snapshot(): { undo: Array<{ after: Annotation[] }> } };
		controller: {
			mountPage(page: number, host: HTMLElement, width: number, height: number): void;
			seedPage(page: number, annotations: Annotation[]): void;
			getPageAnnotations(page: number): Annotation[];
			isGestureActive(): boolean;
		};
	};

	let onDisk = await createHandwrittenNoteBytes('dot-grid', 'letter', 'infinite');
	let lastWritten = onDisk.byteLength;
	const vault = internals.app.vault;
	vault.readBinary = vi.fn(async () => onDisk.slice().buffer);
	vault.modifyBinary = vi.fn(async (_file: unknown, bytes: ArrayBuffer) => {
		lastWritten = bytes.byteLength;
		// The harness's writer saves annotations as placeholder bytes, not a
		// real PDF. That save is not what is under test, so it does not
		// replace the canvas on disk; the growth's own rewrite does.
		if (bytes.byteLength !== HARNESS_SAVE_BYTES) onDisk = new Uint8Array(bytes);
	});
	// Every Obsidian this plugin supports has it, and a save of a file
	// pdf-lib wrote is an append.
	vault.appendBinary = vi.fn(async (_file: unknown, bytes: ArrayBuffer) => {
		const joined = new Uint8Array(onDisk.byteLength + bytes.byteLength);
		joined.set(onDisk);
		joined.set(new Uint8Array(bytes), onDisk.byteLength);
		onDisk = joined;
		lastWritten = onDisk.byteLength;
	});
	vault.adapter.stat = vi.fn(async () => ({ size: lastWritten }));

	// The page as onLoadFile and renderPage leave it.
	const container = harness.view.contentEl;
	let scroll = { left: 0, top: 0 };
	Object.defineProperty(container, 'scrollLeft', { get: () => scroll.left, set: (value: number) => (scroll = { ...scroll, left: value }) });
	Object.defineProperty(container, 'scrollTop', { get: () => scroll.top, set: (value: number) => (scroll = { ...scroll, top: value }) });
	const placeholder = container.createDiv({ cls: 'inkling-pdf-page-placeholder' });
	placeholder.dataset.pageNumber = '1';
	const content = placeholder.createDiv({ cls: 'inkling-page-content' });
	const canvas = content.createEl('canvas', { cls: 'inkling-pdf-page' });
	const viewport = boxViewport(START, SCALE);
	internals.pdf = fakeDocument(START);
	internals.infiniteBox = START;
	internals.layoutScales.set(1, SCALE);
	internals.viewports.set(1, viewport);
	internals.pageCanvases.set(1, canvas);
	internals.controller.mountPage(1, content, viewport.width, viewport.height);
	const reload = vi.fn(async () => {});
	internals.onLoadFile = reload;

	return {
		harness,
		internals,
		reload,
		scroll: () => scroll,
		pageCanvas: () => content.querySelector<HTMLCanvasElement>('canvas.inkling-pdf-page'),
		mediaBox: async () => (await PDFDocument.load(onDisk)).getPage(0).getMediaBox(),
	};
}

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('an infinite canvas', () => {
	it('grows to the right a little after ink comes near its right edge', async () => {
		vi.useFakeTimers();
		const { harness, internals, mediaBox } = await openCanvas();
		const nearRight = (INFINITE_BASE_WIDTH - EDGE_ZONE / 2) * SCALE;
		internals.controller.seedPage(1, [stroke('a', [[600, 800], [nearRight, 820]])]);
		harness.markDirty(1);

		await vi.advanceTimersByTimeAsync(5000);

		expect(await mediaBox()).toEqual({ x: 0, y: 0, width: INFINITE_BASE_WIDTH + GROW_STEP_X, height: INFINITE_BASE_HEIGHT });
		expect(internals.viewports.get(1)?.width).toBe((INFINITE_BASE_WIDTH + GROW_STEP_X) * SCALE);
	});

	it('stays the size it is for ink in the middle', async () => {
		vi.useFakeTimers();
		const { harness, internals, mediaBox } = await openCanvas();
		internals.controller.seedPage(1, [stroke('a', [[400, 600], [500, 650]])]);
		harness.markDirty(1);

		await vi.advanceTimersByTimeAsync(5000);

		expect(await mediaBox()).toEqual({ x: 0, y: 0, width: INFINITE_BASE_WIDTH, height: INFINITE_BASE_HEIGHT });
	});

	// The point of doing it this way: no reload, no loading screen. The
	// page element stays, and only its canvas is exchanged.
	it('swaps the grown page in without reloading the view', async () => {
		const { harness, internals, reload, pageCanvas } = await openCanvas();
		const before = pageCanvas();

		await internals.growInfiniteCanvas(['right']);

		expect(reload).not.toHaveBeenCalled();
		expect(pageCanvas()).not.toBe(before);
		expect(pageCanvas()?.width).toBe((INFINITE_BASE_WIDTH + GROW_STEP_X) * SCALE);
		expect(harness.view.contentEl.querySelectorAll('.inkling-pdf-page-placeholder')).toHaveLength(1);
	});

	it('grows left and up without moving the ink on screen', async () => {
		const { internals, scroll, mediaBox } = await openCanvas();
		internals.controller.seedPage(1, [stroke('a', [[300, 400], [320, 410]])]);

		await internals.growInfiniteCanvas(['left', 'top']);

		expect(await mediaBox()).toEqual({
			x: -GROW_STEP_X,
			y: 0,
			width: INFINITE_BASE_WIDTH + GROW_STEP_X,
			height: INFINITE_BASE_HEIGHT + GROW_STEP_Y,
		});
		// In the page's own pixels the stroke moved by what was added in
		// front of it, and the view scrolled by exactly as much — so on
		// screen it is where it was.
		const [moved] = internals.controller.getPageAnnotations(1);
		expect(moved?.kind === 'stroke' && moved.points[0]).toEqual({ x: 300 + GROW_STEP_X * SCALE, y: 400 + GROW_STEP_Y * SCALE });
		expect(scroll()).toEqual({ left: GROW_STEP_X * SCALE, top: GROW_STEP_Y * SCALE });
	});

	it('keeps the undo history, moved into the grown page', async () => {
		const { internals } = await openCanvas();
		internals.history.push({ pageNumber: 1, before: [], after: [stroke('a', [[200, 200], [300, 300]])] });

		await internals.growInfiniteCanvas(['left']);

		const kept = internals.history.snapshot().undo[0]?.after[0];
		expect(kept?.kind === 'stroke' && kept.points[0]).toEqual({ x: 200 + GROW_STEP_X * SCALE, y: 200 });
	});

	it('waits for the pen to lift before swapping', async () => {
		vi.useFakeTimers();
		const { internals, pageCanvas } = await openCanvas();
		const before = pageCanvas();
		let penDown = true;
		vi.spyOn(internals.controller, 'isGestureActive').mockImplementation(() => penDown);

		const growing = internals.growInfiniteCanvas(['right']);
		await vi.advanceTimersByTimeAsync(500);
		expect(pageCanvas()).toBe(before);

		penDown = false;
		await vi.advanceTimersByTimeAsync(100);
		await growing;
		expect(pageCanvas()).not.toBe(before);
	});

	it('saves ink drawn after a growth through the new writer, into the grown file', async () => {
		vi.useFakeTimers();
		const { harness, internals, mediaBox } = await openCanvas();
		await internals.growInfiniteCanvas(['bottom']);

		internals.controller.seedPage(1, [stroke('late', [[400, 400], [450, 450]])]);
		harness.markDirty(1);
		await vi.advanceTimersByTimeAsync(5000);

		const saved = await PDFDocument.load(await (internals.app.vault.readBinary as () => Promise<ArrayBuffer>)());
		expect(saved.getPage(0).node.Annots()?.size()).toBe(1);
		expect((await mediaBox()).height).toBe(INFINITE_BASE_HEIGHT + GROW_STEP_Y);
	});
});
