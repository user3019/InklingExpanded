import { PathSegment } from '../annotate/stroke';
import { Point } from '../annotate/types';

// Standard Bezier approximation constant for a quarter-circle arc.
const CIRCLE_KAPPA = 0.5522847498307936;

function n(value: number): string {
	return value.toFixed(2);
}

// Builds a PDF content-stream path (no paint operator) from a polyline —
// used for both the ink stroke itself and for line/arrow shafts.
export function moveLineOps(points: Point[]): string {
	const [first, ...rest] = points;
	if (!first) return '';
	const parts = [`${n(first.x)} ${n(first.y)} m`];
	for (const p of rest) parts.push(`${n(p.x)} ${n(p.y)} l`);
	return parts.join('\n');
}

// The PDF twin of render.ts's tracePath: the same shared path description
// (see annotate/stroke.ts), emitted as operators instead of canvas calls.
// A quadratic is written as PDF's `v` — a cubic that reuses the current
// point as its first control, which is exactly what a quadratic is —
// because PDF has no quadratic operator of its own.
export function pathOps(segments: PathSegment[]): string {
	const parts: string[] = [];
	let at: Point | null = null;
	for (const segment of segments) {
		if (segment.kind === 'move') parts.push(`${n(segment.to.x)} ${n(segment.to.y)} m`);
		else if (segment.kind === 'line') parts.push(`${n(segment.to.x)} ${n(segment.to.y)} l`);
		else if (at) {
			// PDF has no quadratic curve, so each becomes the cubic that
			// traces exactly the same curve: both control points two thirds of
			// the way from an end to the quadratic's control. The canvas draws
			// the quadratic itself, and this is what keeps the two identical —
			// the `v` shorthand this used to emit is a different, flatter
			// curve, which put a faint corner at every sample in the saved
			// file that the screen never showed.
			const { control, to } = segment;
			const c1 = { x: at.x + (2 / 3) * (control.x - at.x), y: at.y + (2 / 3) * (control.y - at.y) };
			const c2 = { x: to.x + (2 / 3) * (control.x - to.x), y: to.y + (2 / 3) * (control.y - to.y) };
			parts.push(`${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(to.x)} ${n(to.y)} c`);
		} else {
			parts.push(`${n(segment.control.x)} ${n(segment.control.y)} ${n(segment.to.x)} ${n(segment.to.y)} v`);
		}
		at = segment.to;
	}
	return parts.join('\n');
}

// A closed ring, for filling — the shape a pressure-varying stroke takes,
// since no PDF stroking operator can change a line's width along its
// length.
export function polygonOps(points: Point[]): string {
	const [first, ...rest] = points;
	if (!first || rest.length < 2) return '';
	const parts = [`${n(first.x)} ${n(first.y)} m`];
	for (const point of rest) parts.push(`${n(point.x)} ${n(point.y)} l`);
	parts.push('h');
	return parts.join('\n');
}

// The marker a note annotation draws, matching drawNoteMarker in
// src/annotate/render.ts: a rounded tab with its bottom-right corner
// folded. Written out rather than shared through annotate/stroke.ts
// because there is no shared path abstraction for arcs — the two are kept
// in step by being the same eight segments in the same order, and by this
// comment.
//
// PDF y grows upward where canvas y grows down, so the fold is on the
// bottom-right in both only because this mirrors the vertical.
export function noteMarkerOps(at: Point, size: number): string {
	const half = size / 2;
	const x = at.x - half;
	const y = at.y - half;
	const fold = size * 0.32;
	const r = size * 0.18;
	const k = r * CIRCLE_KAPPA;
	return [
		`${n(x + r)} ${n(y + size)} m`,
		`${n(x + size - r)} ${n(y + size)} l`,
		`${n(x + size - r + k)} ${n(y + size)} ${n(x + size)} ${n(y + size - r + k)} ${n(x + size)} ${n(y + size - r)} c`,
		`${n(x + size)} ${n(y + fold)} l`,
		`${n(x + size - fold)} ${n(y)} l`,
		`${n(x + r)} ${n(y)} l`,
		`${n(x + r - k)} ${n(y)} ${n(x)} ${n(y + r - k)} ${n(x)} ${n(y + r)} c`,
		`${n(x)} ${n(y + size - r)} l`,
		`${n(x)} ${n(y + size - r + k)} ${n(x + r - k)} ${n(y + size)} ${n(x + r)} ${n(y + size)} c`,
		'h',
	].join('\n');
}

export function rectangleOps(x: number, y: number, width: number, height: number): string {
	return `${n(x)} ${n(y)} ${n(width)} ${n(height)} re`;
}

// A closed ellipse path via four cubic Bezier arcs — PDF has no native
// ellipse/arc operator.
export function ellipseOps(cx: number, cy: number, rx: number, ry: number): string {
	const ox = rx * CIRCLE_KAPPA;
	const oy = ry * CIRCLE_KAPPA;
	return [
		`${n(cx - rx)} ${n(cy)} m`,
		`${n(cx - rx)} ${n(cy + oy)} ${n(cx - ox)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c`,
		`${n(cx + ox)} ${n(cy + ry)} ${n(cx + rx)} ${n(cy + oy)} ${n(cx + rx)} ${n(cy)} c`,
		`${n(cx + rx)} ${n(cy - oy)} ${n(cx + ox)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c`,
		`${n(cx - ox)} ${n(cy - ry)} ${n(cx - rx)} ${n(cy - oy)} ${n(cx - rx)} ${n(cy)} c`,
		'h',
	].join('\n');
}

// Two open line segments radiating from the tip — mirrors the arrowhead
// drawn on the canvas overlay (src/annotate/render.ts) so the PDF appearance
// matches what the user actually drew.
export function arrowHeadOps(from: Point, to: Point, size: number): string {
	const angle = Math.atan2(to.y - from.y, to.x - from.x);
	const spread = Math.PI / 7;
	const wing1 = { x: to.x - size * Math.cos(angle - spread), y: to.y - size * Math.sin(angle - spread) };
	const wing2 = { x: to.x - size * Math.cos(angle + spread), y: to.y - size * Math.sin(angle + spread) };
	return [`${n(to.x)} ${n(to.y)} m`, `${n(wing1.x)} ${n(wing1.y)} l`, `${n(to.x)} ${n(to.y)} m`, `${n(wing2.x)} ${n(wing2.y)} l`].join(
		'\n',
	);
}
