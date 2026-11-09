// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StrokeAnnotation } from '../../src/annotate/types';
import { openPdfView } from '../harness/pdfView';
import { installSurfaceStubs, mountTestSurface } from '../harness/surface';

// The things that used to be seen happening: a page blanking while it was
// sharpened, a reload that took everything off the screen, and work done
// more often than the screen can show it.

function queuedFrames() {
	const frames: FrameRequestCallback[] = [];
	vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => frames.push(callback));
	vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
	return () => frames.splice(0).forEach((callback) => callback(0));
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('ink repainted while it is being changed', () => {
	function line(id: string, y: number): StrokeAnnotation {
		return { id, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 3, points: [{ x: 100, y }, { x: 300, y }] };
	}

	it('is painted once a frame while erasing, however many samples the pen sends, and at once when it lifts', () => {
		document.body.innerHTML = '';
		const surface = mountTestSurface(800, 450);
		surface.controller.seedPage(1, [line('a', 100), line('b', 120), line('c', 140), line('d', 160)]);
		surface.controller.setTool('eraser');
		const paints = () => surface.baseCalls().filter((call) => call.op === 'clearRect').length;
		const before = paints();
		const runFrames = queuedFrames();

		surface.pointer('pointerdown', 200, 95, { pointerType: 'pen' });
		for (const y of [100, 120, 140]) surface.pointer('pointermove', 200, y, { pointerType: 'pen' });
		expect(paints()).toBe(before);
		runFrames();
		expect(paints()).toBe(before + 1);

		surface.pointer('pointermove', 200, 160, { pointerType: 'pen' });
		surface.pointer('pointerup', 200, 160, { pointerType: 'pen', buttons: 0 });
		expect(paints()).toBe(before + 2);
		expect(surface.annotations()).toHaveLength(0);
	});
});

