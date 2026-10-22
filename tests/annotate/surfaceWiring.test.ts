// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { mountTestSurface, pointsOf, type TestSurface } from '../harness/surface';

// Wiring, not logic. Everything asserted here is already correct as a pure
// function and was still wrong in the app, because nothing connected the two
// and no test could tell.

let surface: TestSurface;

beforeEach(() => {
	document.body.innerHTML = '';
	surface = mountTestSurface(800, 450);
});

describe('a mounted surface', () => {
	it('commits a drawn stroke to the page', () => {
		surface.drawStroke([
			[100, 100],
			[150, 120],
			[200, 90],
			[260, 140],
		]);
		const annotations = surface.annotations();
		expect(annotations).toHaveLength(1);
		expect(annotations[0]?.kind).toBe('stroke');
	});

	// A pen that reported pressure draws as a filled outline, because no
	// stroked line can vary its width along its length; one that did not
	// draws as a stroked path. Both are asserted because the renderer picks
	// between them, and picking wrong is invisible until you look at ink.
	it('fills a pressure stroke on the base layer', () => {
		// The round pen starts with its pressure switch off.
		surface.controller.setPressure('pen', true);
		surface.drawStroke(
			[
				[100, 100],
				[200, 140],
				[300, 100],
			],
			{ pressure: 0.6 },
		);
		expect(surface.baseCalls().map((c) => c.op)).toContain('fill');
	});

	it('strokes a pen that reported no pressure', () => {
		surface.drawStroke(
			[
				[100, 100],
				[200, 140],
				[300, 100],
			],
			{ pressure: 0, pointerType: 'mouse' },
		);
		expect(surface.baseCalls().map((c) => c.op)).toContain('stroke');
	});
});

describe('drawing is clamped to the surface', () => {
	// The pure clamp has its own tests. This asks the separate question of
	// whether a stroke drawn in anger actually goes through it — pointer
	// capture delivers moves wherever the pen goes, so without the wiring a
	// stroke leaves the page and is invisible only because a canvas discards
	// what falls off it.
	it('keeps a stroke dragged off the right edge inside the page', () => {
		surface.drawStroke([
			[100, 100],
			[400, 120],
			[2000, 140],
		]);
		expect(surface.annotations()).toHaveLength(1);
		const xs = pointsOf(surface.annotations()[0]).map((p) => p.x);
		expect(xs.length).toBeGreaterThan(0);
		expect(Math.max(...xs)).toBeLessThanOrEqual(800);
	});

	it('keeps a stroke dragged above the top inside the page', () => {
		surface.drawStroke([
			[100, 100],
			[200, 50],
			[300, -900],
		]);
		expect(surface.annotations()).toHaveLength(1);
		const ys = pointsOf(surface.annotations()[0]).map((p) => p.y);
		expect(ys.length).toBeGreaterThan(0);
		expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
	});
});

describe('strokes are thinned when they commit', () => {
	it('drops the samples a straight run does not need', () => {
		const points: Array<[number, number]> = [];
		for (let i = 0; i <= 60; i++) points.push([100 + i * 5, 200]);

		surface.drawStroke(points);
		const kept = pointsOf(surface.annotations()[0]);
		expect(kept.length).toBeGreaterThanOrEqual(2);
		expect(kept.length).toBeLessThan(points.length / 4);
	});

	it('keeps the shape of a stroke that actually turns', () => {
		const points: Array<[number, number]> = [];
		for (let i = 0; i <= 60; i++) points.push([100 + i * 5, 200 + Math.sin(i / 3) * 60]);

		surface.drawStroke(points);
		expect(pointsOf(surface.annotations()[0]).length).toBeGreaterThan(6);
	});
});

describe('a read-only surface', () => {
	it('takes no ink at all', () => {
		surface.controller.setReadOnly(true);
		surface.drawStroke([
			[100, 100],
			[200, 140],
			[300, 100],
		]);
		expect(surface.annotations()).toHaveLength(0);
	});

	it('takes ink again once it is not', () => {
		surface.controller.setReadOnly(true);
		surface.drawStroke([[100, 100], [200, 140]]);
		expect(surface.annotations()).toHaveLength(0);

		surface.controller.setReadOnly(false);
		surface.drawStroke([[100, 100], [200, 140], [300, 100]]);
		expect(surface.annotations()).toHaveLength(1);
	});
});

describe('the overlay canvas', () => {
	// Deferred on purpose: the overlay is half the canvas memory a page
	// holds, and a block being read rather than drawn on never needs it.
	it('has no drawing context until something needs drawing on it', () => {
		expect(surface.overlayAcquired()).toBe(false);
	});

	it('gets one as soon as a stroke is under way', () => {
		surface.pointer('pointerdown', 100, 100);
		surface.pointer('pointermove', 150, 120);
		expect(surface.overlayAcquired()).toBe(true);
	});
});

describe('a selection stays on the surface', () => {
	// Drawing was clamped in Phase F; dragging what was already drawn was
	// not, and the two are separate wirings. This is the one that could only
	// be checked by hand before, which is why it went unnoticed.
	function drawAndSelect(): void {
		surface.drawStroke([
			[100, 100],
			[200, 100],
			[300, 100],
		]);
		surface.controller.setTool('select');
		// A lasso has to reach outside the surface to enclose a stroke that
		// touches its edge; lasso points are deliberately not clamped.
		surface.pointer('pointerdown', -60, -60);
		for (const [x, y] of [
			[-60, 400],
			[900, 400],
			[900, -60],
			[-60, -60],
		] as Array<[number, number]>) {
			surface.pointer('pointermove', x, y);
		}
		surface.pointer('pointerup', -60, -60);
	}

	it('stops a selection dragged off the bottom-right at the edge', () => {
		drawAndSelect();

		surface.pointer('pointerdown', 200, 100);
		for (let i = 1; i <= 8; i++) surface.pointer('pointermove', 200 + i * 300, 100 + i * 200);
		surface.pointer('pointerup', 2600, 1700);

		const points = pointsOf(surface.annotations()[0]);
		expect(points.length).toBeGreaterThan(0);
		expect(Math.max(...points.map((p) => p.x))).toBeLessThanOrEqual(800);
		expect(Math.max(...points.map((p) => p.y))).toBeLessThanOrEqual(450);
	});

	it('stops a selection dragged off the top-left at the edge', () => {
		drawAndSelect();

		surface.pointer('pointerdown', 200, 100);
		for (let i = 1; i <= 8; i++) surface.pointer('pointermove', 200 - i * 300, 100 - i * 200);
		surface.pointer('pointerup', -2200, -1500);

		const points = pointsOf(surface.annotations()[0]);
		expect(points.length).toBeGreaterThan(0);
		expect(Math.min(...points.map((p) => p.x))).toBeGreaterThanOrEqual(0);
		expect(Math.min(...points.map((p) => p.y))).toBeGreaterThanOrEqual(0);
	});

	it('moves a selection normally when it stays inside', () => {
		drawAndSelect();

		surface.pointer('pointerdown', 200, 100);
		surface.pointer('pointermove', 250, 150);
		surface.pointer('pointerup', 250, 150);

		const xs = pointsOf(surface.annotations()[0]).map((p) => p.x);
		expect(Math.min(...xs)).toBeCloseTo(150, 0);
	});
});
