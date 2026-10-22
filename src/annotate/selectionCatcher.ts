import type { Point } from './types';

// Following a pen that the page is not told about.
//
// On Android, a pen that touches the screen with its side button held never
// reaches the page: Chromium keeps that touch for selecting text
// (StylusTextSelector — the web view Obsidian runs in is Chromium), and sends
// none of its moves on. What it does instead is select text: from where the
// pen came down to wherever it is now, updated as it moves. So, while the
// button is held, a layer of invisible, selectable text lies over the page,
// and the end of that selection is where the pen is. That is what lets the
// side button be held to erase, as it is in Samsung Notes.
//
// The text is a grid of one-letter words — "a a a a …" — rather than one
// long word: Android extends a touch selection a word at a time, and a word
// the width of the page would put the pen at one edge or the other.

export interface CatcherHandlers {
	// Where the pen is, in the page canvas's own pixels, as the selection
	// says — the first one where it came down.
	onPoint(point: Point): void;
	// The selection has stopped moving: the pen is up, or hovering again.
	onEnd(): void;
	// A pen event landing on the layer itself — hovering — which the canvas
	// under it would otherwise have had.
	onPointer(event: PointerEvent): void;
}

// How long the selection may stand still before the stroke counts as over.
// A pen held still on the glass also stops it moving, so not too short.
const SETTLE_MS = 400;
// A cell of the grid, in CSS pixels, when the font cannot be measured.
const FALLBACK_CELL = { width: 7, height: 7 };

// The grid's cell under a text offset, and its middle on the layer.
export function cellAt(offset: number, columns: number, cell: { width: number; height: number }): Point {
	const perRow = columns * 2 + 1;
	const row = Math.floor(offset / perRow);
	const column = Math.min(Math.floor((offset % perRow) / 2), columns - 1);
	return { x: (column + 0.5) * cell.width, y: (row + 0.5) * cell.height };
}

export function attachSelectionCatcher(host: HTMLElement, canvas: HTMLCanvasElement, handlers: CatcherHandlers): () => void {
	const doc = host.ownerDocument;
	const layer = host.createDiv({ cls: 'inkling-selection-catcher' });

	// One pair's width, measured: the monospace font's advance at this size
	// differs a little from system to system.
	const probe = layer.createSpan({ text: 'a '.repeat(20) });
	const measured = probe.getBoundingClientRect().width / 20;
	probe.remove();
	const cell = {
		width: measured > 0 ? measured : FALLBACK_CELL.width,
		height: parseFloat(getComputedStyle(layer).lineHeight) || FALLBACK_CELL.height,
	};
	const box = host.getBoundingClientRect();
	const columns = Math.max(1, Math.ceil((box.width || canvas.width) / cell.width));
	const rows = Math.max(1, Math.ceil((box.height || canvas.height) / cell.height));
	const line = 'a '.repeat(columns);
	const text = doc.createTextNode(Array.from({ length: rows }, () => line).join('\n'));
	layer.appendChild(text);

	let settle: number | null = null;
	let moving = false;

	const toCanvas = (at: Point): Point => {
		const layerBox = layer.getBoundingClientRect();
		const canvasBox = canvas.getBoundingClientRect();
		const scaleX = canvasBox.width > 0 ? canvas.width / canvasBox.width : 1;
		const scaleY = canvasBox.height > 0 ? canvas.height / canvasBox.height : 1;
		return { x: (layerBox.left + at.x - canvasBox.left) * scaleX, y: (layerBox.top + at.y - canvasBox.top) * scaleY };
	};

	const end = () => {
		if (settle !== null) window.clearTimeout(settle);
		settle = null;
		if (!moving) return;
		moving = false;
		// Nothing is left selected, and no menu for a selection is offered.
		doc.getSelection()?.removeAllRanges();
		handlers.onEnd();
	};

	const onSelectionChange = () => {
		const selection = doc.getSelection();
		if (!selection || selection.focusNode !== text) return;
		if (!moving && selection.anchorNode === text) {
			moving = true;
			handlers.onPoint(toCanvas(cellAt(selection.anchorOffset, columns, cell)));
		}
		moving = true;
		handlers.onPoint(toCanvas(cellAt(selection.focusOffset, columns, cell)));
		if (settle !== null) window.clearTimeout(settle);
		settle = window.setTimeout(end, SETTLE_MS);
	};

	const onPointer = (event: PointerEvent) => {
		// The pen hovering again: whatever the selection was doing is over.
		if (event.pointerType === 'pen' && !(event.pressure > 0)) end();
		handlers.onPointer(event);
	};
	// No menu over it, as over the page.
	const onContextMenu = (event: Event) => event.preventDefault();

	doc.addEventListener('selectionchange', onSelectionChange);
	for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointerleave'] as const) layer.addEventListener(type, onPointer);
	layer.addEventListener('contextmenu', onContextMenu);

	return () => {
		end();
		doc.removeEventListener('selectionchange', onSelectionChange);
		layer.remove();
	};
}