describe('the PDF view', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		installSurfaceStubs();
	});

	function open() {
		const harness = openPdfView();
		const internals = harness.view as unknown as {
			contentEl: HTMLElement;
			containerEl: HTMLElement;
			pdf: unknown;
			pageIds: string[];
			viewZoomLevel: number;
			visiblePages: Set<number>;
			renderedPages: Set<number>;
			pageCanvases: Map<number, HTMLCanvasElement>;
			viewports: Map<number, unknown>;
			baseScales: Map<number, number>;
			renderedScales: Map<number, number>;
			reloadCover: HTMLElement | null;
			viewZoom: { get(): number; zoomTo(scale: number, anchor: unknown, at: { x: number; y: number }): void; settle(): void };
			zoomViewTo(scale: number, anchor: unknown, at: { x: number; y: number }): void;
			captureHold(keepPlace: boolean): { zoom: number; place: { pageId: string | null; fraction: number } | null };
			restoreHold(hold: unknown): void;
			dropReloadCoverIfReady(): void;
			upgradeResolution(page: number, zoom: number): Promise<void>;
			controller: { mountPage(page: number, host: HTMLElement, width: number, height: number): void; resizePage: unknown };
		};
		const { contentEl, containerEl } = internals;
		document.body.appendChild(containerEl);
		if (!containerEl.contains(contentEl)) containerEl.appendChild(contentEl);
		contentEl.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600);
		return { internals, contentEl };
	}

	function page(contentEl: HTMLElement, pageNumber: number, top: number): HTMLElement {
		const placeholder = contentEl.createDiv({ cls: 'inkling-pdf-page-placeholder' });
		placeholder.dataset.pageNumber = String(pageNumber);
		placeholder.getBoundingClientRect = () => new DOMRect(0, top, 800, 1000);
		placeholder.createEl('canvas', { cls: 'inkling-pdf-page' });
		return placeholder;
	}

	describe('drawing pages', () => {
		function pagesOf(count: number) {
			const tasks = new Map<number, { resolve: () => void; cancel: ReturnType<typeof vi.fn> }>();
			const started: number[] = [];
			const pdf = {
				numPages: count,
				getPage: async (pageNumber: number) => ({
					view: [0, 0, 600, 800],
					rotate: 0,
					getViewport: ({ scale }: { scale: number }) => ({ scale, width: 600 * scale, height: 800 * scale }),
					getTextContent: async () => ({ items: [] }),
					render: () => {
						started.push(pageNumber);
						let resolve: () => void = () => undefined;
						const promise = new Promise<void>((done) => (resolve = done));
						const cancel = vi.fn();
						tasks.set(pageNumber, { resolve, cancel });
						return { promise, cancel };
					},
				}),
			};
			return { pdf, tasks, started };
		}

		const settle = async () => {
			for (let turn = 0; turn < 12; turn++) await Promise.resolve();
		};

		function view(count: number, current: number) {
			const { internals, contentEl } = open();
			const pages = pagesOf(count);
			internals.pdf = pages.pdf;
			(internals as unknown as { currentPageNumber: number }).currentPageNumber = current;
			const token = (internals as unknown as { renderToken: number }).renderToken;
			const placeholders = Array.from({ length: count }, (_, index) => page(contentEl, index + 1, (index + 1 - current) * 1000));
			placeholders.forEach((placeholder) => placeholder.querySelector('canvas')?.remove());
			const report = (shown: number[], gone: number[] = []) =>
				(internals as unknown as { onIntersect(entries: unknown[], token: number): void }).onIntersect(
					[...shown.map((n) => ({ target: placeholders[n - 1], isIntersecting: true })), ...gone.map((n) => ({ target: placeholders[n - 1], isIntersecting: false }))],
					token,
				);
			return { internals, ...pages, placeholders, report };
		}

		it('draws two pages at a time, the ones nearest the reader first', async () => {
			const { report, tasks, started } = view(9, 5);
			report([3, 4, 5, 6, 7]);
			await settle();
			expect(started.sort((a, b) => a - b)).toEqual([5, 6]);
			tasks.get(5)?.resolve();
			await settle();
			expect(started).toContain(4);
			expect(started).toHaveLength(3);
		});

		it('never draws a page that was flown past before its turn', async () => {
			const { internals, report, tasks, started } = view(9, 1);
			report([1, 2, 3, 4, 5]);
			await settle();
			expect(started.sort((a, b) => a - b)).toEqual([1, 2]);
			report([], [3, 4, 5]);
			tasks.get(1)?.resolve();
			tasks.get(2)?.resolve();
			await settle();
			expect(started).toHaveLength(2);
			expect([...internals.renderedPages].sort((a, b) => a - b)).toEqual([1, 2]);
		});

		it('calls off a page scrolled away while it is being drawn, and can draw it again', async () => {
			const { internals, report, tasks, started, placeholders } = view(3, 1);
			report([1]);
			await settle();
			report([], [1]);
			expect(tasks.get(1)?.cancel).toHaveBeenCalled();
			expect(internals.renderedPages.has(1)).toBe(false);
			tasks.get(1)?.resolve();
			await settle();
			expect(placeholders[0]?.querySelector('.inkling-page-content')).toBeNull();
			report([1]);
			await settle();
			expect(started).toEqual([1, 1]);
			tasks.get(1)?.resolve();
			await settle();
			expect(placeholders[0]?.querySelectorAll('.inkling-page-content')).toHaveLength(1);
		});

		it('shows a page only once it is finished, with its ink in the same moment', async () => {
			const { internals, report, tasks, placeholders } = view(1, 1);
			const mounted = vi.spyOn(internals.controller, 'mountPage');
			report([1]);
			await settle();
			expect(placeholders[0]?.querySelector('.inkling-pdf-page')).toBeNull();
			expect(mounted).not.toHaveBeenCalled();
			tasks.get(1)?.resolve();
			await settle();
			expect(placeholders[0]?.querySelector('.inkling-pdf-page')).not.toBeNull();
			expect(mounted).toHaveBeenCalledTimes(1);
		});
	});

	it('does a zoom once a frame, however many steps two fingers send', () => {
		const { internals } = open();
		const runFrames = queuedFrames();
		const zoomed = vi.spyOn(internals, 'zoomViewTo');
		internals.viewZoom.zoomTo(1.2, { page: null, fx: 0, fy: 0 }, { x: 0, y: 0 });
		internals.viewZoom.zoomTo(1.4, { page: null, fx: 0, fy: 0 }, { x: 0, y: 0 });
		// Wheel steps build on the one before, even before it is drawn.
		expect(internals.viewZoom.get()).toBe(1.4);
		internals.viewZoom.zoomTo(1.6, { page: null, fx: 0, fy: 0 }, { x: 0, y: 0 });
		expect(zoomed).not.toHaveBeenCalled();
		runFrames();
		expect(zoomed).toHaveBeenCalledTimes(1);
		expect(zoomed.mock.calls[0]?.[0]).toBe(1.6);
	});

	it('does not lose the last step of a zoom that ends before its frame', () => {
		const { internals } = open();
		queuedFrames();
		internals.viewZoom.zoomTo(2, { page: null, fx: 0, fy: 0 }, { x: 0, y: 0 });
		internals.viewZoom.settle();
		expect(internals.viewZoomLevel).toBe(2);
	});

	it('keeps a page on screen until its sharper copy is ready', async () => {
		const { internals, contentEl } = open();
		const placeholder = page(contentEl, 1, 0);
		const old = placeholder.querySelector('canvas') as HTMLCanvasElement;
		old.width = 600;
		internals.pageCanvases.set(1, old);
		internals.renderedPages.add(1);
		internals.viewports.set(1, {
			width: 600,
			height: 800,
			scale: 1,
			convertToPdfPoint: (x: number, y: number) => [x, y],
			convertToViewportPoint: (x: number, y: number) => [x, y],
		});
		internals.baseScales.set(1, 1);
		internals.renderedScales.set(1, 1);
		internals.controller.mountPage(1, placeholder, 600, 800);
		let finish: () => void = () => undefined;
		internals.pdf = {
			getPage: async () => ({
				getViewport: ({ scale }: { scale: number }) => ({
					scale,
					width: 600 * scale,
					height: 800 * scale,
					convertToPdfPoint: (x: number, y: number) => [x / scale, y / scale],
					convertToViewportPoint: (x: number, y: number) => [x * scale, y * scale],
				}),
				render: () => ({ promise: new Promise<void>((resolve) => (finish = resolve)), cancel: vi.fn() }),
			}),
		};

		const upgrading = internals.upgradeResolution(1, 3);
		await vi.waitFor(() => expect(finish).not.toBe(undefined));
		await new Promise((resolve) => window.setTimeout(resolve, 0));
		// Still the old picture, at its old size, while the new one is drawn.
		expect(old.isConnected).toBe(true);
		expect(old.width).toBe(600);

		finish();
		await upgrading;
		expect(old.isConnected).toBe(false);
		const now = placeholder.querySelector<HTMLCanvasElement>('.inkling-pdf-page');
		expect(now?.width).toBeGreaterThan(600);
		expect(internals.pageCanvases.get(1)).toBe(now);
	});

	it('holds its zoom, its place and a picture of the pages through a reload', () => {
		const { internals, contentEl } = open();
		internals.viewZoomLevel = 1.5;
		page(contentEl, 1, -1200);
		page(contentEl, 2, -200);
		internals.visiblePages.add(1).add(2);
		internals.pageIds = ['10.0', '20.0'];

		const hold = internals.captureHold(true);
		expect(hold.zoom).toBe(1.5);
		expect(hold.place?.pageId).toBe('20.0');
		expect(hold.place?.fraction).toBeCloseTo(0.2, 6);
		expect(internals.reloadCover?.querySelectorAll('canvas')).toHaveLength(1);

		// Reloaded, with that page now first: found by what it is.
		contentEl.empty();
		internals.pageIds = ['20.0', '10.0'];
		const placeholder = page(contentEl, 1, 500);
		page(contentEl, 2, 1600);
		internals.restoreHold(hold);
		expect(contentEl.scrollTop).toBe(700);

		// Up until the page on screen has been drawn.
		internals.visiblePages.clear();
		internals.visiblePages.add(1);
		internals.pageCanvases.clear();
		internals.dropReloadCoverIfReady();
		expect(internals.reloadCover).not.toBeNull();
		internals.pageCanvases.set(1, placeholder.querySelector('canvas') as HTMLCanvasElement);
		internals.dropReloadCoverIfReady();
		expect(internals.reloadCover).toBeNull();
		expect(document.querySelector('.inkling-reload-cover')).toBeNull();
	});

	it('takes the picture down by itself if the new pages never come', () => {
		vi.useFakeTimers();
		const { internals, contentEl } = open();
		page(contentEl, 1, 0);
		internals.visiblePages.add(1);
		internals.captureHold(true);
		expect(internals.reloadCover).not.toBeNull();
		vi.advanceTimersByTime(9000);
		expect(internals.reloadCover).toBeNull();
		vi.useRealTimers();
	});
});

