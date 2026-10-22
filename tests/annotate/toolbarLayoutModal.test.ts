// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultToolbarLayout, type ToolbarLayout } from '../../src/annotate/toolbarLayout';
import { ToolbarLayoutModal } from '../../src/annotate/toolbarLayoutModal';
import { installSurfaceStubs, makePointerEvent } from '../harness/surface';

// The toolbar layout editor: drag a row by its handle to move it. The row
// follows the pointer and the rows it passes slide aside; nothing is
// reordered until the pointer lifts, and nothing reaches the strip until
// Save.

let saved: ToolbarLayout | null;
let modal: ToolbarLayoutModal;

function open(): HTMLElement {
	saved = null;
	modal = new ToolbarLayoutModal({} as never, defaultToolbarLayout(), (layout) => (saved = layout));
	modal.onOpen();
	document.body.appendChild(modal.modalEl);
	return modal.contentEl;
}

const rows = (content: HTMLElement) => Array.from(content.querySelectorAll<HTMLElement>('.inkling-layout-row'));
const handleOf = (row: HTMLElement | undefined) => row?.querySelector<HTMLElement>('.inkling-layout-handle');
const shiftOf = (row: HTMLElement | undefined) => row?.style.getPropertyValue('--inkling-row-shift');

function press(target: Element | null | undefined, type: string, y: number) {
	target?.dispatchEvent(makePointerEvent(type, { pointerType: 'touch', pointerId: 7, clientX: 10, clientY: y, button: 0 }));
}

beforeEach(() => {
	document.body.innerHTML = '';
	installSurfaceStubs();
	// The harness runs animation frames at once, and the editor scrolls the
	// list once a frame while a row is held near its edge — which, in a
	// list jsdom gives no height, it always is. Frames never come here.
	window.requestAnimationFrame = () => 0;
	window.cancelAnimationFrame = () => undefined;
});

describe('dragging a row in the layout editor', () => {
	it('carries the row with the pointer and slides the rows it passes aside, before anything moves', () => {
		const content = open();
		const [first, second, third] = rows(content);
		press(handleOf(first), 'pointerdown', 0);
		// Two rows down (rows are 44 apart here, with no layout to measure).
		press(handleOf(first), 'pointermove', 90);

		expect(shiftOf(first)).toBe('90px');
		expect(shiftOf(second)).toBe('-44px');
		expect(shiftOf(third)).toBe('-44px');
		expect(content.querySelector('.inkling-layout-list')?.classList.contains('is-reordering')).toBe(true);
		// Not reordered yet.
		expect(rows(content)[0]).toBe(first);
	});

	it('drops the row where it was carried to, and puts every row back in its place', () => {
		const content = open();
		const order = defaultToolbarLayout().order;
		const [first] = rows(content);
		press(handleOf(first), 'pointerdown', 0);
		press(handleOf(first), 'pointermove', 90);
		press(handleOf(first), 'pointerup', 90);

		expect(rows(content).map((row) => row.dataset.item)).toEqual([order[1], order[2], order[0], ...order.slice(3)]);
		expect(rows(content).every((row) => shiftOf(row) === '0px')).toBe(true);
	});

	it('puts the row back where it was when the drag is cancelled', () => {
		const content = open();
		const [first] = rows(content);
		press(handleOf(first), 'pointerdown', 0);
		press(handleOf(first), 'pointermove', 200);
		press(handleOf(first), 'pointercancel', 200);
		expect(rows(content)[0]).toBe(first);
	});

	it('saves the new order only on Save', () => {
		const content = open();
		const [first] = rows(content);
		press(handleOf(first), 'pointerdown', 0);
		press(handleOf(first), 'pointermove', 46);
		press(handleOf(first), 'pointerup', 46);
		expect(saved).toBeNull();
		content.querySelector<HTMLButtonElement>('.inkling-layout-save')?.click();
		expect(saved?.order[1]).toBe(defaultToolbarLayout().order[0]);
	});

	it('keeps Save outside the list, so it is on screen however long the list is', () => {
		const content = open();
		const list = content.querySelector('.inkling-layout-list');
		const save = content.querySelector('.inkling-layout-save');
		expect(save).not.toBeNull();
		expect(list?.contains(save ?? null)).toBe(false);
	});
});
