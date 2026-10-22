import { storedAnnotation, type InkBlockData } from './inkBlockFormat';
import type { Annotation } from '../annotate/types';

// Reconciling a block whose file changed underneath the view holding it.
//
// A block flushes any pending write when it is torn down, and teardown often
// happens *because* the file changed — a sync landing inside the debounce is
// exactly that case. The write used to overwrite whatever the fence held, so
// the other device's strokes went silently. Refusing instead would lose ours
// rather than theirs, which is not better.
//
// A three-way merge is well defined here, and that is not luck: all three
// sides are in hand — what this view read (base), what it holds (ours), and
// what the file says now (theirs) — and annotations are independent records
// with stable ids. There is no ordering constraint between them beyond paint
// order, and nothing to reconcile inside one.
//
// Pure, and its own module, because it is the part worth testing
// exhaustively and the save path around it is the part that has already
// produced two data-loss bugs.

// Whether two annotations would be written the same way.
//
// Compared as they serialize rather than field by field: a difference that
// does not survive the round trip into the note is not a difference anyone
// can see, and coordinates are rounded on the way out. Comparing raw objects
// would call a stroke "changed" because a float moved in the twelfth
// decimal, and would then prefer our copy over theirs for no reason.
function sameAnnotation(a: Annotation | undefined, b: Annotation | undefined): boolean {
	if (!a || !b) return a === b;
	return JSON.stringify(storedAnnotation(a)) === JSON.stringify(storedAnnotation(b));
}

function byId(annotations: readonly Annotation[]): Map<string, Annotation> {
	return new Map(annotations.map((a) => [a.id, a]));
}

// Which side changed a field, resolved the same way for every scalar the
// block carries. Ours wins a genuine conflict, for the reason given at
// mergeInkBlocks.
function pick<T>(base: T, ours: T, theirs: T): T {
	if (ours !== base) return ours;
	return theirs;
}

/**
 * The block that keeps both sides' work.
 *
 * Ours wins a true conflict — where base, ours and theirs all differ —
 * because ours is the side whose pen has just moved, and so the side still
 * on screen in front of someone.
 */
export function mergeInkBlocks(base: InkBlockData, ours: InkBlockData, theirs: InkBlockData): InkBlockData {
	return {
		...theirs,
		id: ours.id ?? theirs.id,
		width: pick(base.width, ours.width, theirs.width),
		height: pick(base.height, ours.height, theirs.height),
		...captionOf(base, ours, theirs),
		annotations: mergeAnnotations(base.annotations, ours.annotations, theirs.annotations),
	};
}

/**
 * The annotations that keep both sides' work, by the same rules as a block:
 * shared with the PDF view, which merges a page the same way when another
 * device's save lands while it is open. `same` says whether two copies of
 * an annotation would be stored the same way, which is the only notion of
 * "changed" that counts — each format answers it for itself.
 */
export function mergeAnnotations(
	base: readonly Annotation[],
	ours: readonly Annotation[],
	theirs: readonly Annotation[],
	same: (a: Annotation | undefined, b: Annotation | undefined) => boolean = sameAnnotation,
): Annotation[] {
	const baseById = byId(base);
	const oursById = byId(ours);
	const theirsById = byId(theirs);
	const sameAnnotationAs = same;

	const merged: Annotation[] = [];

	// Their order first, so ink that overlaps keeps the stacking the file
	// already describes.
	for (const annotation of theirs) {
		const id = annotation.id;
		const inBase = baseById.get(id);
		const inOurs = oursById.get(id);

		// We erased it and did not draw it again: honour that.
		if (inBase && !inOurs) continue;

		// We changed it, so our copy is the newer of the two.
		if (inOurs && inBase && !sameAnnotationAs(inOurs, inBase)) {
			merged.push(inOurs);
			continue;
		}

		// Both added the same id without either seeing the other. Rare —
		// ids are random — but taking theirs here and skipping the addition
		// pass below is what stops it appearing twice.
		if (inOurs && !inBase && !sameAnnotationAs(inOurs, annotation)) {
			merged.push(inOurs);
			continue;
		}

		merged.push(annotation);
	}

	// Ours that theirs does not have: either we added it, or they erased
	// something we since changed. An addition is kept outright; a stroke we
	// changed outlives their deletion, because a deletion is cheap to repeat
	// and handwriting is not.
	for (const annotation of ours) {
		if (theirsById.has(annotation.id)) continue;
		const inBase = baseById.get(annotation.id);
		if (!inBase) {
			merged.push(annotation);
			continue;
		}
		if (!sameAnnotationAs(annotation, inBase)) merged.push(annotation);
	}

	return merged;
}

// Spread rather than assigned, so a block with no caption on either side
// keeps the field absent — the format writes nothing for an empty one, and
// an explicit `undefined` would still be a key here.
function captionOf(base: InkBlockData, ours: InkBlockData, theirs: InkBlockData): { caption?: string } {
	const caption = pick(base.caption, ours.caption, theirs.caption);
	return caption ? { caption } : {};
}
