// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { boundingBox, polygonSelectsAnnotation, scaleAnnotationAbout } from '../../src/annotate/geometry';
import { handleAt, selectionFrame, selectionHandles } from '../../src/annotate/render';
import type { Annotation, Point, StrokeAnnotation } from '../../src/annotate/types';
import { mountTestSurface, type TestSurface } from '../harness/surface';

// The lasso: draw a dashed loop round some writing, and what is mostly
// inside it is selected — each drawing ringed in thin light blue, the whole
// in a frame with a handle at each corner. Drag inside the frame to move
// it; drag a corner to make it bigger or smaller.

function stroke(id: string, points: Array<[number, number]>, width = 3): StrokeAnnotation {
	return { id, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width, points: points.map(([x, y]) => ({ x, y })) };
}

const square: Point[] = [
	{ x: 0, y: 0 },
	{ x: 100, y: 0 },
	{ x: 100, y: 100 },
	{ x: 0, y: 100 },
];

describe('what a lasso takes', () => {
	it('takes a drawing mostly inside it, though its tail strays out', () => {
		const g = stroke('g', [[20, 20], [40, 20], [60, 40], [80, 60], [90, 80], [95, 120]]);
		expect(polygonSelectsAnnotation(g, square)).toBe(true);
	});

	it('leaves a drawing it only clips the edge of', () => {
		const above = stroke('a', [[20, -60], [40, -40], [60, -20], [80, 10]]);
		expect(polygonSelectsAnnotation(above, square)).toBe(false);
	});
});

describe('scaling a selection', () => {
	it('scales about the fixed corner, the pen width with it', () => {
		const scaled = scaleAnnotationAbout(stroke('s', [[10, 10], [30, 20]], 4), { x: 0, y: 0 }, 2);
		expect(scaled.kind === 'stroke' && scaled.points).toEqual([{ x: 20, y: 20 }, { x: 60, y: 40 }]);
		expect(scaled.width).toBe(8);
	});

	it('moves a note without growing its marker', () => {
		const note: Annotation = { id: 'n', kind: 'note', color: '#000000', width: 1, at: { x: 10, y: 10 }, note: 'hi' };
		const scaled = scaleAnnotationAbout(note, { x: 0, y: 0 }, 3);
		expect(scaled.kind === 'note' && scaled.at).toEqual({ x: 30, y: 30 });
		expect(scaled.width).toBe(1);
	});
});

describe('the frame and its handles', () => {
	const box = { minX: 100, minY: 100, maxX: 200, maxY: 150 };

	it('are sized in screen pixels, so a denser canvas does not shrink them', () => {
		const at1 = selectionFrame(box, 1);
		const at3 = selectionFrame(box, 3);
		expect(box.minX - at3.minX).toBe(3 * (box.minX - at1.minX));
	});

	it('takes a press near a handle, not only dead on it', () => {
		const { se } = selectionHandles(box, 1);
		expect(handleAt(box, 1, { x: se.x + 10, y: se.y + 10 })).toBe('se');
		expect(handleAt(box, 1, { x: 150, y: 125 })).toBeNull();
	});
});

