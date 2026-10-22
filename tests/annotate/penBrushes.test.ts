// @vitest-environment jsdom
import { PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildToolbar } from '../../src/annotate/toolbar';
import { ToolState } from '../../src/annotate/toolState';
import { isOutlined, isSharp, prepareStroke, steadyPoints, strokeCentreline, strokeOutline, strokeRing } from '../../src/annotate/stroke';
import type { PenBrush, Point, StrokeAnnotation } from '../../src/annotate/types';
import { readAnnotations, storedAnnotation } from '../../src/markdown/inkBlockFormat';
import { readInklingAnnotations, writeInklingAnnotations } from '../../src/pdf/annotationSync';
import { pathOps } from '../../src/pdf/contentStream';
import { mountTestSurface, pointsOf } from '../harness/surface';

// Two pens: a round one, smooth and even, and a sharp one that follows the
// hand exactly, corners and all. Each has its own switch for pressure.

function stroke(points: Point[], brush?: PenBrush, width = 6): StrokeAnnotation {
	return { id: 'ink-b', kind: 'stroke', tool: 'pen', color: '#1e1e1e', width, points, ...(brush ? { brush } : {}) };
}

// A hand's tremor: a straight line with a wobble of a unit either side,
// every few samples.
function shaky(count: number): Point[] {
	return Array.from({ length: count }, (_, index) => ({ x: index * 4, y: 100 + Math.sin((index * Math.PI * 2) / 6) }));
}

function wobble(points: Point[]): number {
	let total = 0;
	for (const point of points.slice(1, -1)) total += Math.abs(point.y - 100);
	return total / Math.max(points.length - 2, 1);
}

describe('steadying the hand', () => {
	it('takes the tremor out of a line', () => {
		expect(wobble(steadyPoints(shaky(40), 2))).toBeLessThan(wobble(shaky(40)) * 0.65);
	});

	it('never moves the ends, so the ink stays under the pen tip', () => {
		const raw = shaky(40);
		const steady = steadyPoints(raw, 6);
		expect(steady[0]).toEqual(raw[0]);
		expect(steady.at(-1)).toEqual(raw.at(-1));
	});

	it('steadies the round pen, and leaves the sharp pen exactly where the hand went', () => {
		const raw = shaky(40);
		expect(wobble(prepareStroke(raw, 'pen'))).toBeLessThan(wobble(raw));
		expect(prepareStroke(raw, 'sharp')).toEqual(raw);
	});
});

describe('the round pen', () => {
	const curve = Array.from({ length: 30 }, (_, index) => ({ x: index * 5, y: Math.sin(index / 4) * 20, p: 0.6 }));

	it('is all curves when its width follows pressure', () => {
		const segments = strokeOutline(stroke(curve));
		expect(segments.length).toBeGreaterThan(10);
		expect(segments.slice(1).every((segment) => segment.kind === 'quad')).toBe(true);
	});

	it('has round ends, reaching past the last point', () => {
		const line = [
			{ x: 0, y: 0, p: 1 },
			{ x: 50, y: 0, p: 1 },
			{ x: 100, y: 0, p: 1 },
		];
		const xs = strokeRing(stroke(line, 'pen', 10)).map((point) => point.x);
		expect(Math.max(...xs)).toBeGreaterThan(104);
		expect(Math.min(...xs)).toBeLessThan(-4);
	});

	it('is one even line without pressure', () => {
		const flat = curve.map(({ x, y }) => ({ x, y }));
		expect(isOutlined(stroke(flat))).toBe(false);
		expect(strokeCentreline(stroke(flat)).some((segment) => segment.kind === 'quad')).toBe(true);
	});
});

