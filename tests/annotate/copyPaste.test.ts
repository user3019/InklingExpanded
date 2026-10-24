// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetCopied } from '../../src/annotate/controller';
import { boundingBox, unionBoundingBox } from '../../src/annotate/geometry';
import { pasteButtonCentre, pictureButtonCentres, selectionButtonCentres } from '../../src/annotate/render';
import type { Annotation, ImageAnnotation, StrokeAnnotation } from '../../src/annotate/types';
import { mountTestSurface, type TestSurface } from '../harness/surface';

// Writing picked out with the lasso, copied, and pasted somewhere else — on
// the same page, another page, or a page shown at another size.

function line(id: string, y: number, width = 3): StrokeAnnotation {
	return { id, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width, points: [{ x: 100, y }, { x: 300, y }] };
}

let surface: TestSurface;

const tap = (at: { x: number; y: number }, on = surface, pointerType = 'pen') => {
	on.pointer('pointerdown', at.x, at.y, { pointerType });
	on.pointer('pointerup', at.x, at.y, { pointerType });
};
// The lasso held still where it came down.
const hold = (at: { x: number; y: number }, on = surface) => {
	on.pointer('pointerdown', at.x, at.y, { pointerType: 'pen' });
	vi.advanceTimersByTime(600);
	on.pointer('pointerup', at.x, at.y, { pointerType: 'pen' });
};
const selected = (on = surface) => {
	const ids = (on.controller as unknown as { selection: { ids: Set<string> } }).selection.ids;
	return on.annotations().filter((a) => ids.has(a.id));
};
const centreOf = (annotation: Annotation) => {
	const box = boundingBox(annotation);
	return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
};
// Picks out the line at y = 100 and presses copy on the selection's bar.
const copyLine = (on = surface) => {
	tap({ x: 200, y: 100 }, on);
	const chosen = selected(on);
	const box = unionBoundingBox(chosen.map(boundingBox));
	const copy = selectionButtonCentres(box, 1, chosen).copy;
	if (!copy) throw new Error('no copy button');
	tap(copy, on);
};

beforeEach(() => {
	document.body.innerHTML = '';
	forgetCopied();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	surface = mountTestSurface(800, 450);
	surface.controller.seedPage(1, [line('ink-a', 100)]);
	surface.controller.setTool('select');
});

afterEach(() => {
	vi.useRealTimers();
});

describe('copying and pasting writing', () => {
	it('pastes a copy where the lasso is held, selected, and in one step of undo', () => {
		copyLine();
		expect(surface.controller.hasCopied()).toBe(true);
		expect(surface.annotations()).toHaveLength(1);

		hold({ x: 500, y: 300 });
		// Held still: a paste offered there, not a loop drawn.
		expect(surface.annotations()).toHaveLength(1);
		tap(pasteButtonCentre({ x: 500, y: 300 }, 1));

		const all = surface.annotations();
		expect(all).toHaveLength(2);
		const pasted = all.find((a) => a.id !== 'ink-a');
		expect(pasted?.id).toBeTruthy();
		expect(centreOf(pasted as Annotation)).toEqual({ x: 500, y: 300 });
		expect(selected().map((a) => a.id)).toEqual([pasted?.id]);

		surface.controller.undo();
		expect(surface.annotations().map((a) => a.id)).toEqual(['ink-a']);
	});

	it('pastes as often as asked, each a copy of its own', () => {
		copyLine();
		hold({ x: 500, y: 200 });
		tap(pasteButtonCentre({ x: 500, y: 200 }, 1));
		hold({ x: 500, y: 350 });
		tap(pasteButtonCentre({ x: 500, y: 350 }, 1));
		expect(new Set(surface.annotations().map((a) => a.id)).size).toBe(3);
	});

	it('cuts: the writing goes, and comes back where it is pasted', () => {
		tap({ x: 200, y: 100 });
		expect(surface.controller.cutSelection()).toBe(true);
		expect(surface.annotations()).toHaveLength(0);
		expect(surface.controller.pasteAt(1, { x: 400, y: 300 })).toBe(true);
		expect(surface.annotations()).toHaveLength(1);
	});

	it('keeps a paste on the page when asked for at its edge', () => {
		copyLine();
		surface.controller.pasteAt(1, { x: 790, y: 440 });
		const pasted = surface.annotations().find((a) => a.id !== 'ink-a') as Annotation;
		const box = boundingBox(pasted);
		expect(box.maxX).toBeLessThanOrEqual(800);
		expect(box.maxY).toBeLessThanOrEqual(450);
	});

	it('lands the same size on a page shown at another size', () => {
		const small = mountTestSurface(800, 450, { getUnitScale: () => 1 });
		small.controller.seedPage(1, [line('ink-a', 100, 3)]);
		small.controller.setTool('select');
		copyLine(small);

		const large = mountTestSurface(800, 450, { getUnitScale: () => 2 });
		large.controller.pasteAt(1, { x: 400, y: 200 });
		const [pasted] = large.annotations() as StrokeAnnotation[];
		expect(pasted?.width).toBe(6);
		const box = boundingBox(pasted as Annotation);
		expect(box.maxX - box.minX).toBe(400);
	});

	it('copies a locked picture as one that can be moved', () => {
		const picture: ImageAnnotation = {
			id: 'ink-photo',
			kind: 'image',
			color: '#000000',
			width: 1,
			start: { x: 400, y: 200 },
			end: { x: 600, y: 300 },
			picture: { format: 'rgba', width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) },
			locked: true,
		};
		surface.controller.seedPage(1, [picture]);
		surface.controller.pickUpPictureAt(1, { x: 500, y: 250 });
		tap(pictureButtonCentres({ minX: 400, minY: 200, maxX: 600, maxY: 300 }, 1).copy);
		surface.controller.pasteAt(1, { x: 200, y: 300 });
		const pasted = surface.annotations().find((a) => a.id !== 'ink-photo') as ImageAnnotation;
		expect(pasted.kind).toBe('image');
		expect(pasted.locked).toBe(false);
	});

	it('takes the paste with a finger, as a long press offers it', () => {
		copyLine();
		expect(surface.controller.offerPasteAt(1, { x: 500, y: 300 })).toBe(true);
		tap(pasteButtonCentre({ x: 500, y: 300 }, 1), surface, 'touch');
		expect(surface.annotations()).toHaveLength(2);
	});

	it('lets the offer go with Escape, or with a press anywhere else', () => {
		copyLine();
		surface.controller.offerPasteAt(1, { x: 500, y: 300 });
		expect(surface.controller.clearSelection()).toBe(true);
		tap(pasteButtonCentre({ x: 500, y: 300 }, 1));
		expect(surface.annotations()).toHaveLength(1);

		surface.controller.offerPasteAt(1, { x: 500, y: 300 });
		tap({ x: 700, y: 50 });
		tap(pasteButtonCentre({ x: 500, y: 300 }, 1));
		expect(surface.annotations()).toHaveLength(1);
	});

	it('offers nothing to paste before anything was copied', () => {
		expect(surface.controller.offerPasteAt(1, { x: 500, y: 300 })).toBe(false);
	});
});
