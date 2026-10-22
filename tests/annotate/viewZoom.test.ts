// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachViewNavigation, type ViewZoom } from '../../src/annotate/pointer';
import { makePointerEvent, mountTestSurface, type PointerOptions, type TestSurface } from '../harness/surface';

// A host that zooms its whole view (the PDF view) moves about the way a PDF
// reader does: from anywhere in the view, not only over a page. Its pages
// leave touch, wheel zoom and the middle button alone so that they bubble
// up to attachViewNavigation on the scroll container. What the host then
// does with a zoom is pdfView's business (see tests/pdf/pdfViewZoom.test.ts);
// what is checked here is that every way of asking for one reaches it.

function fakeViewZoom() {
	let level = 1;
	const calls: Array<{ scale: number; anchor: unknown; at: { x: number; y: number } }> = [];
	const zoom: ViewZoom & { calls: typeof calls; settled: number } = {
		min: 0.25,
		max: 5,
		calls,
		settled: 0,
		get: () => level,
		anchorAt: (at) => ({ anchoredAt: at }),
		zoomTo: (scale, anchor, at) => {
			level = Math.min(Math.max(scale, 0.25), 5);
			calls.push({ scale, anchor, at });
		},
		centre: () => ({ x: 400, y: 300 }),
		settle: () => {
			zoom.settled += 1;
		},
	};
	return zoom;
}

let surface: TestSurface;
let zoom: ReturnType<typeof fakeViewZoom>;
let scroller: HTMLElement;
let scroll: { left: number; top: number };
let busy: boolean;
let gap: HTMLElement;

beforeEach(() => {
	document.body.innerHTML = '';
	zoom = fakeViewZoom();
	busy = false;
	surface = mountTestSurface(800, 450, { viewZoom: zoom });

	// The view: a scroll container holding the page, a gap beside it, and a
	// panel that scrolls by itself.
	scroller = document.body.appendChild(document.createElement('div'));
	scroll = { left: 500, top: 1000 };
	Object.defineProperty(scroller, 'scrollLeft', { get: () => scroll.left, set: (value: number) => (scroll = { ...scroll, left: value }) });
	Object.defineProperty(scroller, 'scrollTop', { get: () => scroll.top, set: (value: number) => (scroll = { ...scroll, top: value }) });
	scroller.appendChild(surface.host);
	gap = scroller.appendChild(document.createElement('div'));
	const panel = scroller.appendChild(document.createElement('div'));
	panel.className = 'own-scroll';
	attachViewNavigation(scroller, zoom, {
		ignore: (target) => target instanceof Element && target.closest('.own-scroll') !== null,
		isBusy: () => busy,
	});
});

function on(target: Element, type: string, x: number, y: number, options: PointerOptions) {
	target.dispatchEvent(makePointerEvent(type, { ...options, clientX: x, clientY: y }));
}

