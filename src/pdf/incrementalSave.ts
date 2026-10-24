import { PDFDocument, type PDFObject, type PDFRef } from 'pdf-lib';
import { toArrayBuffer } from '../binary';
import { buildIncrementalUpdate, documentId, reserveObjectNumbers } from './appendUpdate';
import { recordChanges, type TouchFn } from './changeSet';
import { classifyIncrementalSave, type IncrementalClassification } from './incrementalClassify';
import { shouldCompact } from './compaction';
import { compareFingerprints, fingerprintDocument, type DocumentFingerprint } from './fingerprint';

// Everything one editing session needs to keep appending to one file.
//
// Held across saves rather than rebuilt, for two reasons that are really one:
// the pdf-lib context must not be reset between appends, because nextRef()
// draws from a counter that is the only thing stopping an object number
// collision; and the base bytes have to stay in step with what is actually on
// disk, because an append built against the wrong base produces a corrupt PDF
// rather than a lost edit.
export interface IncrementalSession {
	classification: IncrementalClassification;
	// The bytes currently on disk, as far as this session knows. Advanced
	// only by commitAppend, never optimistically.
	baseBytes: Uint8Array;
	// Offset of the newest cross-reference section in baseBytes, which is the
	// /Prev of the next one.
	xrefOffset: number;
	// What the file measured at the last time it was written whole, which is
	// what the compaction budget is a fraction *of*. Deliberately not
	// baseBytes.length: that grows with every append, so measuring against it
	// would inflate the denominator as the appendix accumulated and make
	// compaction steadily less likely — exactly backwards.
	compactedSize: number;
	id: [PDFObject, PDFObject] | null;
	// How much appendix has accumulated since the last full write, which is
	// what the compaction rule is measured against.
	appendedBytes: number;
	// Built but not yet known to be on disk. commitAppend folds it into
	// baseBytes; abandonIncremental throws it away.
	pending: Uint8Array | null;
	// Objects freed before any save happened — what
	// pruneOrphanedInklingAnnotations removed when the file was opened.
	// Opening a file the user only means to read must not modify it, so that
	// prune is carried by whatever save happens next rather than triggering
	// one of its own; on this path "carried" means these refs join the first
	// change set and get their free entries there.
	carriedFreed: Set<PDFRef>;
	// Once set, this session never appends again — it has lost track of what
	// is on disk, and a full rewrite is always correct.
	disabled: string | null;
}

export type SaveOutcome =
	| { mode: 'append'; appendix: Uint8Array; baseLength: number }
	| { mode: 'full'; bytes: Uint8Array };

export function beginIncrementalSession(
	bytes: Uint8Array,
	doc: PDFDocument,
	carriedFreed: Set<PDFRef> = new Set(),
): IncrementalSession {
	const classification = classifyIncrementalSave(bytes, doc);

	// Before any object of this session is allocated. See reserveObjectNumbers
	// for the fault this prevents — pdf-lib's own counter does not know about
	// the file's cross-reference stream, and an annotation numbered over it
	// makes a file only pdf-lib can read.
	if (classification.supported) reserveObjectNumbers(doc.context, classification.declaredSize);

	return {
		classification,
		baseBytes: bytes,
		xrefOffset: classification.supported ? classification.xrefOffset : 0,
		compactedSize: bytes.length,
		id: null,
		appendedBytes: 0,
		pending: null,
		carriedFreed,
		// A file the classifier declined is not "disabled" — disabled means
		// something went wrong mid-session. Both take the full path; keeping
		// them apart keeps the log honest about which happened.
		disabled: null,
	};
}

// Called after the write actually landed. Nothing else may advance the
// session's idea of what is on disk.
export function commitAppend(session: IncrementalSession): void {
	const pending = session.pending;
	session.pending = null;
	if (!pending || pending.length === 0) return;
	// Whole-file for both outcomes: an append stores base + appendix, a full
	// rewrite stores what it wrote. Either way this is now the file.
	session.baseBytes = pending;
}

// Give up the fast path for the rest of this session.
//
// Logged once per file per session, never per save, and never surfaced to the
// user. From the outside this is a save that takes as long as it used to.
function declineOnce(session: IncrementalSession, reason: string): void {
	if (session.disabled) return;
	session.disabled = reason;
	console.warn(`InklingExpanded: incremental save is off for this file — ${reason}`);
}

// The view's entry point, for a write that failed after the appendix was
// built. Discarding `pending` is the part that matters: the session must not
// advance its idea of what is on disk for a write that may not have landed.
export function abandonIncremental(session: IncrementalSession, reason: string): void {
	session.pending = null;
	declineOnce(session, reason);
}

