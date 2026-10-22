// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../src/annotate';
import { openPdfView } from '../harness/pdfView';
import { installSurfaceStubs } from '../harness/surface';

// Zoomed in past what a page's own canvas can hold, the view draws just the
// part of the page on screen again at the screen's resolution, so text and
// ink stay sharp instead of breaking up into pixels. pdf.js cannot render
// under jsdom, so the document's render is a stub that records what it was
// asked to draw; everything the view does around it is real.

const PAGE_CSS = { left: 0, top: 0, width: 1000, height: 1300 };
const VIEW = { left: 0, top: 0, width: 800, height: 600 };

function stroke(id: string, points: Array<[number, number]>): Annotation {
	return { id, kind: 'stroke', tool: 'pen', color: '#000000', width: 4, points: points.map(([x, y]) => ({ x, y })) };
}

function openZoomed(options: { rendered: number; ideal: number; zoom: number }) {
	installSurfaceStubs();
	const harness = openPdfView();
	const view = harness.view;
	const internals = view as unknown as {
		pdf: unknown;
		viewZoomLevel: number;
		renderedPages: Set<number>;
		renderedScales: Map<number, number>;
		baseScales: Map<number, number>;
		inkBaseScales: Map<number, number>;
		viewports: Map<number, { width: number; height: number; scale: number }>;
		pageCanvases: Map<number, HTMLCanvasElement>;
		details: Map<number, { pageWidth: number; offsetX: number; offsetY: number }>;
		detailNeeded(page: number): boolean;
		renderDetail(page: number): Promise<void>;
		removeDetail(page: number): void;
		paintDetail(page: number, layer: 'ink' | 'overlay'): void;
		controller: {
			mountPage(page: number, host: HTMLElement, width: number, height: number): void;
			seedPage(page: number, annotations: Annotation[]): void;
		};
	};

	const container = view.contentEl;
	document.body.appendChild(container);
	container.getBoundingClientRect = () => new DOMRect(VIEW.left, VIEW.top, VIEW.width, VIEW.height);
	const placeholder = container.createDiv({ cls: 'inkling-pdf-page-placeholder' });
	placeholder.dataset.pageNumber = '1';
	placeholder.getBoundingClientRect = () => new DOMRect(PAGE_CSS.left, PAGE_CSS.top, PAGE_CSS.width, PAGE_CSS.height);
	const content = placeholder.createDiv({ cls: 'inkling-page-content' });
	const pageCanvas = content.createEl('canvas', { cls: 'inkling-pdf-page' });

	// A 612pt page backed at `rendered`.
	const viewport = { width: 612 * options.rendered, height: 792 * options.rendered, scale: options.rendered };
	internals.viewports.set(1, viewport);
	internals.pageCanvases.set(1, pageCanvas);
	internals.renderedPages.add(1);
	internals.renderedScales.set(1, options.rendered);
	internals.baseScales.set(1, options.ideal);
	internals.inkBaseScales.set(1, options.ideal);
	internals.viewZoomLevel = options.zoom;
	internals.controller.mountPage(1, content, viewport.width, viewport.height);

	const renders: Array<{ viewportScale: number; transform: number[]; width: number; height: number }> = [];
	internals.pdf = {
		getPage: async () => ({
			getViewport: ({ scale }: { scale: number }) => ({ scale, width: 612 * scale, height: 792 * scale }),
			render: (params: { canvas: HTMLCanvasElement; viewport: { scale: number }; transform: number[] }) => {
				renders.push({ viewportScale: params.viewport.scale, transform: params.transform, width: params.canvas.width, height: params.canvas.height });
				return { promise: Promise.resolve(), cancel: vi.fn() };
			},
		}),
	};
	return { internals, content, renders };
}

beforeEach(() => {
	document.body.innerHTML = '';
});