describe('the sharp pen', () => {
	const zigzag = [
		{ x: 0, y: 0 },
		{ x: 20, y: 20 },
		{ x: 40, y: 0 },
		{ x: 60, y: 20 },
	];

	it('is straight from sample to sample, keeping every corner', () => {
		const line = strokeCentreline(stroke(zigzag, 'sharp'));
		expect(line.slice(1).every((segment) => segment.kind === 'line')).toBe(true);
		expect(line.map((segment) => segment.to)).toEqual(zigzag);
	});

	it('is straight-edged with pressure too, and ends square', () => {
		const pressed = zigzag.map((point) => ({ ...point, p: 0.8 }));
		const outline = strokeOutline(stroke(pressed, 'sharp', 10));
		expect(outline.slice(1).every((segment) => segment.kind === 'line')).toBe(true);
		// Square ends stop at the first and last point, where round ones
		// would reach past them.
		const xs = outline.map((segment) => segment.to.x);
		expect(Math.min(...xs)).toBeGreaterThan(-5);
	});

	it('is told apart from the round pen, and a highlighter is never sharp', () => {
		expect(isSharp(stroke(zigzag, 'sharp'))).toBe(true);
		expect(isSharp(stroke(zigzag))).toBe(false);
		expect(isSharp({ ...stroke(zigzag, 'sharp'), tool: 'highlighter' })).toBe(false);
	});
});

describe('curves in the saved file', () => {
	it('are the same curve the screen draws, not a flatter one with a corner at every sample', () => {
		const ops = pathOps([
			{ kind: 'move', to: { x: 0, y: 0 } },
			{ kind: 'quad', control: { x: 30, y: 30 }, to: { x: 60, y: 0 } },
		]);
		// The quadratic's control two thirds of the way from each end.
		expect(ops.split('\n')[1]).toBe('20.00 20.00 40.00 20.00 60.00 0.00 c');
	});
});

describe('each pen keeps its own settings', () => {
	it('remembers colour, width and the pressure switch per pen, and picking a pen picks it up', () => {
		const state = new ToolState();
		state.setTool('eraser');
		state.setBrush('sharp');
		expect(state.getTool()).toBe('pen');
		state.setWidth(8);
		state.setColor('#1971c2');
		state.setPressure('sharp', false);
		state.setBrush('pen');
		state.setWidth(2);
		state.setPressure('pen', true);
		state.setBrush('sharp');
		expect(state.getWidth()).toBe(8);
		expect(state.getColor()).toBe('#1971c2');
		expect(state.getPressure()).toBe(false);
		expect(state.getPressure('pen')).toBe(true);
	});

	it('starts the round pen even and the sharp pen pressure-sensitive', () => {
		const state = new ToolState();
		expect(state.getPressure('pen')).toBe(false);
		expect(state.getPressure('sharp')).toBe(true);
	});

	it('comes back after a restart, pen and switches and all', () => {
		const used = new ToolState();
		used.setBrush('sharp');
		used.setWidth(5);
		used.setPressure('pen', true);
		const fresh = new ToolState();
		fresh.restore(JSON.parse(JSON.stringify(used.snapshot())));
		expect(fresh.getBrush()).toBe('sharp');
		expect(fresh.getWidth()).toBe(5);
		expect(fresh.getPressure('pen')).toBe(true);
	});
});

describe('a pen in a file', () => {
	async function roundTrip(written: StrokeAnnotation): Promise<{ read: StrokeAnnotation | undefined; extras: PDFDict | undefined }> {
		const doc = await PDFDocument.create();
		doc.addPage([612, 792]);
		writeInklingAnnotations(doc, 0, [written]);
		const loaded = await PDFDocument.load(await doc.save(), { updateMetadata: false });
		const [read] = readInklingAnnotations(loaded, 0);
		const first = loaded.getPage(0).node.Annots()?.asArray()[0];
		const dict = first instanceof PDFRef ? loaded.context.lookupMaybe(first, PDFDict) : undefined;
		return { read: read?.kind === 'stroke' ? read : undefined, extras: dict?.lookupMaybe(PDFName.of('Inkling'), PDFDict) };
	}
	const line = [
		{ x: 10, y: 10 },
		{ x: 60, y: 40 },
		{ x: 110, y: 10 },
	];

	it('comes back out of a PDF', async () => {
		const { read } = await roundTrip(stroke(line, 'sharp'));
		expect(read?.brush).toBe('sharp');
		expect(read?.tool).toBe('pen');
	});

	it('writes nothing extra for the round pen', async () => {
		const { read, extras } = await roundTrip(stroke(line));
		expect(read?.brush).toBeUndefined();
		expect(extras).toBeUndefined();
	});

	it('comes back out of a note’s ink block, and one this build does not know draws as the round pen', () => {
		const stored = [storedAnnotation(stroke(line, 'sharp')), { ...storedAnnotation(stroke(line)), id: 'ink-c', brush: 'calligraphy' }];
		const { annotations } = readAnnotations(JSON.parse(JSON.stringify(stored)));
		expect(annotations.map((annotation) => (annotation.kind === 'stroke' ? annotation.brush : null))).toEqual(['sharp', undefined]);
	});
});