async function fullSave(doc: PDFDocument, session: IncrementalSession, intended: DocumentFingerprint): Promise<SaveOutcome> {
	const bytes = await doc.save();

	// The existing guard, unchanged: reparsing the bytes we are about to hand
	// back is what makes a silent pdf-lib fault loud.
	//
	// updateMetadata: false because this parse is read-only; letting it stamp
	// a new ModDate would make the verification copy differ from the bytes
	// actually being written.
	const written = await PDFDocument.load(toArrayBuffer(bytes), { updateMetadata: false });
	const difference = compareFingerprints(intended, fingerprintDocument(written));
	if (difference) {
		// Thrown, never returned alongside the bytes: there must be no path
		// where a caller gets something back and has to decide whether to
		// trust it.
		throw new Error(`InklingExpanded: refusing to save, the PDF changed unexpectedly (${difference}).`);
	}

	// A compaction collapses the chain, so the next append starts over against
	// these bytes and this file's new last section. A full save also
	// discharges the carried prune: the objects it freed are simply not in the
	// file it just wrote.
	session.pending = bytes;
	session.appendedBytes = 0;
	session.compactedSize = bytes.length;
	session.carriedFreed.clear();

	const rescan = classifyIncrementalSave(bytes, written);
	session.classification = rescan;
	session.xrefOffset = rescan.supported ? rescan.xrefOffset : 0;
	if (rescan.supported) reserveObjectNumbers(doc.context, rescan.declaredSize);

	return { mode: 'full', bytes };
}

// One save. Mutates the document under the recorder, then either appends what
// changed or rewrites the whole file — and the caller cannot tell which it
// will get until it asks.
export async function saveIncrementally(
	doc: PDFDocument,
	session: IncrementalSession,
	mutate: (touch: TouchFn) => void,
): Promise<SaveOutcome> {
	// Recorded whatever path is taken: the change set costs nothing to collect
	// and the decision below can go either way.
	const changes = recordChanges(doc.context, mutate);

	// The prune that ran when the file was opened freed objects before any
	// change set existed. They belong to the first save that actually happens,
	// which is this one — without them the appended section would leave
	// orphans from past sessions reachable, and the prune would have achieved
	// nothing on this path.
	for (const ref of session.carriedFreed) {
		changes.written.delete(ref);
		changes.freed.add(ref);
	}

	// Fingerprinted *after* the mutation, because the mutated document is the
	// intended result — the thing the produced bytes are supposed to equal.
	// Our own annotations are excluded, so having just rewritten them does not
	// register as a change.
	const intended = fingerprintDocument(doc);

	if (session.disabled || !session.classification.supported) {
		if (!session.disabled && !session.classification.supported) declineOnce(session, session.classification.reason);
		return fullSave(doc, session, intended);
	}

	if (shouldCompact(session.compactedSize, session.appendedBytes)) {
		// Not a decline: the fast path stays available, and the save after
		// this one appends again against the compacted file.
		return fullSave(doc, session, intended);
	}

	const id = documentId(doc.context, session.id);
	let appendix: Uint8Array;
	try {
		appendix = buildIncrementalUpdate({
			context: doc.context,
			changes,
			style: session.classification.style,
			baseLength: session.baseBytes.length,
			prevXrefOffset: session.xrefOffset,
			id,
		});
	} catch (error) {
		declineOnce(session, `building the update failed: ${String(error)}`);
		return fullSave(doc, session, intended);
	}

	// Verification, in memory, before anything is written.
	//
	// The current path verifies after producing bytes and before handing them
	// to the vault, which works because a full write is a replacement:
	// declining to perform it costs nothing. An append has no such property.
	// Obsidian's API has no truncate, so once bytes are on the end of the file
	// undoing them means rewriting the whole document — the exact cost this
	// exists to avoid, incurred on the failure path, on a file that is invalid
	// at that moment.
	//
	// This parse is O(document) where the write and the upload are O(change),
	// and that is the trade the design accepted: it runs in the writer worker,
	// on the document the worker already holds, so none of it blocks the pen.
	const candidate = new Uint8Array(session.baseBytes.length + appendix.length);
	candidate.set(session.baseBytes, 0);
	candidate.set(appendix, session.baseBytes.length);

	let reparsed: PDFDocument;
	try {
		reparsed = await PDFDocument.load(toArrayBuffer(candidate), { updateMetadata: false });
		const difference = compareFingerprints(intended, fingerprintDocument(reparsed));
		if (difference) {
			declineOnce(session, `the appended file did not verify (${difference})`);
			return fullSave(doc, session, intended);
		}
	} catch (error) {
		declineOnce(session, `the appended file did not parse: ${String(error)}`);
		return fullSave(doc, session, intended);
	}

	// Where the section we just wrote begins, which is the /Prev of the next
	// one. Recomputed from the candidate by the same classifier the original
	// file went through, which also proves our own output passes that gate —
	// if it does not, the fast path would work exactly once and the second
	// append would chain onto something unreadable.
	const rescan = classifyIncrementalSave(candidate, reparsed);
	if (!rescan.supported) {
		declineOnce(session, `our own appended section did not classify (${rescan.reason})`);
		return fullSave(doc, session, intended);
	}

	session.id = id;
	session.pending = candidate;
	session.appendedBytes += appendix.length;
	session.xrefOffset = rescan.xrefOffset;
	// Discharged: the section just built carries their free entries.
	session.carriedFreed.clear();

	return { mode: 'append', appendix, baseLength: session.baseBytes.length };
}
