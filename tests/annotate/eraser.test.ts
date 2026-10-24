import { describe, expect, it } from 'vitest';
import { eraseAt } from '../../src/annotate/eraser';
import type { Annotation, Point, StrokeAnnotation } from '../../src/annotate/types';

function stroke(points: Point[]): StrokeAnnotation {
	return { id: 'ink-test', kind: 'stroke', tool: 'pen', color: '#000000', width: 3, points };
}

describe('eraseAt', () => {
	it('leaves a stroke the eraser never reached', () => {
		const result = eraseAt([stroke([{ x: 0, y: 0 }, { x: 10, y: 0 }])], { x: 500, y: 500 }, 10);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
	});

	it('erases at a sparse segment midpoint, far from any stored point', () => {
		// The bug this pins down: a fast stroke can have sample points spaced
		// much wider than the eraser radius. Checking only the stored points
		// meant erasing exactly between two of them silently did nothing,
		// which was reported as "erase only works on this session's strokes"
		// — a freshly drawn stroke is densely sampled right where you erase,
		// a reloaded one is not.
		const sparse = stroke([{ x: 0, y: 0 }, { x: 400, y: 0 }]);
		expect(eraseAt([sparse], { x: 200, y: 0 }, 10)).toHaveLength(0);
	});

	it('splits a stroke erased in its middle into two strokes', () => {
		const long = stroke([
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 20, y: 0 },
			{ x: 100, y: 0 },
			{ x: 180, y: 0 },
			{ x: 190, y: 0 },
			{ x: 200, y: 0 },
		]);
		const result = eraseAt([long], { x: 100, y: 0 }, 5);
		expect(result).toHaveLength(2);
		expect(result[0]?.id).not.toBe(result[1]?.id);
	});

	it('drops fragments too short to be a line', () => {
		// A one-point remnant is not a drawable stroke, so it is discarded
		// rather than kept as an invisible annotation.
		const result = eraseAt([stroke([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 100, y: 0 }])], { x: 10, y: 0 }, 15);
		for (const annotation of result) {
			if (annotation.kind === 'stroke') expect(annotation.points.length).toBeGreaterThanOrEqual(2);
		}
	});

	it('deletes a whole shape on contact, having no interior points to trim', () => {
		const shape: Annotation = {
			id: 'ink-s',
			kind: 'shape',
			tool: 'rectangle',
			color: '#000000',
			width: 2,
			start: { x: 0, y: 0 },
			end: { x: 50, y: 50 },
		};
		expect(eraseAt([shape], { x: 25, y: 25 }, 5)).toHaveLength(0);
	});

	it('leaves other annotations on the page untouched', () => {
		const kept = stroke([{ x: 900, y: 900 }, { x: 950, y: 900 }]);
		const hit = stroke([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
		const result = eraseAt([kept, hit], { x: 5, y: 0 }, 30);
		expect(result).toHaveLength(1);
		expect(result[0]?.id).toBe('ink-test');
		expect(result[0]).toMatchObject({ points: [{ x: 900, y: 900 }, { x: 950, y: 900 }] });
	});
});

describe('what a stroke erased is called', () => {
	const line = () =>
		stroke([
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 20, y: 0 },
			{ x: 30, y: 0 },
			{ x: 40, y: 0 },
		]);

	it('keeps the id of a stroke only shortened at an end, so a merge sees it changed rather than replaced', () => {
		const [shortened, ...more] = eraseAt([line()], { x: 40, y: 0 }, 3);
		expect(more).toHaveLength(0);
		expect(shortened?.id).toBe('ink-test');
		expect(shortened?.kind === 'stroke' && shortened.points.length).toBe(3);
	});

	it('gives the pieces of a stroke cut in two ids of their own', () => {
		const long = stroke(Array.from({ length: 9 }, (_, index) => ({ x: index * 10, y: 0 })));
		const pieces = eraseAt([long], { x: 40, y: 0 }, 3);
		expect(pieces).toHaveLength(2);
		expect(new Set(pieces.map((piece) => piece.id)).size).toBe(2);
		expect(pieces.some((piece) => piece.id === 'ink-test')).toBe(false);
	});
});
