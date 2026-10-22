import { describe, expect, it } from 'vitest';
import {
	MAX_CANVAS_PIXELS,
	MAX_RENDER_SCALE,
	RENDER_SCALE,
	baseRenderScale,
	capToPixelBudget,
	layoutRenderScale,
	zoomedRenderScale,
} from '../../src/pdf/renderScale';

// The numbers here are the ones measured in the running app on 2026-09-07,
// comparing Obsidian's core `pdf` view against the annotate view on the same
// file in the same pane. See the header of src/pdf/renderScale.ts.
const PANE_WIDTH = 1276;
// "Engineering a Compiler" — 540pt wide, which the old flat 1.5x laid out at
// 810px while the core viewer fitted it to 1224px in the very same pane.
const PAGE_POINTS = 540;
const CORE_VIEWER_WIDTH = 1224;
const OLD_FIXED_WIDTH = 810;

describe('layoutRenderScale', () => {
	it('fits the page to the pane, as the core PDF viewer does', () => {
		const scale = layoutRenderScale(CORE_VIEWER_WIDTH, PAGE_POINTS);
		expect(PAGE_POINTS * scale).toBeCloseTo(CORE_VIEWER_WIDTH, 5);
	});

	it('is the regression: a flat 1.5x showed two thirds of a page', () => {
		// Stated as the thing this must no longer do. 810 / 1224 = 0.66.
		expect(PAGE_POINTS * RENDER_SCALE).toBe(OLD_FIXED_WIDTH);
		expect(PAGE_POINTS * layoutRenderScale(CORE_VIEWER_WIDTH, PAGE_POINTS)).toBeGreaterThan(OLD_FIXED_WIDTH);
	});

	it('scales a small-format book up rather than leaving it tiny', () => {
		// A 316pt page — the annotate view drew this one 474px wide in a
		// 1276px pane, against the core viewer's 1224px.
		expect(layoutRenderScale(1224, 316)).toBeCloseTo(1224 / 316, 5);
		expect(316 * layoutRenderScale(1224, 316)).toBeGreaterThan(474);
	});

	it('caps a very small page in a very wide pane', () => {
		expect(layoutRenderScale(4000, 200)).toBe(MAX_RENDER_SCALE);
	});

	it('falls back to the old fixed scale before anything can be measured', () => {
		expect(layoutRenderScale(0, PAGE_POINTS)).toBe(RENDER_SCALE);
		expect(layoutRenderScale(PANE_WIDTH, 0)).toBe(RENDER_SCALE);
	});
});

describe('baseRenderScale', () => {
	it('backs the canvas pixel-for-pixel with how the page is displayed', () => {
		const layout = layoutRenderScale(CORE_VIEWER_WIDTH, PAGE_POINTS);
		expect(baseRenderScale(PAGE_POINTS * layout, PAGE_POINTS, 1)).toBeCloseTo(layout, 5);
	});

	it('multiplies by devicePixelRatio, which this view never used to do', () => {
		const layout = layoutRenderScale(CORE_VIEWER_WIDTH, PAGE_POINTS);
		expect(baseRenderScale(PAGE_POINTS * layout, PAGE_POINTS, 2)).toBeCloseTo(layout * 2, 5);
	});

	it('renders below the old fixed scale when the page is displayed smaller', () => {
		// A narrow pane on a 1x screen. Forcing 1.5 here would back the
		// canvas larger than the box it is drawn in — a downscale, which
		// reads softer than rendering at the displayed size.
		const scale = baseRenderScale(625, 612, 1);
		expect(scale).toBeLessThan(RENDER_SCALE);
		expect(612 * scale).toBeCloseTo(625, 5);
	});

	it('caps a wide pane on a dense screen', () => {
		expect(baseRenderScale(2400, 612, 3)).toBe(MAX_RENDER_SCALE);
	});

	it('falls back when the page has not been laid out yet', () => {
		expect(baseRenderScale(0, PAGE_POINTS, 2)).toBe(RENDER_SCALE);
		expect(baseRenderScale(800, 0, 2)).toBe(RENDER_SCALE);
	});
});

describe('zoomedRenderScale', () => {
	it('keeps the density relationship as a page is zoomed into', () => {
		expect(zoomedRenderScale(2, 2)).toBe(4);
	});

	it('never exceeds the memory ceiling', () => {
		expect(zoomedRenderScale(3, 4)).toBe(MAX_RENDER_SCALE);
	});
});

describe('capToPixelBudget', () => {
	it('leaves an ordinary page alone', () => {
		expect(capToPixelBudget(2, 612, 792)).toBe(2);
	});

	it('keeps a large page inside what one canvas may hold', () => {
		const scale = capToPixelBudget(4, 3000, 3000);
		expect(3000 * scale * 3000 * scale).toBeLessThanOrEqual(MAX_CANVAS_PIXELS + 1);
		expect(scale).toBeLessThan(4);
	});
});
