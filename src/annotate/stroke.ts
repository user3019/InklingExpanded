import { Point, type PenBrush } from './types';

// The shape of a stroke, as geometry, with no renderer in it.
//
// Two things draw a stroke: the canvas overlay (src/annotate/render.ts) and
// the PDF appearance stream written into the file (src/pdf/annotationSync.ts).
// They have to agree exactly — ink that looks one way while you draw it and
// another way once saved is worse than either look on its own — so neither
// of them owns the geometry. This does, and being pure it is also the only
// part of stroke rendering that can be tested properly.

export type PathSegment =
	| { kind: 'move'; to: Point }
	| { kind: 'line'; to: Point }
	| { kind: 'quad'; control: Point; to: Point };

// How thin the lightest touch draws, as a fraction of the tool's width. Not
// zero: an outline of no width is an invisible stroke, which reads as ink
// that failed to record rather than as a light line.
export const MIN_PRESSURE_SCALE = 0.35;

export function hasPressure(points: Point[]): boolean {
	return points.some((point) => typeof point.p === 'number' && Number.isFinite(point.p));
}

function midpoint(a: Point, b: Point): Point {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// Quadratic midpoint smoothing: the curve passes through the midpoint of
// each consecutive pair of samples, using the sample itself as the control
// point.
//
// Chosen over a spline for having no degrees of freedom. There is no tension
// constant and no lookahead, so the canvas and the PDF cannot arrive at
// different curves from the same points — which a scheme with parameters
// invites, since the two are written months apart in different files.
//
// The last point is reached by a straight line rather than a curve, so a
// stroke always ends exactly where the pen was lifted.
export function smoothedPath(points: Point[]): PathSegment[] {
	const [first, second] = points;
	if (!first) return [];
	if (!second) return [{ kind: 'move', to: first }];

	const path: PathSegment[] = [{ kind: 'move', to: first }];
	if (points.length === 2) {
		path.push({ kind: 'line', to: second });
		return path;
	}

	path.push({ kind: 'line', to: midpoint(first, second) });
	for (let index = 1; index < points.length - 1; index++) {
		const control = points[index];
		const next = points[index + 1];
		if (!control || !next) continue;
		path.push({ kind: 'quad', control, to: midpoint(control, next) });
	}
	const last = points[points.length - 1];
	if (last) path.push({ kind: 'line', to: last });
	return path;
}

// Consecutive duplicates carry no direction, and a direction is what every
// offset below is perpendicular to. A stylus held still still reports
// moves, so this is the common case rather than a defensive one.
function withoutRepeats(points: Point[]): Point[] {
	const kept: Point[] = [];
	for (const point of points) {
		const previous = kept[kept.length - 1];
		if (previous && previous.x === point.x && previous.y === point.y) continue;
		kept.push(point);
	}
	return kept;
}

function halfWidthAt(point: Point, baseWidth: number): number {
	// A point with no pressure draws at full width, so a stroke whose device
	// only sometimes reported pressure doesn't develop a hairline gap
	// wherever the report went missing.
	const pressure = typeof point.p === 'number' && Number.isFinite(point.p) ? Math.min(Math.max(point.p, 0), 1) : 1;
	return (baseWidth * (MIN_PRESSURE_SCALE + (1 - MIN_PRESSURE_SCALE) * pressure)) / 2;
}

// A closed ring around the stroke, wide where the pen pressed and narrow
// where it did not — the shape that gets filled, since neither a canvas
// stroke nor a PDF `S` operator can vary a line's width along its length.
//
// The ring runs down one side of the stroke and back up the other, so a
// sample's two edge points sit at mirrored positions in the array: `index`
// and `2 * sampleCount - 1 - index`. That is what lets a test measure the
// width the outline actually has rather than restate the formula.
export function outlinePath(points: Point[], baseWidth: number): Point[] {
	const samples = withoutRepeats(points);
	if (samples.length < 2) return [];

	const left: Point[] = [];
	const right: Point[] = [];
	let lastNormal: Point | null = null;

	for (let index = 0; index < samples.length; index++) {
		const current = samples[index];
		if (!current) continue;
		// The direction *through* this sample rather than out of it, so a
		// corner's offset splits the difference between its two segments
		// instead of jumping.
		const before = samples[Math.max(0, index - 1)] ?? current;
		const after = samples[Math.min(samples.length - 1, index + 1)] ?? current;
		const dx = after.x - before.x;
		const dy = after.y - before.y;
		const length = Math.hypot(dx, dy);
		// Annotated, because it feeds lastNormal and lastNormal feeds it back:
		// without this the type is self-referential and inferred as any.
		const normal: Point | null = length > 0 ? { x: -dy / length, y: dx / length } : lastNormal;
		if (!normal) continue;
		lastNormal = normal;

		const half = halfWidthAt(current, baseWidth);
		left.push({ x: current.x + normal.x * half, y: current.y + normal.y * half });
		right.push({ x: current.x - normal.x * half, y: current.y - normal.y * half });
	}

	if (left.length < 2) return [];
	const ring = [...left, ...right.reverse()];
	const start = ring[0];
	if (start) ring.push(start);
	return ring;
}

// ---- Pens ----
//
// Two pens, and how each turns the path the hand took into ink. Everything a
// pen does is decided here, from the stored points alone, so a stroke looks
// the same drawn live, redrawn after a reload, written into a PDF, and on
// another device.
//
// The round pen is smooth: the hand's tremor steadied out, the line curved
// through the samples, the ends round. The sharp pen is the opposite: it
// follows the samples exactly, joins them with straight lines, keeps every
// corner the hand made and ends square — the crisp, angular line of a
// technical pen. Whether either one varies its width with pressure is the
// user's choice per pen (see ToolState.getPressure); without it the line is
// one width end to end.

// How far a sharp pen's corner may reach past the line, in widths: a
// hairpin turn would otherwise throw a spike far past it. Shared by the
// canvas and the PDF writer, which states it with `M`.
export const SHARP_MITRE_LIMIT = 2;

interface PenModel {
	// How thin the lightest touch draws, as a fraction of the width.
	minScale: number;
	// Passes of steadyPoints. None for the sharp pen, whose point is to put
	// down exactly what the hand did.
	steadying: number;
	sharp: boolean;
}

const PENS: Record<PenBrush, PenModel> = {
	pen: { minScale: MIN_PRESSURE_SCALE, steadying: 2, sharp: false },
	sharp: { minScale: MIN_PRESSURE_SCALE, steadying: 0, sharp: true },
};

// The part of a stroke a pen needs.
interface Inked {
	tool: string;
	points: Point[];
	width: number;
	brush?: PenBrush;
}

function penOf(stroke: Inked): PenModel {
	return PENS[stroke.brush ?? 'pen'];
}

export function isSharp(stroke: Inked): boolean {
	return stroke.tool === 'pen' && penOf(stroke).sharp;
}

// Whether a stroke is drawn as a filled outline rather than a stroked line:
// a pen stroke that varies its width, which only an outline can. One width
// end to end is a stroked line, which is lighter to draw and to store.
export function isOutlined(stroke: Inked): boolean {
	return stroke.tool === 'pen' && hasPressure(stroke.points);
}

// Takes the hand's tremor out of a path: each pass moves every point a
// little towards its neighbours (weights 1-2-1), which flattens the small
// zigzag a stylus records while leaving the shape of letters alone. The
// first and last points never move, so the line ends exactly under the pen
// and a stroke still being drawn does not lag behind the tip. Pressure is
// smoothed the same way: a stylus reports it noisily, and every jump in it
// was a bump in the ink.
export function steadyPoints(points: Point[], passes: number): Point[] {
	if (points.length < 3 || passes <= 0) return points;
	const pressured = hasPressure(points);
	let current = points.map((point) => ({ ...point }));
	for (let pass = 0; pass < passes; pass++) {
		const next = current.map((point) => ({ ...point }));
		for (let index = 1; index < current.length - 1; index++) {
			const before = current[index - 1];
			const here = current[index];
			const after = current[index + 1];
			const target = next[index];
			if (!before || !here || !after || !target) continue;
			target.x = (before.x + 2 * here.x + after.x) / 4;
			target.y = (before.y + 2 * here.y + after.y) / 4;
			if (pressured && typeof here.p === 'number') {
				const p0 = typeof before.p === 'number' ? before.p : here.p;
				const p2 = typeof after.p === 'number' ? after.p : here.p;
				target.p = (p0 + 2 * here.p + p2) / 4;
			}
		}
		current = next;
	}
	return current;
}

// The points a pen actually draws through, from the samples it reported.
// Applied to the live stroke and the committed one alike, so nothing moves
// when the pen lifts.
export function prepareStroke(points: Point[], brush: PenBrush = 'pen'): Point[] {
	return steadyPoints(points, PENS[brush].steadying);
}

function pressureOf(point: Point): number {
	return typeof point.p === 'number' && Number.isFinite(point.p) ? Math.min(Math.max(point.p, 0), 1) : 1;
}

// A semicircle of points from `from` round `centre` to the point opposite,
// going the way `towards` points — a round end on a stroke.
function capArc(centre: Point, from: Point, towards: Point, out: Point[]): void {
	const radius = Math.hypot(from.x - centre.x, from.y - centre.y);
	if (!(radius > 0)) return;
	const start = Math.atan2(from.y - centre.y, from.x - centre.x);
	// Which way round: the half of the circle that bulges towards `towards`.
	const cross = (from.x - centre.x) * (towards.y - centre.y) - (from.y - centre.y) * (towards.x - centre.x);
	const direction = cross > 0 ? 1 : -1;
	const steps = 8;
	for (let step = 1; step < steps; step++) {
		const angle = start + (direction * Math.PI * step) / steps;
		out.push({ x: centre.x + Math.cos(angle) * radius, y: centre.y + Math.sin(angle) * radius });
	}
}

// The closed ring of ink round a stroke whose width follows its pressure:
// down one side, round the far end, back up the other side, round the near
// end. Round ends on the round pen; the sharp pen's are cut square.
export function strokeRing(stroke: Inked): Point[] {
	const pen = penOf(stroke);
	const samples = withoutRepeats(stroke.points);
	if (samples.length < 2) return [];

	const left: Point[] = [];
	const right: Point[] = [];
	let lastNormal: Point | null = null;
	// The sharp pen turns on the spot at each sample, so it takes the
	// direction from its immediate neighbours; the round pen looks a little
	// further either side, so one stray sample does not kink its edge.
	const reach = pen.sharp ? 1 : 2;

	for (let index = 0; index < samples.length; index++) {
		const current = samples[index];
		if (!current) continue;
		const before = samples[Math.max(0, index - reach)] ?? current;
		const after = samples[Math.min(samples.length - 1, index + reach)] ?? current;
		const dx = after.x - before.x;
		const dy = after.y - before.y;
		const length = Math.hypot(dx, dy);
		const normal: Point | null = length > 0 ? { x: -dy / length, y: dx / length } : lastNormal;
		if (!normal) continue;
		lastNormal = normal;

		const half = (stroke.width * (pen.minScale + (1 - pen.minScale) * pressureOf(current))) / 2;
		left.push({ x: current.x + normal.x * half, y: current.y + normal.y * half });
		right.push({ x: current.x - normal.x * half, y: current.y - normal.y * half });
	}
	if (left.length < 2) return [];

	const first = samples[0];
	const last = samples[samples.length - 1];
	const ring: Point[] = [...left];
	const endLeft = left[left.length - 1];
	const startRight = right[0];
	if (!pen.sharp && last && endLeft) {
		const beforeLast = samples[samples.length - 2] ?? last;
		capArc(last, endLeft, { x: last.x + (last.x - beforeLast.x), y: last.y + (last.y - beforeLast.y) }, ring);
	}
	ring.push(...right.reverse());
	if (!pen.sharp && first && startRight) {
		const second = samples[1] ?? first;
		capArc(first, startRight, { x: first.x + (first.x - second.x), y: first.y + (first.y - second.y) }, ring);
	}
	return ring;
}

// The ring as a path. The round pen's is a smooth closed curve, through the
// midpoint of every pair of neighbouring ring points with the points
// themselves as control points — a ring joined with straight lines showed
// every sample as a corner along the edge of the ink. The sharp pen's is
// exactly those straight lines, which is the point of it.
export function strokeOutline(stroke: Inked): PathSegment[] {
	const ring = strokeRing(stroke);
	const count = ring.length;
	const first = ring[0];
	const last = ring[count - 1];
	if (count < 3 || !first || !last) return [];
	if (isSharp(stroke)) {
		return [{ kind: 'move', to: first }, ...ring.slice(1).map((to): PathSegment => ({ kind: 'line', to })), { kind: 'line', to: first }];
	}
	const path: PathSegment[] = [{ kind: 'move', to: midpoint(last, first) }];
	for (let index = 0; index < count; index++) {
		const control = ring[index];
		const next = ring[(index + 1) % count];
		if (control && next) path.push({ kind: 'quad', control, to: midpoint(control, next) });
	}
	return path;
}

// The line a stroke of one width is drawn along: curved through the
// samples for the round pen and the highlighter, straight from sample to
// sample for the sharp pen.
export function strokeCentreline(stroke: Inked): PathSegment[] {
	if (!isSharp(stroke)) return smoothedPath(stroke.points);
	const [first, ...rest] = stroke.points;
	if (!first) return [];
	return [{ kind: 'move', to: first }, ...rest.map((to): PathSegment => ({ kind: 'line', to }))];
}
