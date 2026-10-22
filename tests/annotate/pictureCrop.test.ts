// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { cropPicture, cropRegion } from '../../src/annotate/pictureCrop';
import { cropButtonCentres, pictureButtonCentres } from '../../src/annotate/render';
import type { ImageAnnotation, PicturePixels } from '../../src/annotate/types';
import { mountTestSurface, type TestSurface } from '../harness/surface';

// Cutting a picture on the page down to part of itself.

// Four pixels across, two down, each its own colour, so which ones were
// kept can be read back.
function pixels(): PicturePixels {
	const data = new Uint8Array(4 * 2 * 4);
	for (let index = 0; index < 8; index++) data.set([index * 10, 0, 0, 255], index * 4);
	return { format: 'rgba', width: 4, height: 2, data };
}

describe('the pixels a crop keeps', () => {
	const shown = { minX: 100, minY: 100, maxX: 300, maxY: 200 };

	it('maps the crop on the page onto the picture’s own pixels', () => {
		expect(cropRegion(pixels(), shown, { minX: 150, minY: 100, maxX: 250, maxY: 200 })).toEqual({ x: 1, y: 0, width: 2, height: 2 });
	});

	it('rounds outwards, and keeps at least one pixel', () => {
		expect(cropRegion(pixels(), shown, { minX: 160, minY: 140, maxX: 170, maxY: 160 })).toEqual({ x: 1, y: 0, width: 1, height: 2 });
		expect(cropRegion(pixels(), shown, { minX: 300, minY: 200, maxX: 300, maxY: 200 })).toEqual({ x: 3, y: 1, width: 1, height: 1 });
	});

	it('cuts raw pixels row by row', async () => {
		const cut = await cropPicture(pixels(), { x: 1, y: 1, width: 2, height: 1 }, document);
		expect(cut.format).toBe('rgba');
		expect([cut.width, cut.height]).toEqual([2, 1]);
		expect([...cut.data]).toEqual([50, 0, 0, 255, 60, 0, 0, 255]);
	});
});

describe('cropping a picture on the page', () => {
	let surface: TestSurface;
	const picture = (): ImageAnnotation => ({
		id: 'ink-photo',
		kind: 'image',
		color: '#000000',
		width: 1,
		start: { x: 200, y: 100 },
		end: { x: 600, y: 300 },
		picture: pixels(),
	});
	const box = { minX: 200, minY: 100, maxX: 600, maxY: 300 };
	const tap = (at: { x: number; y: number }) => {
		surface.pointer('pointerdown', at.x, at.y, { pointerType: 'pen' });
		surface.pointer('pointerup', at.x, at.y, { pointerType: 'pen' });
	};
	const drag = (from: { x: number; y: number }, to: { x: number; y: number }) => {
		surface.pointer('pointerdown', from.x, from.y, { pointerType: 'pen' });
		surface.pointer('pointermove', (from.x + to.x) / 2, (from.y + to.y) / 2, { pointerType: 'pen' });
		surface.pointer('pointermove', to.x, to.y, { pointerType: 'pen' });
		surface.pointer('pointerup', to.x, to.y, { pointerType: 'pen' });
	};
	const shown = () => surface.annotations().find((a) => a.id === 'ink-photo') as ImageAnnotation;
	const settle = () => new Promise((resolve) => window.setTimeout(resolve, 0));

	beforeEach(() => {
		document.body.innerHTML = '';
		surface = mountTestSurface(800, 450);
		surface.controller.seedPage(1, [picture()]);
		surface.controller.pickUpPictureAt(1, { x: 400, y: 200 });
	});

	it('starts from the crop button, and cuts the picture to what was kept', async () => {
		tap(pictureButtonCentres(box, 1).crop);
		expect(surface.controller.isCropping()).toBe(true);

		// The right half cut away, by its edge.
		drag({ x: 600, y: 200 }, { x: 400, y: 200 });
		tap(cropButtonCentres({ ...box, maxX: 400 }, 1).apply);
		await settle();

		expect(surface.controller.isCropping()).toBe(false);
		const cut = shown();
		expect([cut.start, cut.end]).toEqual([{ x: 200, y: 100 }, { x: 400, y: 300 }]);
		expect([cut.picture.width, cut.picture.height]).toEqual([2, 2]);
		expect([...cut.picture.data.subarray(0, 4)]).toEqual([0, 0, 0, 255]);

		// One step of undo brings all of it back.
		surface.controller.undo();
		expect(shown().picture.width).toBe(4);
	});

	it('slides the crop about inside the picture, never past it', async () => {
		tap(pictureButtonCentres(box, 1).crop);
		drag({ x: 200, y: 200 }, { x: 400, y: 200 });
		drag({ x: 300, y: 200 }, { x: 700, y: 200 });
		tap({ x: 50, y: 400 });
		await settle();
		const cut = shown();
		expect([cut.start.x, cut.end.x]).toEqual([400, 600]);
	});

	it('is done with a tap beside it, and cancelled by the cross or Escape', async () => {
		tap(pictureButtonCentres(box, 1).crop);
		drag({ x: 600, y: 200 }, { x: 400, y: 200 });
		tap(cropButtonCentres({ ...box, maxX: 400 }, 1).cancel);
		expect(surface.controller.isCropping()).toBe(false);
		expect(shown().picture.width).toBe(4);

		tap(pictureButtonCentres(box, 1).crop);
		drag({ x: 600, y: 200 }, { x: 400, y: 200 });
		expect(surface.controller.clearSelection()).toBe(true);
		expect(surface.controller.isCropping()).toBe(false);
		expect(shown().picture.width).toBe(4);
	});

	it('does not crop a locked picture', () => {
		tap(pictureButtonCentres(box, 1).lock);
		tap(pictureButtonCentres(box, 1).crop);
		expect(surface.controller.isCropping()).toBe(false);
	});
});