describe('using the lasso', () => {
	let surface: TestSurface;

	beforeEach(() => {
		document.body.innerHTML = '';
		surface = mountTestSurface(800, 450);
		surface.controller.seedPage(1, [
			stroke('one', [[110, 110], [130, 140], [150, 110]]),
			stroke('two', [[170, 110], [190, 140], [200, 120]]),
			stroke('far', [[600, 300], [650, 320]]),
		]);
		surface.controller.setTool('select');
	});

	function loop(points: Array<[number, number]>) {
		surface.drawStroke(points, { pointerType: 'pen' });
	}

	const selectBoth = () =>
		loop([
			[90, 90],
			[230, 90],
			[230, 170],
			[90, 170],
			[90, 95],
		]);

	const boxOf = (ids: string[]) => {
		const boxes = surface.annotations().filter((a) => ids.includes(a.id)).map(boundingBox);
		return {
			minX: Math.min(...boxes.map((b) => b.minX)),
			minY: Math.min(...boxes.map((b) => b.minY)),
			maxX: Math.max(...boxes.map((b) => b.maxX)),
			maxY: Math.max(...boxes.map((b) => b.maxY)),
		};
	};

	it('selects what the loop goes round, and only that', () => {
		selectBoth();
		expect(surface.controller.hasSelection()).toBe(true);
		// Moving it shows which: the far stroke stays put.
		surface.drawStroke([
			[160, 125],
			[260, 225],
		]);
		const far = surface.annotations().find((a) => a.id === 'far');
		expect(far?.kind === 'stroke' && far.points[0]).toEqual({ x: 600, y: 300 });
	});

	it('moves the selection from a press anywhere in its frame, gaps between letters included', () => {
		selectBoth();
		const before = boxOf(['one', 'two']);
		// x 160 is between the two strokes, on neither.
		surface.drawStroke([
			[160, 125],
			[200, 145],
			[260, 225],
		]);
		const after = boxOf(['one', 'two']);
		expect(after.minX - before.minX).toBeCloseTo(100, 5);
		expect(after.minY - before.minY).toBeCloseTo(100, 5);
	});

	it('scales from a corner in proportion, keeping the opposite corner still', () => {
		selectBoth();
		const before = boxOf(['one', 'two']);
		const handle = selectionHandles(before, 1).se;
		// Dragged out to the right only: the writing still grows the same in
		// both directions.
		surface.drawStroke([
			[handle.x, handle.y],
			[handle.x + 45, handle.y],
			[handle.x + 90, handle.y],
		]);
		const after = boxOf(['one', 'two']);
		expect(after.minX).toBeCloseTo(before.minX, 5);
		expect(after.minY).toBeCloseTo(before.minY, 5);
		const growX = (after.maxX - after.minX) / (before.maxX - before.minX);
		const growY = (after.maxY - after.minY) / (before.maxY - before.minY);
		expect(growX).toBeGreaterThan(1.3);
		expect(growY).toBeCloseTo(growX, 5);
		const one = surface.annotations().find((a) => a.id === 'one');
		expect(one?.width).toBeCloseTo(3 * growX, 5);
	});

	it('shrinks too', () => {
		selectBoth();
		const before = boxOf(['one', 'two']);
		const handle = selectionHandles(before, 1).se;
		surface.drawStroke([
			[handle.x, handle.y],
			[before.minX + (before.maxX - before.minX) / 2, before.minY + (before.maxY - before.minY) / 2],
		]);
		const after = boxOf(['one', 'two']);
		expect(after.maxX - after.minX).toBeLessThan((before.maxX - before.minX) * 0.7);
	});

	it('never scales a selection off the page', () => {
		selectBoth();
		const before = boxOf(['one', 'two']);
		const handle = selectionHandles(before, 1).se;
		surface.drawStroke([
			[handle.x, handle.y],
			[5000, 5000],
		]);
		const after = boxOf(['one', 'two']);
		expect(after.maxX).toBeLessThanOrEqual(800 + 1e-6);
		expect(after.maxY).toBeLessThanOrEqual(450 + 1e-6);
	});

	it('undoes a scale in one step', () => {
		selectBoth();
		const before = boxOf(['one', 'two']);
		const handle = selectionHandles(before, 1).se;
		surface.drawStroke([
			[handle.x, handle.y],
			[handle.x + 60, handle.y + 60],
		]);
		surface.controller.undo();
		expect(boxOf(['one', 'two'])).toEqual(before);
	});

	it('draws a loop begun on top of ink, rather than dragging that ink away', () => {
		// Starts right on stroke 'one'.
		loop([
			[110, 110],
			[230, 90],
			[230, 170],
			[90, 170],
			[95, 105],
		]);
		const one = surface.annotations().find((a) => a.id === 'one');
		expect(one?.kind === 'stroke' && one.points[0]).toEqual({ x: 110, y: 110 });
		expect(surface.controller.hasSelection()).toBe(true);
	});

	it('picks out the one drawing under a tap', () => {
		surface.pointer('pointerdown', 130, 140, { pointerType: 'pen' });
		surface.pointer('pointerup', 130, 140, { pointerType: 'pen' });
		expect(surface.controller.hasSelection()).toBe(true);
		surface.pointer('pointerdown', 400, 400, { pointerType: 'pen' });
		surface.pointer('pointerup', 400, 400, { pointerType: 'pen' });
		expect(surface.controller.hasSelection()).toBe(false);
	});

	it('keeps the ring and frame with the selection while it is dragged, not where it started', () => {
		selectBoth();
		const overlay = surface.host.querySelectorAll('canvas')[1] as unknown as { __ctx?: { calls: Array<{ op: string; args: unknown[] }> } };
		const handleXs = () =>
			(overlay.__ctx?.calls ?? []).filter((call) => call.op === 'arc').map((call) => call.args[0] as number);
		surface.pointer('pointerdown', 160, 125, { pointerType: 'pen' });
		const at = handleXs().length;
		surface.pointer('pointermove', 260, 125, { pointerType: 'pen' });
		// The frame's handles were drawn again mid-drag, 100 further right.
		const drawnDuringDrag = handleXs().slice(at);
		expect(drawnDuringDrag.length).toBeGreaterThan(0);
		expect(Math.max(...drawnDuringDrag)).toBeGreaterThan(Math.max(...handleXs().slice(0, at)) + 99);
		surface.pointer('pointercancel', 260, 125, { pointerType: 'pen' });
	});

	it('lets go of the selection once it is put down', () => {
		selectBoth();
		surface.drawStroke([
			[160, 125],
			[260, 225],
		]);
		expect(surface.controller.hasSelection()).toBe(false);
	});

	it('keeps it selected after a resize, to size it again or move it', () => {
		selectBoth();
		const handle = selectionHandles(boxOf(['one', 'two']), 1).se;
		surface.drawStroke([
			[handle.x, handle.y],
			[handle.x + 40, handle.y + 40],
		]);
		expect(surface.controller.hasSelection()).toBe(true);
	});

	it('draws the loop dashed while it is being drawn', () => {
		surface.pointer('pointerdown', 90, 90, { pointerType: 'pen' });
		surface.pointer('pointermove', 230, 90, { pointerType: 'pen' });
		surface.pointer('pointermove', 230, 170, { pointerType: 'pen' });
		const overlay = surface.host.querySelectorAll('canvas')[1] as unknown as { __ctx?: { calls: Array<{ op: string; args: unknown[] }> } };
		const dashes = overlay.__ctx?.calls.filter((call) => call.op === 'setLineDash').map((call) => call.args[0] as number[]);
		expect(dashes?.some((dash) => dash.length > 0)).toBe(true);
	});
});
