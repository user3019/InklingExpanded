// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachViewNavigation, type ViewZoom } from '../../src/annotate/pointer';
import { ToolState } from '../../src/annotate/toolState';
import type { StrokeAnnotation } from '../../src/annotate/types';
import { makePointerEvent, mountTestSurface, type TestSurface } from '../harness/surface';

// A stylus's own controls — the side button of an S Pen and of most Android,
// Windows and Wacom pens, and the eraser end some have — and drawing with a
// finger for a pen that reports itself as one.

function existing(): StrokeAnnotation {
	return { id: 'old', kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 3, points: [{ x: 100, y: 100 }, { x: 300, y: 100 }] };
}

let surface: TestSurface;
let penButton: 'eraser' | 'highlighter' | 'select' | 'none';

beforeEach(() => {
	document.body.innerHTML = '';
	penButton = 'eraser';
	surface = mountTestSurface(800, 450, { getPenButtonAction: () => penButton });
	surface.controller.seedPage(1, [existing()]);
	surface.controller.setTool('pen');
});

const across = (options: { buttons?: number; button?: number; pointerType?: string } = {}) => {
	surface.pointer('pointerdown', 200, 80, { pointerType: 'pen', ...options });
	surface.pointer('pointermove', 200, 100, { pointerType: 'pen', ...options });
	surface.pointer('pointermove', 200, 120, { pointerType: 'pen', ...options });
	surface.pointer('pointerup', 200, 120, { pointerType: 'pen', ...options, buttons: 0 });
};