describe('moving about a view-zoomed surface', () => {
	it('zooms and pans together when two fingers pinch over a page', () => {
		surface.pointer('pointerdown', 100, 100, { pointerType: 'touch', pointerId: 11 });
		surface.pointer('pointerdown', 200, 100, { pointerType: 'touch', pointerId: 12 });
		// Fingers twice as far apart, and both moved down 50.
		surface.pointer('pointermove', 50, 150, { pointerType: 'touch', pointerId: 11 });
		surface.pointer('pointermove', 250, 150, { pointerType: 'touch', pointerId: 12 });

		const last = zoom.calls.at(-1);
		expect(last?.scale).toBeCloseTo(2, 5);
		// Anchored where the pinch began, held under where the fingers are.
		expect(last?.anchor).toEqual({ anchoredAt: { x: 150, y: 100 } });
		expect(last?.at).toEqual({ x: 150, y: 150 });
		// The page's own transform is untouched.
		expect(surface.controller.getPageZoom(1)).toBe(1);

		surface.pointer('pointerup', 250, 150, { pointerType: 'touch', pointerId: 12 });
		expect(zoom.settled).toBe(1);
		expect(surface.controller.getZoom()).toBeCloseTo(2, 5);
	});

	it('pinches in the gap between pages too', () => {
		on(gap, 'pointerdown', 100, 100, { pointerType: 'touch', pointerId: 21 });
		on(gap, 'pointerdown', 200, 100, { pointerType: 'touch', pointerId: 22 });
		on(gap, 'pointermove', 0, 100, { pointerType: 'touch', pointerId: 21 });
		on(gap, 'pointermove', 300, 100, { pointerType: 'touch', pointerId: 22 });
		expect(zoom.calls.at(-1)?.scale).toBeCloseTo(3, 5);
	});

	it('drags the view with one finger, sideways as well as down', () => {
		surface.pointer('pointerdown', 300, 300, { pointerType: 'touch', pointerId: 31 });
		surface.pointer('pointermove', 260, 200, { pointerType: 'touch', pointerId: 31 });
		expect(scroll).toEqual({ left: 540, top: 1100 });
		// Cancelled rather than released: a release can fling the view on,
		// and the harness runs animation frames synchronously, so the glide
		// would run here to its end against a scroller with no end.
		surface.pointer('pointercancel', 260, 200, { pointerType: 'touch', pointerId: 31 });
		expect(surface.annotations()).toHaveLength(0);
	});

	it('zooms about the cursor on a trackpad pinch, which Chromium sends as Ctrl+wheel', () => {
		gap.dispatchEvent(
			Object.assign(new Event('wheel', { bubbles: true, cancelable: true }), { ctrlKey: true, metaKey: false, deltaY: -100, clientX: 320, clientY: 240 }),
		);
		const last = zoom.calls.at(-1);
		expect(last?.scale).toBeGreaterThan(1);
		expect(last?.at).toEqual({ x: 320, y: 240 });
	});

	it('leaves a plain wheel to scroll', () => {
		const wheel = Object.assign(new Event('wheel', { bubbles: true, cancelable: true }), { ctrlKey: false, metaKey: false, deltaY: 100 });
		gap.dispatchEvent(wheel);
		expect(zoom.calls).toHaveLength(0);
		expect(wheel.defaultPrevented).toBe(false);
	});

	it('zooms on a trackpad pinch in Safari and on an iPad, which send gesture events', () => {
		const gesture = (type: string, scale: number) =>
			gap.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { scale, clientX: 120, clientY: 80 }));
		gesture('gesturestart', 1);
		gesture('gesturechange', 1.5);
		gesture('gestureend', 1.5);
		expect(zoom.calls.at(-1)?.scale).toBeCloseTo(1.5, 5);
		expect(zoom.calls.at(-1)?.at).toEqual({ x: 120, y: 80 });
		expect(zoom.settled).toBe(1);
	});

	it('does not count a finger pinch twice when WebKit also sends gesture events for it', () => {
		on(gap, 'pointerdown', 100, 100, { pointerType: 'touch', pointerId: 41 });
		on(gap, 'pointerdown', 200, 100, { pointerType: 'touch', pointerId: 42 });
		gap.dispatchEvent(Object.assign(new Event('gesturestart', { bubbles: true, cancelable: true }), { scale: 1, clientX: 150, clientY: 100 }));
		const before = zoom.calls.length;
		gap.dispatchEvent(Object.assign(new Event('gesturechange', { bubbles: true, cancelable: true }), { scale: 4, clientX: 150, clientY: 100 }));
		expect(zoom.calls).toHaveLength(before);
	});

	it('zooms about its centre from the toolbar, out below the fitted size too', () => {
		surface.controller.zoomBy(0.5);
		expect(zoom.calls.at(-1)?.at).toEqual({ x: 400, y: 300 });
		expect(surface.controller.getZoom()).toBe(0.5);
		expect(surface.controller.getZoomRange()).toEqual({ min: 0.25, max: 5 });
		surface.controller.resetZoom();
		expect(surface.controller.getZoom()).toBe(1);
		expect(zoom.settled).toBe(2);
	});

	it('does not move while the pen is down — that finger is the hand holding it', () => {
		busy = true;
		surface.pointer('pointerdown', 300, 300, { pointerType: 'touch', pointerId: 51 });
		surface.pointer('pointermove', 200, 100, { pointerType: 'touch', pointerId: 51 });
		expect(scroll).toEqual({ left: 500, top: 1000 });
	});

	it('leaves a panel that scrolls by itself alone', () => {
		const panel = scroller.querySelector('.own-scroll');
		if (!panel) throw new Error('no panel');
		on(panel, 'pointerdown', 300, 300, { pointerType: 'touch', pointerId: 61 });
		on(panel, 'pointermove', 300, 100, { pointerType: 'touch', pointerId: 61 });
		expect(scroll).toEqual({ left: 500, top: 1000 });
	});
});