describe('drawing with a pen', () => {
	const pressed = (surface: ReturnType<typeof mountTestSurface>) => {
		surface.drawStroke(
			[
				[100, 100],
				[140, 130],
				[190, 120],
				[240, 160],
			],
			{ pressure: 0.7 },
		);
		const [committed] = surface.annotations();
		return committed;
	};

	it('keeps the stylus pressure when the pen’s switch is on', () => {
		const surface = mountTestSurface(800, 450);
		surface.controller.setBrush('sharp');
		surface.controller.setPressure('sharp', true);
		const committed = pressed(surface);
		expect(committed?.kind === 'stroke' && committed.brush).toBe('sharp');
		expect(pointsOf(committed).every((point) => point.p !== undefined)).toBe(true);
	});

	it('drops it when the switch is off, for one width however hard the pen presses', () => {
		const surface = mountTestSurface(800, 450);
		surface.controller.setBrush('pen');
		surface.controller.setPressure('pen', false);
		const committed = pressed(surface);
		expect(pointsOf(committed).some((point) => point.p !== undefined)).toBe(false);
		// And ends exactly where the pen lifted.
		expect(pointsOf(committed).at(-1)).toMatchObject({ x: 240, y: 160 });
	});
});

describe('the pen picker', () => {
	let host: HTMLElement;
	let surface: ReturnType<typeof mountTestSurface>;
	beforeEach(() => {
		document.body.innerHTML = '';
		surface = mountTestSurface(800, 450);
		host = document.body.appendChild(document.createElement('div'));
		buildToolbar(host, surface.controller);
	});
	const penButton = () => host.querySelector<HTMLButtonElement>('.inkling-tool-button[aria-haspopup="dialog"]');
	const picker = () => document.querySelector('.inkling-pen-picker');
	const rows = () => Array.from(picker()?.querySelectorAll<HTMLElement>('.inkling-pen-option') ?? []);

	it('picks the pen up on the first press, and opens on a press of the pen in hand', () => {
		surface.controller.setTool('eraser');
		penButton()?.click();
		expect(surface.controller.getTool()).toBe('pen');
		expect(picker()).toBeNull();

		penButton()?.click();
		expect(picker()).not.toBeNull();
		expect(penButton()?.getAttribute('aria-expanded')).toBe('true');
		expect(rows()).toHaveLength(2);
	});

	it('changes the pen, closes, and shows the pen on its button', () => {
		penButton()?.click();
		const sharp = rows().find((row) => row.textContent?.includes('Sharp pen'));
		sharp?.querySelector<HTMLButtonElement>('.inkling-pen-option-choose')?.click();
		expect(surface.controller.getBrush()).toBe('sharp');
		expect(picker()).toBeNull();
		expect(penButton()?.getAttribute('aria-label')).toContain('Sharp pen');
	});

	it('switches a pen’s pressure without closing', () => {
		penButton()?.click();
		const round = rows().find((row) => row.textContent?.includes('Round pen'));
		const toggle = round?.querySelector<HTMLButtonElement>('.inkling-pen-pressure');
		expect(toggle?.getAttribute('aria-checked')).toBe('false');
		toggle?.click();
		expect(surface.controller.getPressure('pen')).toBe(true);
		expect(toggle?.getAttribute('aria-checked')).toBe('true');
		expect(picker()).not.toBeNull();
	});

	it('closes on a press anywhere else, and on Escape', () => {
		penButton()?.click();
		document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		expect(picker()).toBeNull();

		penButton()?.click();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(picker()).toBeNull();
	});
});