describe('the stylus side button', () => {
	it('erases while it is held, and the pen is the pen again after', () => {
		across({ buttons: 3 });
		expect(surface.annotations().find((a) => a.id === 'old')).toBeUndefined();
		expect(surface.controller.getTool()).toBe('pen');
		across();
		expect(surface.annotations()).toHaveLength(1);
	});

	it('highlights, in the highlighter’s own colour, when set to', () => {
		penButton = 'highlighter';
		across({ buttons: 3 });
		const drawn = surface.annotations().find((a) => a.id !== 'old');
		expect(drawn?.kind === 'stroke' && drawn.tool).toBe('highlighter');
		expect(drawn?.color).not.toBe(surface.controller.getColor());
	});

	it('picks up the lasso when set to', () => {
		penButton = 'select';
		across({ buttons: 3 });
		expect(surface.controller.getTool()).toBe('select');
	});

	it('shows the eraser as soon as it is pressed in the air, and erases nothing until the tip touches', () => {
		const air = { pointerType: 'pen', pressure: 0, button: 2, buttons: 2 };
		surface.pointer('pointerdown', 200, 80, air);
		expect(surface.controller.getTool()).toBe('eraser');
		surface.pointer('pointermove', 200, 100, { ...air, button: -1 });
		expect(surface.annotations()).toHaveLength(1);

		// The tip touching, with the button still held, comes as a move.
		surface.pointer('pointermove', 200, 90, { pointerType: 'pen', button: 0, buttons: 3 });
		surface.pointer('pointermove', 200, 110, { pointerType: 'pen', button: -1, buttons: 3 });
		expect(surface.annotations()).toHaveLength(0);

		// Lifted, still held: still the eraser, but erasing nothing more.
		surface.pointer('pointermove', 200, 60, { ...air, button: 0 });
		expect(surface.controller.getTool()).toBe('eraser');
		expect(surface.controller.isGestureActive()).toBe(false);

		surface.pointer('pointerup', 200, 60, { pointerType: 'pen', pressure: 0, button: 2, buttons: 0 });
		expect(surface.controller.getTool()).toBe('pen');
	});

	// What Android's web view sends for an S Pen: the side button as the
	// left button, seen only while the pen hovers — and a touch made with it
	// held never arrives as one: Android makes it a text selection, which a
	// layer laid over the page while the button is held turns back into
	// where the pen is (see selectionCatcher.ts).
	describe('as Android reports it — the left button, on a pen in the air', () => {
		const air = { pointerType: 'pen', pressure: 0, button: 0, buttons: 1 };
		const hover = (y: number) => surface.pointer('pointermove', 200, y, { ...air, button: -1, buttons: 0 });
		const catcher = () => surface.host.querySelector<HTMLElement>('.inkling-selection-catcher');
		// The pen hovering over the layer, as it does while the button is held.
		const overLayer = (type: string, y: number, options: { buttons: number; pressure?: number }) =>
			catcher()?.dispatchEvent(makePointerEvent(type, { pointerType: 'pen', pressure: 0, clientX: 200, clientY: y, button: -1, ...options }));
		// Android selecting from where the pen came down to where it is now,
		// on the layer's grid of 7-pixel cells, 115 to a row.
		const select = (from: { x: number; y: number }, to: { x: number; y: number }) => {
			const text = catcher()?.lastChild;
			if (!text) throw new Error('no layer to select on');
			const offset = (at: { x: number; y: number }) => Math.floor(at.y / 7) * (115 * 2 + 1) + Math.floor(at.x / 7) * 2;
			document.getSelection()?.setBaseAndExtent(text, offset(from), text, offset(to));
			document.dispatchEvent(new Event('selectionchange'));
		};

		it('is the eraser while held, and the tool before once let go', () => {
			surface.controller.setTool('highlighter');
			hover(50);
			surface.pointer('pointerdown', 200, 60, air);
			expect(surface.controller.getTool()).toBe('eraser');
			overLayer('pointermove', 70, { buttons: 1 });
			expect(surface.controller.getTool()).toBe('eraser');
			overLayer('pointermove', 80, { buttons: 0 });
			expect(surface.controller.getTool()).toBe('highlighter');
			expect(catcher()).toBeNull();
		});

		it('erases where the pen goes with the button held, through the selection Android makes', () => {
			surface.pointer('pointerdown', 200, 60, air);
			expect(catcher()).not.toBeNull();
			select({ x: 200, y: 60 }, { x: 200, y: 90 });
			select({ x: 200, y: 60 }, { x: 200, y: 130 });
			// Lifted, and hovering again without the button.
			overLayer('pointermove', 140, { buttons: 0 });
			expect(surface.annotations()).toHaveLength(0);
			expect(surface.controller.getTool()).toBe('pen');
			expect(document.getSelection()?.rangeCount ?? 0).toBe(0);

			// One step of undo brings it back.
			surface.controller.undo();
			expect(surface.annotations()).toHaveLength(1);
		});

		it('draws and erases nothing while only held in the air', () => {
			surface.pointer('pointerdown', 200, 60, air);
			overLayer('pointermove', 100, { buttons: 1 });
			overLayer('pointermove', 120, { buttons: 0 });
			expect(surface.annotations()).toHaveLength(1);
		});

		it('does nothing when set to nothing', () => {
			penButton = 'none';
			surface.pointer('pointerdown', 200, 60, air);
			expect(surface.controller.getTool()).toBe('pen');
			expect(catcher()).toBeNull();
		});
	});

	it('erases from where it is pressed in the middle of a stroke, keeping what was written', () => {
		surface.pointer('pointerdown', 150, 300, { pointerType: 'pen' });
		surface.pointer('pointermove', 180, 250, { pointerType: 'pen' });
		surface.pointer('pointermove', 200, 200, { pointerType: 'pen' });
		surface.pointer('pointermove', 200, 120, { pointerType: 'pen', button: 2, buttons: 3 });
		expect(surface.controller.getTool()).toBe('eraser');
		surface.pointer('pointermove', 200, 100, { pointerType: 'pen', button: -1, buttons: 3 });
		surface.pointer('pointerup', 200, 90, { pointerType: 'pen', button: 0, buttons: 0 });

		const left = surface.annotations();
		expect(left.find((a) => a.id === 'old')).toBeUndefined();
		expect(left).toHaveLength(1);
		expect(left[0]?.kind === 'stroke' && left[0].tool).toBe('pen');
		expect(surface.controller.getTool()).toBe('pen');
	});

	it('keeps what it erased when the system cancels the gesture', () => {
		surface.pointer('pointerdown', 200, 80, { pointerType: 'pen', buttons: 3 });
		surface.pointer('pointermove', 200, 100, { pointerType: 'pen', buttons: 3 });
		surface.pointer('pointercancel', 200, 120, { pointerType: 'pen', buttons: 0 });
		expect(surface.annotations()).toHaveLength(0);
		expect(surface.controller.getTool()).toBe('pen');
	});

	it('does nothing special when set to nothing', () => {
		penButton = 'none';
		across({ buttons: 3 });
		expect(surface.annotations()).toHaveLength(2);
	});
});