describe('the middle mouse button', () => {
	it('drags the view about instead of drawing', () => {
		surface.pointer('pointerdown', 300, 300, { pointerType: 'mouse', button: 1 });
		surface.pointer('pointermove', 300, 200, { pointerType: 'mouse', button: 1 });
		expect(scroll.top).toBe(1100);
		surface.pointer('pointercancel', 300, 200, { pointerType: 'mouse', button: 1 });
		expect(surface.annotations()).toHaveLength(0);
	});

	it('leaves the left button drawing', () => {
		surface.drawStroke([
			[100, 100],
			[200, 120],
		]);
		expect(surface.annotations()).toHaveLength(1);
	});
});

describe('a surface without a view zoom', () => {
	it('keeps zooming its own page, never below fitted', () => {
		const own = mountTestSurface(800, 450);
		expect(own.controller.getZoomRange().min).toBe(1);
		const before = zoom.calls.length;
		own.controller.zoomBy(2);
		expect(zoom.calls).toHaveLength(before);
		expect(own.controller.getPageZoom(1)).toBe(2);
	});
});

describe('a finger held still in the view', () => {
	it('is offered to the host as a long press, and stops scrolling once taken', () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const view = document.body.appendChild(document.createElement('div'));
		let top = 500;
		Object.defineProperty(view, 'scrollTop', { get: () => top, set: (value: number) => (top = value) });
		const onLongPress = vi.fn(() => true);
		attachViewNavigation(view, fakeViewZoom(), { ignore: () => false, isBusy: () => false, onLongPress });

		on(view, 'pointerdown', 120, 140, { pointerType: 'touch', pointerId: 71 });
		vi.advanceTimersByTime(600);
		expect(onLongPress).toHaveBeenCalledWith({ x: 120, y: 140 });
		on(view, 'pointermove', 120, 40, { pointerType: 'touch', pointerId: 71 });
		expect(top).toBe(500);
		vi.useRealTimers();
	});

	it('is not one once it has moved: that was a scroll', () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const view = document.body.appendChild(document.createElement('div'));
		const onLongPress = vi.fn(() => true);
		attachViewNavigation(view, fakeViewZoom(), { ignore: () => false, isBusy: () => false, onLongPress });

		on(view, 'pointerdown', 120, 140, { pointerType: 'touch', pointerId: 72 });
		on(view, 'pointermove', 120, 100, { pointerType: 'touch', pointerId: 72 });
		vi.advanceTimersByTime(600);
		expect(onLongPress).not.toHaveBeenCalled();
		vi.useRealTimers();
	});
});

describe('a finger’s tap in the view', () => {
	it('is told to the host, so it can let go of a selection', () => {
		const view = document.body.appendChild(document.createElement('div'));
		const onTap = vi.fn();
		attachViewNavigation(view, fakeViewZoom(), { ignore: () => false, isBusy: () => false, onTap });
		on(view, 'pointerdown', 50, 60, { pointerType: 'touch', pointerId: 81 });
		on(view, 'pointerup', 50, 60, { pointerType: 'touch', pointerId: 81 });
		expect(onTap).toHaveBeenCalledWith({ x: 50, y: 60 });
	});

	it('is not a tap once it has scrolled', () => {
		const view = document.body.appendChild(document.createElement('div'));
		const onTap = vi.fn();
		attachViewNavigation(view, fakeViewZoom(), { ignore: () => false, isBusy: () => false, onTap });
		on(view, 'pointerdown', 50, 60, { pointerType: 'touch', pointerId: 82 });
		on(view, 'pointermove', 50, 160, { pointerType: 'touch', pointerId: 82 });
		on(view, 'pointercancel', 50, 160, { pointerType: 'touch', pointerId: 82 });
		expect(onTap).not.toHaveBeenCalled();
	});
});
