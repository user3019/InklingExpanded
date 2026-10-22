import { Annotation, NOTE_MARKER_SIZE, Point, Rect } from './types';

export function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const lengthSquared = dx * dx + dy * dy;
	if (lengthSquared === 0) return distance(p, a);

	let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
	t = Math.max(0, Math.min(1, t));
	return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function distanceToPolyline(p: Point, points: Point[]): number {
	const [first, ...rest] = points;
	if (!first) return Infinity;
	if (rest.length === 0) return distance(p, first);

	let min = Infinity;
	let previous = first;
	for (const current of rest) {
		min = Math.min(min, distanceToSegment(p, previous, current));
		previous = current;
	}
	return min;
}

export function boundingBox(annotation: Annotation): Rect {
	if (annotation.kind === 'note') return noteBox(annotation.at);
	const points = annotation.kind === 'stroke' ? annotation.points : [annotation.start, annotation.end];
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

// The marker is centred on the note’s point, so its box is the same
// half-size in every direction.
function noteBox(at: Point): Rect {
	const half = NOTE_MARKER_SIZE / 2;
	return { minX: at.x - half, minY: at.y - half, maxX: at.x + half, maxY: at.y + half };
}

export function unionBoundingBox(boxes: Rect[]): Rect {
	return {
		minX: Math.min(...boxes.map((b) => b.minX)),
		minY: Math.min(...boxes.map((b) => b.minY)),
		maxX: Math.max(...boxes.map((b) => b.maxX)),
		maxY: Math.max(...boxes.map((b) => b.maxY)),
	};
}

// Selection hit-testing is deliberately generous (half the stroke width, at
// least a touch-friendly minimum) — thin strokes are hard to hit precisely
// with a fingertip or an imprecise pen tap.
const MIN_HIT_TOLERANCE = 10;

export function hitTestAnnotation(annotation: Annotation, point: Point): boolean {
	const tolerance = Math.max(MIN_HIT_TOLERANCE, annotation.width / 2 + 4);

	if (annotation.kind === 'note') {
		// A disc, not the marker’s square: a note is tapped at, and a
		// round target is what a fingertip actually aims for.
		return distance(annotation.at, point) <= Math.max(NOTE_MARKER_SIZE / 2, MIN_HIT_TOLERANCE);
	}

	if (annotation.kind === 'stroke') {
		return distanceToPolyline(point, annotation.points) <= tolerance;
	}

	if (annotation.kind === 'shape' && (annotation.tool === 'line' || annotation.tool === 'arrow')) {
		return distanceToSegment(point, annotation.start, annotation.end) <= tolerance;
	}

	// rectangle / oval: anywhere inside a tolerance-inflated bounding box —
	// treated as a fillable region for selection purposes even though only
	// the outline is drawn, since that's the easier target to hit.
	const box = boundingBox(annotation);
	return (
		point.x >= box.minX - tolerance &&
		point.x <= box.maxX + tolerance &&
		point.y >= box.minY - tolerance &&
		point.y <= box.maxY + tolerance
	);
}

// Ray-casting point-in-polygon test (even-odd rule) — used by the freeform
// lasso below. Treats `polygon` as implicitly closed (wraps from the last
// point back to the first) regardless of whether the caller already closed
// it explicitly.
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
	if (polygon.length < 3) return false;
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const pi = polygon[i];
		const pj = polygon[j];
		if (!pi || !pj) continue;
		const crosses = pi.y > point.y !== pj.y > point.y;
		if (crosses && point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x) inside = !inside;
	}
	return inside;
}

// The points that define an annotation's extent, for the freeform lasso's
// "fully enclosed" test below — every stroke point, a shape's two
// endpoints, or (rectangle/oval) all four corners of its bounding box,
// since a concave lasso could enclose a shape's start/end diagonal while
// still cutting through one of its other two corners.
function extentPoints(annotation: Annotation): Point[] {
	if (annotation.kind === 'note') return [annotation.at];
	if (annotation.kind === 'stroke') return annotation.points;
	if (annotation.kind === 'shape' && (annotation.tool === 'line' || annotation.tool === 'arrow')) return [annotation.start, annotation.end];
	const box = boundingBox(annotation);
	return [
		{ x: box.minX, y: box.minY },
		{ x: box.maxX, y: box.minY },
		{ x: box.minX, y: box.maxY },
		{ x: box.maxX, y: box.maxY },
	];
}