describe('the eraser end', () => {
	it('always erases', () => {
		penButton = 'none';
		across({ buttons: 32, button: 5 });
		expect(surface.annotations()).toHaveLength(0);
	});
});

describe('the mouse and the menu', () => {
	it('draws nothing with the right button', () => {
		surface.pointer('pointerdown', 500, 300, { pointerType: 'mouse', button: 2, buttons: 2 });
		surface.pointer('pointermove', 550, 330, { pointerType: 'mouse', button: 2, buttons: 2 });
		surface.pointer('pointerup', 550, 330, { pointerType: 'mouse', button: 2 });
		expect(surface.annotations()).toHaveLength(1);
	});

	it('opens no context menu over the page', () => {
		const overlay = surface.host.querySelectorAll('canvas')[1];
		const menu = new Event('contextmenu', { cancelable: true, bubbles: true });
		overlay?.dispatchEvent(menu);
		expect(menu.defaultPrevented).toBe(true);
	});
});

describe('drawing with a finger', () => {
	const finger = (type: string, id: number, x: number, y: number) =>
		surface.pointer(type, x, y, { pointerType: 'touch', pointerId: id });

	it('scrolls with a finger by default, so a resting hand draws nothing', () => {
		finger('pointerdown', 11, 400, 300);
		finger('pointermove', 11, 450, 320);
		finger('pointerup', 11, 450, 320);
		expect(surface.annotations()).toHaveLength(1);
	});

	it('draws with a finger once switched on', () => {
		surface.controller.setTouchDrawing(true);
		finger('pointerdown', 11, 400, 300);
		finger('pointermove', 11, 450, 320);
		finger('pointerup', 11, 450, 320);
		expect(surface.annotations()).toHaveLength(2);
	});

	it('drops what one finger began to draw when a second makes it a pinch', () => {
		surface.controller.setTouchDrawing(true);
		finger('pointerdown', 11, 400, 300);
		finger('pointermove', 11, 420, 300);
		finger('pointerdown', 12, 500, 300);
		finger('pointermove', 11, 380, 300);
		finger('pointerup', 12, 520, 300);
		finger('pointerup', 11, 380, 300);
		expect(surface.annotations()).toHaveLength(1);
	});

	it('is kept for the device', () => {
		const state = new ToolState();
		state.setTouchDrawing(true);
		const fresh = new ToolState();
		fresh.restore(JSON.parse(JSON.stringify(state.snapshot())));
		expect(fresh.isTouchDrawing()).toBe(true);
	});
});

describe('a whole view, with a finger drawing', () => {
	it('does not scroll under a drawing finger, and still pinches with a second', () => {
		const scroller = document.body.appendChild(document.createElement('div'));
		let top = 1000;
		Object.defineProperty(scroller, 'scrollTop', { get: () => top, set: (value: number) => (top = value) });
		const zoomTo = vi.fn();
		const zoom: ViewZoom = {
			min: 0.25,
			max: 5,
			get: () => 1,
			anchorAt: () => null,
			zoomTo,
			centre: () => ({ x: 0, y: 0 }),
			settle: () => undefined,
		};
		const onPinchStart = vi.fn();
		attachViewNavigation(scroller, zoom, { ignore: () => false, isBusy: () => surface.controller.isGestureActive(), onPinchStart });
		const drawn = mountTestSurface(800, 450, { viewZoom: zoom });
		drawn.controller.setTool('pen');
		drawn.controller.setTouchDrawing(true);
		scroller.appendChild(drawn.host);
		const overlay = drawn.host.querySelectorAll('canvas')[1];
		const finger = (type: string, id: number, x: number, y: number) =>
			overlay?.dispatchEvent(makePointerEvent(type, { pointerType: 'touch', pointerId: id, clientX: x, clientY: y }));

		finger('pointerdown', 21, 100, 100);
		finger('pointermove', 21, 100, 200);
		expect(top).toBe(1000);

		finger('pointerdown', 22, 300, 100);
		expect(onPinchStart).toHaveBeenCalled();
		finger('pointermove', 22, 400, 100);
		expect(zoomTo).toHaveBeenCalled();
		finger('pointerup', 22, 400, 100);
		finger('pointerup', 21, 100, 200);
		expect(drawn.annotations()).toHaveLength(0);
	});
});
