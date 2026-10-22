// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseInkBlock } from '../../src/markdown/inkBlockFormat';
import { mountNote, type TestNote } from '../harness/note';

// Zooming into an ink block. Two things used to go wrong: the zoom was a
// stretch of the block's canvas, so ink zoomed into broke up into pixels;
// and the zoom lived on an element every save throws away, so the block
// sprang back to its full view a second after each pause.

let note: TestNote;
// A block's zoom and undo outlive the block itself, by design, keyed by its
// id — so every test draws in a block of its own.
let blockCount = 0;

beforeEach(() => {
	document.body.innerHTML = '';
	note = mountNote({ blocks: [{ id: `ink-zoom-${++blockCount}` }], openInEditor: true });
	note.block(0).openForEditing();
});

afterEach(() => {
	vi.useRealTimers();
});

// A Ctrl+wheel (which is also how Chromium delivers a trackpad pinch) on
// the block, by exactly `factor`, then the pause that settles it.
async function zoomBy(factor: number): Promise<void> {
	const overlay = note.block(0).el.querySelectorAll('canvas')[1];
	const deltaY = -Math.log(factor) / 0.002;
	overlay?.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), { ctrlKey: true, metaKey: false, deltaY, clientX: 0, clientY: 0 }));
	await note.advance(250);
}

function surfaceCanvas(): HTMLCanvasElement | undefined {
	return note.block(0).el.querySelector<HTMLCanvasElement>('canvas.inkling-annotation-base') ?? undefined;
}

function zoomTransform(): string {
	return note.block(0).el.querySelector<HTMLElement>('.inkling-ink-block-content')?.style.transform ?? '';
}

describe('an ink block zoomed into', () => {
	it('backs its canvas denser, so the ink stays sharp', async () => {
		const before = surfaceCanvas()?.width ?? 0;
		await zoomBy(2);
		expect(surfaceCanvas()?.width).toBeCloseTo(before * 2, 5);
	});

	it('goes back to its ordinary backing once zoomed out again', async () => {
		const before = surfaceCanvas()?.width ?? 0;
		await zoomBy(3);
		await zoomBy(1 / 3);
		expect(surfaceCanvas()?.width).toBeCloseTo(before, 5);
	});

	it('saves what was drawn zoomed at the size it was drawn, pen width included', async () => {
		await zoomBy(2);
		note.block(0).drawStroke([
			[100, 100],
			[300, 200],
		]);
		await note.flushWrites();

		const [saved] = parseInkBlock(note.fenceBody(0)).data.annotations;
		expect(saved?.kind).toBe('stroke');
		if (saved?.kind !== 'stroke') return;
		// The harness lays the canvas out at the block's stored size, so a
		// client point is a stored point.
		expect(saved.points[0]?.x).toBeCloseTo(100, 3);
		expect(saved.points[0]?.y).toBeCloseTo(100, 3);
		// The pen's own width: zoom made it neither thinner nor thicker.
		expect(saved.width).toBeCloseTo(3, 3);
	});

	it('is still zoomed, and still sharp, after the save that rebuilds it', async () => {
		await zoomBy(2);
		const zoomed = zoomTransform();
		const width = surfaceCanvas()?.width;
		note.block(0).drawStroke([
			[100, 100],
			[150, 120],
		]);
		await note.flushWrites();

		note.rerender();

		expect(zoomTransform()).toBe(zoomed);
		expect(zoomTransform()).toContain('scale(2');
		expect(surfaceCanvas()?.width).toBe(width);
	});

	it('keeps undo working across a zoom', async () => {
		note.block(0).drawStroke([
			[100, 100],
			[150, 120],
		]);
		await zoomBy(2);
		await note.flushWrites();
		expect(note.strokeCountIn(0)).toBe(1);

		const undo = note.block(0).el.querySelector<HTMLButtonElement>('button[aria-label="Undo"]');
		expect(undo).not.toBeNull();
		undo?.click();
		await note.flushWrites();
		expect(note.strokeCountIn(0)).toBe(0);
	});
});
