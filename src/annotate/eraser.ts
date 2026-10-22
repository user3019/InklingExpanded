import { distanceToSegment, hitTestAnnotation } from './geometry';
import { Annotation, Point, StrokeAnnotation } from './types';
import { createId } from './id';

// Erasing a stroke removes the points the eraser passed over and keeps the
// rest — a stroke erased in the middle becomes two separate strokes, like a
// real eraser on a real pen line. Shapes have no interior point data to
// partially remove, so an eraser touch deletes the whole shape.
export function eraseAt(annotations: Annotation[], point: Point, radius: number): Annotation[] {
	const result: Annotation[] = [];

	for (const annotation of annotations) {
		// A picture is not ink, and rubbing out notes written over a photo
		// must not take the photo with them. It goes by selecting and
		// deleting it.
		if (annotation.kind === 'image') {
			result.push(annotation);
			continue;
		}
		// A note has no interior points to trim, the same as a shape — an
		// eraser touch removes the whole thing.
		if (annotation.kind !== 'stroke') {
			if (!hitTestAnnotation(annotation, point)) result.push(annotation);
			continue;
		}

		result.push(...eraseFromStroke(annotation, point, radius));
	}

	return result;
}

function eraseFromStroke(stroke: StrokeAnnotation, point: Point, radius: number): StrokeAnnotation[] {
	const points = stroke.points;
	const erased = points.map((p) => Math.hypot(p.x - point.x, p.y - point.y) <= radius);

	// A fast stroke can have consecutive sample points spaced further apart
	// than the eraser radius — checking only the stored vertices (above)
	// then misses a drag that's visually right on the line between two of
	// them. Also erase both endpoints of any segment that passes within
	// the eraser radius, not just points that happen to be close enough
	// themselves.
	const [first, ...rest] = points;
	let previous = first;
	rest.forEach((current, restIndex) => {
		if (previous && distanceToSegment(point, previous, current) <= radius) {
			erased[restIndex] = true;
			erased[restIndex + 1] = true;
		}
		previous = current;
	});

	if (!erased.some(Boolean)) return [stroke];

	const segments: Point[][] = [];
	let currentSegment: Point[] = [];
	points.forEach((p, i) => {
		if (erased[i]) {
			if (currentSegment.length > 0) {
				segments.push(currentSegment);
				currentSegment = [];
			}
		} else {
			currentSegment.push(p);
		}
	});
	if (currentSegment.length > 0) segments.push(currentSegment);

	return segments
		.filter((segmentPoints) => segmentPoints.length >= 2)
		.map((segmentPoints) => ({ ...stroke, id: createId(), points: segmentPoints }));
}
