// The rules for a handwritten note that grows as it is written on.
//
// An infinite canvas is still an ordinary PDF: one page, whose MediaBox is
// widened whenever ink comes near one of its edges. Widened outward in
// every direction, the left and bottom by moving the box's origin into
// negative coordinates, so growing never has to move a single stroke — an
// annotation's position in PDF space stays exactly where it was, and only
// the window onto that space gets larger. The background is a tiling
// pattern filled over far more than the page could ever be (see
// templates.ts), so it is already there wherever the box reaches.
//
// Pure geometry, in PDF points with y pointing up, so it can be tested
// without a document or a view.

// Marks a note as an infinite canvas, next to its template keyword.
export const INFINITE_CANVAS_KEYWORD = 'inkling:canvas=infinite';

// The size an infinite canvas starts at, and the yardstick its zoom is
// measured against: a canvas is laid out at the scale that fits this width
// to the pane, however wide it has since become, so ink drawn on it keeps
// the same size on screen as the canvas grows.
//
// Letter, whatever the page-size setting says. A canvas has no paper size,
// and one fixed starting point means every canvas draws at the same zoom.
export const INFINITE_BASE_WIDTH = 612;
export const INFINITE_BASE_HEIGHT = 792;

// How much an edge moves out each time it grows: a starting page's worth.
// Generous on purpose: each growth rewrites the file and re-renders the
// page, and a canvas that grew a sliver at a time would do that every few
// lines.
export const GROW_STEP_X = INFINITE_BASE_WIDTH;
export const GROW_STEP_Y = INFINITE_BASE_HEIGHT;

// Ink this close to an edge grows that edge. Two inches: far enough out
// that the next line or two always has room, close enough that writing in
// the middle of a page never grows anything.
export const EDGE_ZONE = 144;

// The largest a page may become in either direction: 200 inches, which is
// Acrobat's limit and so the size every other PDF reader can be trusted to
// open. Coordinates stay inside ±MAX_COORDINATE too, which is the area the
// background pattern is filled over.
export const MAX_PAGE_EXTENT = 14400;
export const MAX_COORDINATE = 14400;

export type Edge = 'left' | 'right' | 'top' | 'bottom';

export interface PdfBox {
	left: number;
	bottom: number;
	right: number;
	top: number;
}

export function isInfiniteCanvasKeywords(keywords: string | null | undefined): boolean {
	return !!keywords && keywords.split(/\s+/).includes(INFINITE_CANVAS_KEYWORD);
}

// pdf.js's `page.view`, which is the MediaBox as [x0, y0, x1, y1] — the
// corners in whichever order the file wrote them.
export function boxFromView(view: readonly number[]): PdfBox {
	const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = view;
	return { left: Math.min(x0, x1), bottom: Math.min(y0, y1), right: Math.max(x0, x1), top: Math.max(y0, y1) };
}

// The edges of `box` that `ink` comes within `distance` of. Nothing for a
// canvas with no ink on it, which is what keeps an empty canvas from
// growing however it is scrolled.
export function edgesNear(box: PdfBox, ink: PdfBox | null, distance: number): Edge[] {
	if (!ink) return [];
	const edges: Edge[] = [];
	if (ink.left - box.left < distance) edges.push('left');
	if (box.right - ink.right < distance) edges.push('right');
	if (box.top - ink.top < distance) edges.push('top');
	if (ink.bottom - box.bottom < distance) edges.push('bottom');
	return edges;
}

export interface Growth {
	box: PdfBox;
	// How far the left and top edges moved out, in points. The view scrolls
	// by these so that what was on screen before the growth still is.
	addedLeft: number;
	addedTop: number;
}

// The box with each of `edges` moved out by a step, as far as the limits
// allow. Null when none of them could move at all.
export function growBox(box: PdfBox, edges: readonly Edge[]): Growth | null {
	let { left, bottom, right, top } = box;
	if (edges.includes('left')) left = Math.max(left - GROW_STEP_X, -MAX_COORDINATE, right - MAX_PAGE_EXTENT);
	if (edges.includes('right')) right = Math.min(right + GROW_STEP_X, MAX_COORDINATE, left + MAX_PAGE_EXTENT);
	if (edges.includes('bottom')) bottom = Math.max(bottom - GROW_STEP_Y, -MAX_COORDINATE, top - MAX_PAGE_EXTENT);
	if (edges.includes('top')) top = Math.min(top + GROW_STEP_Y, MAX_COORDINATE, bottom + MAX_PAGE_EXTENT);

	if (left === box.left && right === box.right && bottom === box.bottom && top === box.top) return null;
	return { box: { left, bottom, right, top }, addedLeft: box.left - left, addedTop: top - box.top };
}

// The smallest box around every point given, or null for none.
export function boundsOf(points: ReadonlyArray<{ x: number; y: number }>): PdfBox | null {
	if (points.length === 0) return null;
	let left = Infinity;
	let bottom = Infinity;
	let right = -Infinity;
	let top = -Infinity;
	for (const { x, y } of points) {
		left = Math.min(left, x);
		right = Math.max(right, x);
		bottom = Math.min(bottom, y);
		top = Math.max(top, y);
	}
	return { left, bottom, right, top };
}
