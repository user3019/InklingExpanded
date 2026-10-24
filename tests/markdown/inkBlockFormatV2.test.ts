import { describe, expect, it } from 'vitest';
import {
	INK_BLOCK_VERSION,
	parseInkBlock,
	serializeInkBlock,
} from '../../src/markdown/inkBlockFormat';
import type { InkBlockData } from '../../src/markdown/inkBlockFormat';
import type { Annotation } from '../../src/annotate/types';

// Format 2 stores stroke coordinates as one flat array of numbers rather
// than a list of {x, y, p} objects, with pressure — when the stroke has any
// — in a parallel array beside it.
//
// The shape is deliberately the one the PDF side already uses: /InkList is
// flat coordinates and the private /InklingExpanded /P is a parallel byte array of
// pressure. The two halves of this plugin had no reason to store the same
// drawing in two different shapes.
//
// Reading accepts both formats; writing always produces 2, so a block is
// upgraded the first time it is saved.

function block(annotations: Annotation[]): InkBlockData {
	return { version: INK_BLOCK_VERSION, width: 800, height: 450, annotations };
}

// The block as it sits in the note, rather than as the parser hands it back
// — these tests are about the bytes, so they read the JSON directly. Typed
// on the way through, since JSON.parse alone yields `any` and an unchecked
// property access in a test is how a test comes to assert nothing at all.
interface StoredBlock {
	version: number;
	width: number;
	height: number;
	annotations: Record<string, unknown>[];
}

function stored(json: string): StoredBlock {
	return JSON.parse(json) as StoredBlock;
}

function firstStored(json: string): Record<string, unknown> {
	const first = stored(json).annotations[0];
	if (!first) throw new Error('the serialized block holds no annotations');
	return first;
}

const STROKE: Annotation = {
	id: 'ink-s',
	kind: 'stroke',
	tool: 'pen',
	color: '#1e1e1e',
	width: 3,
	points: [
		{ x: 1.5, y: 2.5, p: 0.4 },
		{ x: 3.5, y: 4.5, p: 0.6 },
	],
};

describe('the stored format version', () => {
	it('is 2', () => {
		expect(INK_BLOCK_VERSION).toBe(2);
	});

	it('is what a serialized block declares', () => {
		expect(stored(serializeInkBlock(block([]))).version).toBe(2);
	});
});

describe('writing format 2', () => {
	it('writes stroke coordinates as one flat array', () => {
		const written = firstStored(serializeInkBlock(block([STROKE])));

		expect(written.points).toEqual([1.5, 2.5, 3.5, 4.5]);
	});

	it('writes pressure in a parallel array, one entry per point', () => {
		const written = firstStored(serializeInkBlock(block([STROKE])));

		expect(written.pressure).toEqual([0.4, 0.6]);
	});

	it('omits pressure entirely for a stroke that has none', () => {
		const flat: Annotation = { ...STROKE, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] };
		const written = firstStored(serializeInkBlock(block([flat])));

		expect(written).not.toHaveProperty('pressure');
	});

	// Mixed strokes are not a theoretical case: real notes in daily use hold
	// pen strokes with pressure on some samples and not others. Writing the
	// gap as null keeps the two arrays the same length and keeps the taper
	// on the samples that have one.
	it('marks a point with no pressure as a gap rather than dropping the lot', () => {
		const mixed: Annotation = { ...STROKE, points: [{ x: 1, y: 2, p: 0.5 }, { x: 3, y: 4 }] };
		const written = firstStored(serializeInkBlock(block([mixed])));

		expect(written.pressure).toEqual([0.5, null]);
	});

	it('round-trips a stroke with pressure on only some points', () => {
		const mixed: Annotation = { ...STROKE, points: [{ x: 1, y: 2, p: 0.5 }, { x: 3, y: 4 }] };
		const { data } = parseInkBlock(serializeInkBlock(block([mixed])));

		expect(data.annotations[0]).toEqual(mixed);
	});

	// A gap is not a pressure of zero, and the two must not collapse into
	// each other: zero pressure is a stylus barely touching the page, and a
	// stroke that tapers to nothing reads differently from one that never
	// reported pressure at all.
	it('keeps a pressure of zero distinct from a missing one', () => {
		const zero: Annotation = { ...STROKE, points: [{ x: 1, y: 2, p: 0 }, { x: 3, y: 4 }] };
		const written = firstStored(serializeInkBlock(block([zero])));
		expect(written.pressure).toEqual([0, null]);

		const { data } = parseInkBlock(serializeInkBlock(block([zero])));
		expect(data.annotations[0]).toEqual(zero);
	});

	it('writes a shape as two flat pairs', () => {
		const shape: Annotation = {
			id: 'ink-r', kind: 'shape', tool: 'rectangle', color: '#e03131', width: 2,
			start: { x: 10, y: 20 }, end: { x: 30, y: 40 },
		};
		const written = firstStored(serializeInkBlock(block([shape])));

		expect(written.start).toEqual([10, 20]);
		expect(written.end).toEqual([30, 40]);
	});

	// Measured against a format 1 baseline rounded exactly as the writer
	// rounds, so what this compares is the shape of the format and not the
	// coordinate precision that was already dealt with.
	it('is smaller than the same drawing was in format 1', () => {
		const points = Array.from({ length: 200 }, (_, i) => ({
			x: +(i * 1.1).toFixed(1),
			y: +(i * 2.2).toFixed(1),
			p: 0.5,
		}));
		const long: Annotation = { ...STROKE, points };

		const v2 = serializeInkBlock(block([long])).length;
		const v1 = JSON.stringify({
			version: 1, width: 800, height: 450,
			annotations: [{ ...long, points }],
		}).length;

		expect(v2).toBeLessThan(v1 / 1.8);
	});
});