// Freeform-lasso selection is full-enclosure, not intersection — an
// annotation is only selected once the drawn loop actually surrounds it,
// not merely touches it.
export function polygonEnclosesAnnotation(annotation: Annotation, polygon: Point[]): boolean {
	return extentPoints(annotation).every((p) => pointInPolygon(p, polygon));
}

// How much of an annotation has to lie inside a lasso for the lasso to take
// it. Not all of it: a loop drawn round a word by hand clips the tail of a
// g or the cross of a t as often as not, and a lasso that then left those
// letters behind read as broken. Not any of it either, or a loop round one
// line would pick up the descenders of the line above.
export const LASSO_COVERAGE = 0.6;

// Whether a lasso loop takes this annotation: most of it inside the loop.
// For a stroke that is most of its samples, which sit along it evenly
// enough to stand for its length.
export function polygonSelectsAnnotation(annotation: Annotation, polygon: Point[]): boolean {
	// A locked picture is the page's background, not something to pick up
	// with the writing on it.
	if (annotation.kind === 'image' && annotation.locked) return false;
	const points = extentPoints(annotation);
	if (points.length === 0) return false;
	let inside = 0;
	for (const point of points) if (pointInPolygon(point, polygon)) inside++;
	return inside / points.length >= LASSO_COVERAGE;
}

// Scales an annotation about a fixed point, stroke width included — what
// dragging a selection's corner does. The width comes along so that
// handwriting made larger looks like the same handwriting, larger, rather
// than the same thin line drawn round bigger letters. A note's marker is
// chrome at a fixed size, so a note only moves.
export function scaleAnnotationAbout(annotation: Annotation, anchor: Point, factor: number): Annotation {
	const project = (p: Point): Point => ({ ...p, x: anchor.x + (p.x - anchor.x) * factor, y: anchor.y + (p.y - anchor.y) * factor });
	if (annotation.kind === 'note') return { ...annotation, at: project(annotation.at) };
	const width = annotation.width * factor;
	if (annotation.kind === 'stroke') return { ...annotation, width, points: annotation.points.map(project) };
	return { ...annotation, width, start: project(annotation.start), end: project(annotation.end) };
}

export function translateAnnotation(annotation: Annotation, dx: number, dy: number): Annotation {
	if (annotation.kind === 'note') {
		return { ...annotation, at: { x: annotation.at.x + dx, y: annotation.at.y + dy } };
	}
	if (annotation.kind === 'stroke') {
		// Spread, not rebuilt: a point without its pressure draws at full
		// width, so a moved pen stroke used to land visibly thicker.
		return { ...annotation, points: annotation.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) };
	}
	return {
		...annotation,
		start: { x: annotation.start.x + dx, y: annotation.start.y + dy },
		end: { x: annotation.end.x + dx, y: annotation.end.y + dy },
	};
}

// Scales an annotation's geometry from `from` to `to` (a resize-handle
// drag). Degenerate axes (a perfectly flat/vertical selection) keep that
// axis's original coordinates rather than dividing by zero.
export function scaleAnnotation(annotation: Annotation, from: Rect, to: Rect): Annotation {
	const scaleX = from.maxX - from.minX === 0 ? 1 : (to.maxX - to.minX) / (from.maxX - from.minX);
	const scaleY = from.maxY - from.minY === 0 ? 1 : (to.maxY - to.minY) / (from.maxY - from.minY);

	// Pressure comes along for the same reason as in translateAnnotation.
	const project = (p: Point): Point => ({
		...p,
		x: to.minX + (p.x - from.minX) * scaleX,
		y: to.minY + (p.y - from.minY) * scaleY,
	});

	// A note moves with a resize but does not grow with it: the marker is
	// chrome at a fixed size, not geometry, so scaling it would make a
	// pin the size of a paragraph.
	if (annotation.kind === 'note') return { ...annotation, at: project(annotation.at) };
	if (annotation.kind === 'stroke') {
		return { ...annotation, points: annotation.points.map(project) };
	}
	return { ...annotation, start: project(annotation.start), end: project(annotation.end) };
}

