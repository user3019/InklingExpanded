// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openPdfView } from '../harness/pdfView';
import { installSurfaceStubs } from '../harness/surface';

// The PDF view's zoom is the whole view's, the way Obsidian's own reader
// zooms: every page grows, and the view scrolls so that whatever was under
// the fingers (or the cursor) stays there. jsdom has no layout, so the page
// here reports the rectangle a browser would give it at the current zoom
// and scroll.

const PAGE_WIDTH = 600;
const PAGE_HEIGHT = 776;
const PAGE_LEFT = 100;
const PAGE_TOP = 60;

function openZoomable() {
	installSurfaceStubs();
	const harness = openPdfView();
	const view = harness.view;
	const internals = view as unknown as {
		viewZoomLevel: number;
		renderedPages: Set<number>;
		upgradeResolution(page: number, zoom: number): Promise<void>;
		viewAnchorAt(at: { x: number; y: number }): unknown;
		zoomViewTo(scale: number, anchor: unknown, at: { x: number; y: number }): void;
	};
	const container = view.contentEl;
	document.body.appendChild(container);
	let scroll = { left: 0, top: 0 };
	Object.defineProperty(container, 'scrollLeft', { get: () => scroll.left, set: (value: number) => (scroll = { ...scroll, left: value }) });
	Object.defineProperty(container, 'scrollTop', { get: () => scroll.top, set: (value: number) => (scroll = { ...scroll, top: value }) });
	container.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);

	const page = container.createDiv({ cls: 'inkling-pdf-page-placeholder' });
	page.dataset.pageNumber = '1';
	page.getBoundingClientRect = () => {
		const zoom = internals.viewZoomLevel;
		return new DOMRect(PAGE_LEFT * zoom - scroll.left, PAGE_TOP * zoom - scroll.top, PAGE_WIDTH * zoom, PAGE_HEIGHT * zoom);
	};
	// Where on the page a client point falls, as a fraction of its size.
	const fractionAt = (x: number, y: number) => {
		const rect = page.getBoundingClientRect();
		return { fx: (x - rect.left) / rect.width, fy: (y - rect.top) / rect.height };
	};
	return { view, internals, scroll: () => scroll, fractionAt };
}

beforeEach(() => {
	document.body.innerHTML = '';
});

describe('zooming the PDF view', () => {
	it('keeps the spot under the fingers where it is', () => {
		const { internals, fractionAt } = openZoomable();
		const at = { x: 400, y: 300 };
		const before = fractionAt(at.x, at.y);

		internals.zoomViewTo(2.5, internals.viewAnchorAt(at), at);

		expect(internals.viewZoomLevel).toBe(2.5);
		const after = fractionAt(at.x, at.y);
		expect(after.fx).toBeCloseTo(before.fx, 6);
		expect(after.fy).toBeCloseTo(before.fy, 6);
	});

	it('follows the fingers as they move, which is a pan', () => {
		const { internals, fractionAt } = openZoomable();
		const start = { x: 400, y: 300 };
		const spot = fractionAt(start.x, start.y);
		const anchor = internals.viewAnchorAt(start);

		internals.zoomViewTo(1.5, anchor, { x: 300, y: 200 });

		const now = fractionAt(300, 200);
		expect(now.fx).toBeCloseTo(spot.fx, 6);
		expect(now.fy).toBeCloseTo(spot.fy, 6);
	});

	it('scales every page through one property on the view', () => {
		const { view, internals } = openZoomable();
		internals.zoomViewTo(0.5, internals.viewAnchorAt({ x: 400, y: 300 }), { x: 400, y: 300 });
		expect(view.contentEl.style.getPropertyValue('--inkling-view-zoom')).toBe('0.5');
	});

	it('stays within its range', () => {
		const { internals } = openZoomable();
		const at = { x: 400, y: 300 };
		internals.zoomViewTo(50, internals.viewAnchorAt(at), at);
		expect(internals.viewZoomLevel).toBe(5);
		internals.zoomViewTo(0.01, internals.viewAnchorAt(at), at);
		expect(internals.viewZoomLevel).toBe(0.25);
	});

	it('re-renders every page on screen once the zoom settles', () => {
		const { view, internals } = openZoomable();
		internals.renderedPages.add(1);
		internals.renderedPages.add(2);
		const rerender = vi.spyOn(internals, 'upgradeResolution').mockResolvedValue();
		const controller = (view as unknown as { controller: { zoomBy(factor: number): void } }).controller;

		controller.zoomBy(2);

		expect(rerender).toHaveBeenCalledWith(1, 2);
		expect(rerender).toHaveBeenCalledWith(2, 2);
	});
});