describe('reading format 2', () => {
	it('round-trips a stroke with pressure', () => {
		const { data, malformed } = parseInkBlock(serializeInkBlock(block([STROKE])));

		expect(malformed).toBe(false);
		expect(data.annotations[0]).toEqual(STROKE);
	});

	it('round-trips a stroke without pressure', () => {
		const flat: Annotation = { ...STROKE, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] };
		const { data } = parseInkBlock(serializeInkBlock(block([flat])));

		expect(data.annotations[0]).toEqual(flat);
	});

	// Found against real notes, not reasoned about: the pointer samples that
	// place a shape's corners carry pressure, and the first cut of this
	// format dropped it on the grounds that the renderer never draws a
	// tapered rectangle. It does not — but the value was in the file, and a
	// format that quietly discards what it was given is not a format anyone
	// should trust with handwriting.
	it('keeps pressure on a shape endpoint, which the renderer never uses', () => {
		const shape: Annotation = {
			id: 'ink-l', kind: 'shape', tool: 'line', color: '#1e1e1e', width: 1.6,
			start: { x: 36.7, y: 110.2, p: 0.2 }, end: { x: 183.2, y: 110.1 },
		};
		const { data } = parseInkBlock(serializeInkBlock(block([shape])));

		expect(data.annotations[0]).toEqual(shape);
	});

	it('round-trips a shape', () => {
		const shape: Annotation = {
			id: 'ink-r', kind: 'shape', tool: 'oval', color: '#2f9e44', width: 5,
			start: { x: 10, y: 20 }, end: { x: 30, y: 40 },
		};
		const { data } = parseInkBlock(serializeInkBlock(block([shape])));

		expect(data.annotations[0]).toEqual(shape);
	});

	it('drops a stroke whose coordinate array has an odd length', () => {
		const source = JSON.stringify({
			version: 2, width: 800, height: 450,
			annotations: [{ ...STROKE, points: [1, 2, 3], pressure: undefined }],
		});
		const { data, malformed } = parseInkBlock(source);

		expect(data.annotations).toHaveLength(0);
		expect(malformed).toBe(true);
	});

	it('drops a stroke whose pressure array does not match its points', () => {
		const source = JSON.stringify({
			version: 2, width: 800, height: 450,
			annotations: [{ ...STROKE, points: [1, 2, 3, 4], pressure: [0.5] }],
		});
		const { data, malformed } = parseInkBlock(source);

		expect(data.annotations).toHaveLength(0);
		expect(malformed).toBe(true);
	});

	it('drops a stroke holding a coordinate that is not a number', () => {
		const source = JSON.stringify({
			version: 2, width: 800, height: 450,
			annotations: [{ ...STROKE, points: [1, 2, 'x', 4] }],
		});

		expect(parseInkBlock(source).data.annotations).toHaveLength(0);
	});
});

describe('reading format 1', () => {
	// The whole point of having had a version from the first release.
	const v1 = JSON.stringify({
		version: 1,
		id: 'ink-old',
		width: 800,
		height: 450,
		annotations: [
			{
				id: 'ink-s', kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 3,
				points: [{ x: 1.5, y: 2.5, p: 0.4 }, { x: 3.5, y: 4.5, p: 0.6 }],
			},
			{
				id: 'ink-r', kind: 'shape', tool: 'line', color: '#e03131', width: 2,
				start: { x: 10, y: 20 }, end: { x: 30, y: 40 },
			},
		],
	});

	it('reads an old block without complaint', () => {
		const { data, malformed } = parseInkBlock(v1);

		expect(malformed).toBe(false);
		expect(data.annotations).toHaveLength(2);
	});

	it('keeps its pressure', () => {
		const stroke = parseInkBlock(v1).data.annotations[0];

		expect(stroke?.kind === 'stroke' && stroke.points[0]?.p).toBe(0.4);
	});

	it('keeps its id', () => {
		expect(parseInkBlock(v1).data.id).toBe('ink-old');
	});

	it('upgrades to format 2 the first time it is written', () => {
		const source = serializeInkBlock(parseInkBlock(v1).data);

		expect(stored(source).version).toBe(2);
		expect(firstStored(source).points).toEqual([1.5, 2.5, 3.5, 4.5]);
	});

	it('survives the upgrade unchanged in every value that matters', () => {
		const original = parseInkBlock(v1).data;
		const upgraded = parseInkBlock(serializeInkBlock(original)).data;

		expect(upgraded.annotations).toEqual(original.annotations);
	});
});

describe('a block written by a newer build', () => {
	// Unchanged behaviour, restated at the new version because it is the
	// thing that stops an old build destroying a new block: refuse to save
	// over what this build cannot claim to fully understand.
	it('is flagged malformed rather than partially read', () => {
		const source = JSON.stringify({ version: 3, width: 800, height: 450, annotations: [] });

		expect(parseInkBlock(source).malformed).toBe(true);
	});
});