// Scales an annotation about the origin by a single factor, stroke width
// included.
//
// Distinct from scaleAnnotation above, which maps one rectangle onto
// another for a resize-handle drag and deliberately leaves width alone —
// resizing a selection should not fatten its lines. This is for moving an
// annotation between two coordinate spaces that differ only in resolution,
// where the width is a length like any other and has to come with it.
export function scaleAnnotationUniform(annotation: Annotation, factor: number): Annotation {
	const point = (p: Point): Point => (p.p === undefined ? { x: p.x * factor, y: p.y * factor } : { x: p.x * factor, y: p.y * factor, p: p.p });
	const width = annotation.width * factor;

	if (annotation.kind === 'note') return { ...annotation, width, at: point(annotation.at) };
	if (annotation.kind === 'stroke') return { ...annotation, width, points: annotation.points.map(point) };
	return { ...annotation, width, start: point(annotation.start), end: point(annotation.end) };
}

export function normalizeRect(a: Point, b: Point): Rect {
	return {
		minX: Math.min(a.x, b.x),
		minY: Math.min(a.y, b.y),
		maxX: Math.max(a.x, b.x),
		maxY: Math.max(a.y, b.y),
	};
}

// Pulls a point inside a surface of `width` x `height`.
//
// Pointer capture is why this is needed. Once a stroke starts, every
// subsequent move is delivered to the surface that captured the pointer,
// wherever the pen actually is — that is the whole point of capture, and it
// is what lets a stroke survive a finger straying off the edge mid-letter.
// The cost is that a stroke dragged past the edge kept recording out there:
// on an 800-wide block, coordinates reaching x=1200 and y=-167, drawn
// outside the block, saved into the note, and invisible only because a
// canvas discards what falls off it.
//
// Clamped rather than dropped, so the stroke slides along the edge and
// stays one continuous line. Dropping the outside samples instead would cut
// the stroke into pieces and reconnect them with a straight line across the
// gap, which is a bigger change to what the user drew than sliding is.
//
// The in-bounds point is returned as-is rather than copied: this runs on
// every sample of every stroke, and the overwhelming majority are already
// inside.
export function clampPointToBounds(point: Point, width: number, height: number): Point {
	const x = Math.min(Math.max(point.x, 0), width);
	const y = Math.min(Math.max(point.y, 0), height);
	if (x === point.x && y === point.y) return point;
	return point.p === undefined ? { x, y } : { x, y, p: point.p };
}

// Limits a move so the selection stays on the page.
//
// The selection's own edges are what have to stay put, not the pointer.
// Clamping the pointer instead — which is what drawing does, where the
// pointer *is* the ink — would stop a selection short of the edge by
// however far from its corner you happened to grab it, and would feel like
// the drag sticking for no reason.
//
// A selection larger than the page cannot be kept inside one, so the rule
// there becomes "do not make it worse": the two limits cross over, and the
// range between them is what is left to move within.
export function clampTranslation(
	box: Rect,
	dx: number,
	dy: number,
	width: number,
	height: number,
): { dx: number; dy: number } {
	const limit = (delta: number, low: number, high: number): number =>
		Math.min(Math.max(delta, Math.min(low, high)), Math.max(low, high));

	return {
		dx: limit(dx, -box.minX, width - box.maxX),
		dy: limit(dy, -box.minY, height - box.maxY),
	};
}

// Pulls a rectangle inside a surface, edge by edge — the resize counterpart
// to clampTranslation. Each edge is clamped on its own rather than the
// whole rectangle being shifted, because a resize is meant to change the
// shape: the handle being dragged should stop at the edge while the corner
// opposite it stays exactly where it was.
export function clampRectToBounds(rect: Rect, width: number, height: number): Rect {
	const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max);
	return {
		minX: clamp(rect.minX, width),
		minY: clamp(rect.minY, height),
		maxX: clamp(rect.maxX, width),
		maxY: clamp(rect.maxY, height),
	};
}