describe('the detail layer', () => {
	it('is not needed while the page canvas keeps up with the zoom', () => {
		const { internals } = openZoomed({ rendered: 4, ideal: 2, zoom: 2 });
		expect(internals.detailNeeded(1)).toBe(false);
	});

	it('is needed once the zoom outruns what the page canvas could be backed at', () => {
		// 500% on a page whose canvas stopped at 6 where 10 was wanted.
		const { internals } = openZoomed({ rendered: 6, ideal: 2, zoom: 5 });
		expect(internals.detailNeeded(1)).toBe(true);
	});

	it('draws only the part of the page on screen, at the screen’s resolution', async () => {
		const { internals, renders } = openZoomed({ rendered: 6, ideal: 2, zoom: 5 });
		await internals.renderDetail(1);

		const [render] = renders;
		// The view plus a margin, clipped to the page: 0..920 by 0..690 CSS
		// pixels, at a device pixel ratio of 1.
		expect(render?.width).toBe(920);
		expect(render?.height).toBe(690);
		// The page drawn at the width it is shown at: 1000 CSS px over 612pt.
		expect(render?.viewportScale).toBeCloseTo(1000 / 612, 6);
		expect(render?.transform).toEqual([1, 0, 0, 1, -0, -0]);
	});

	it('lays the sharp page, ink and live layer over the page, and hides the stretched copies under them', async () => {
		const { internals, content } = openZoomed({ rendered: 6, ideal: 2, zoom: 5 });
		await internals.renderDetail(1);

		const layers = Array.from(content.children, (child: Element) => child.className);
		// The sharp page just above the page, the sharp ink just above the
		// ink, the sharp live layer above everything.
		expect(layers.indexOf('inkling-detail-layer inkling-pdf-detail')).toBe(layers.indexOf('inkling-pdf-page') + 1);
		expect(layers.findIndex((name) => name.includes('inkling-ink-detail'))).toBe(
			layers.findIndex((name) => name.includes('inkling-annotation-base')) + 1,
		);
		expect(layers.at(-1)).toContain('inkling-overlay-detail');

		const base = content.querySelector('.inkling-annotation-base');
		expect(base?.classList.contains('has-detail-hole')).toBe(true);
		expect(content.querySelector('.inkling-annotation-overlay')?.classList.contains('is-detailed')).toBe(true);
		expect((base as HTMLElement).style.getPropertyValue('--inkling-detail-right')).toBe('92%');
	});

	it('maps the page’s ink onto the sharp copy at the scale it is shown', async () => {
		const { internals, content } = openZoomed({ rendered: 6, ideal: 2, zoom: 5 });
		internals.controller.seedPage(1, [stroke('a', [[100, 100], [200, 200]])]);
		await internals.renderDetail(1);

		const ink = content.querySelector<HTMLCanvasElement>('.inkling-ink-detail');
		const calls = (ink?.getContext('2d') as unknown as { calls: Array<{ op: string; args: unknown[] }> }).calls;
		const transforms = calls.filter((call) => call.op === 'setTransform').map((call) => call.args);
		// The page's canvas is 612 * 6 wide; the sharp copy draws the page
		// 1000 px wide.
		expect(transforms.at(-1)?.[0]).toBeCloseTo(1000 / (612 * 6), 6);
		expect(calls.some((call) => call.op === 'stroke' || call.op === 'fill')).toBe(true);
	});

	it('goes away again when the view zooms back out', async () => {
		const { internals, content } = openZoomed({ rendered: 6, ideal: 2, zoom: 5 });
		await internals.renderDetail(1);
		internals.removeDetail(1);

		expect(content.querySelector('.inkling-detail-layer')).toBeNull();
		expect(content.querySelector('.inkling-annotation-base')?.classList.contains('has-detail-hole')).toBe(false);
		expect(content.querySelector('.inkling-annotation-overlay')?.classList.contains('is-detailed')).toBe(false);
	});

	it('repaints the sharp ink when a stroke is added', async () => {
		const { internals, content } = openZoomed({ rendered: 6, ideal: 2, zoom: 5 });
		await internals.renderDetail(1);
		const ink = content.querySelector<HTMLCanvasElement>('.inkling-ink-detail');
		const calls = (ink?.getContext('2d') as unknown as { calls: unknown[] }).calls;
		const before = calls.length;

		internals.controller.seedPage(1, [stroke('b', [[300, 300], [400, 420]])]);

		// The harness runs animation frames at once.
		expect(calls.length).toBeGreaterThan(before);
	});
});
