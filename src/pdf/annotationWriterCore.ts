import { PDFDocument } from 'pdf-lib';
import type { Annotation } from '../annotate/types';
import { pruneOrphanedInklingAnnotations, readInklingAnnotations, stripInklingAnnotations, writeInklingAnnotations } from './annotationSync';
import { profileFromPdfLib, riskyFeatures, type StructureProfile } from './compatibility';
import { recordChanges } from './changeSet';
import {
	abandonIncremental,
	beginIncrementalSession,
	commitAppend,
	saveIncrementally,
	type IncrementalSession,
	type SaveOutcome,
} from './incrementalSave';

// The actual pdf-lib work, with no worker plumbing around it, so the exact
// same code can run either off the main thread (annotationWriter.worker.ts,
// the preferred path — see its comment for why) or directly on it
// (annotationWriterClient.ts's fallback, for environments where a Worker
// can't be constructed or never starts at all; desktop Obsidian turned out
// to be one).

export interface OpenedDocument {
	// Kept by the caller and passed back to writeDocument below, so repeated
	// saves reuse this parse instead of re-reading the whole file each time.
	doc: PDFDocument;
	savedAnnotations: Map<number, Annotation[]>;
	// What pdf.js should render: the file with only InklingExpanded's own annotations
	// stripped out, so its annotation-baking render still shows annotations
	// from other PDF software without doubling up with our live overlay.
	displayBytes: ArrayBuffer;
	// pdf-lib's own reading of the document's structure, for the view to
	// check against pdf.js's — see src/pdf/compatibility.ts.
	profile: StructureProfile;
	// Document features pdf-lib is known to round-trip badly, named for a
	// notice. Empty for almost every real book.
	risky: string[];
	// The append state for this file, held for the life of the editing
	// session and handed back to writeDocument on every save. See
	// incrementalSave.ts for why it cannot be rebuilt per save.
	session: IncrementalSession;
	// Whether this file took the fast path, for the view's save cadence.
	incremental: boolean;
	// Each page's object in the file, by page index: who a page is, however
	// its number changes — see pageIdsOf.
	pageIds: string[];
}

// A page's identity across saves and devices. Its number is not one: a page
// added before it, or one deleted, moves it. Its object number in the file
// is — pdf-lib keeps every existing object's number when it saves, and gives
// new pages new ones — so a change from another device can be matched up
// page for page, whatever was added or deleted meanwhile.
export function pageIdsOf(doc: PDFDocument): string[] {
	return doc.getPages().map((page) => `${page.ref.objectNumber}.${page.ref.generationNumber}`);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function openDocument(bytes: ArrayBuffer): Promise<OpenedDocument> {
	const doc = await PDFDocument.load(bytes);

	const savedAnnotations = new Map<number, Annotation[]>();
	for (let index = 0; index < doc.getPageCount(); index++) {
		const annotations = readInklingAnnotations(doc, index);
		if (annotations.length > 0) savedAnnotations.set(index + 1, annotations);
	}

	// Orphans left by past sessions are pruned in memory and carried by
	// whatever save happens next, rather than triggering a write of their
	// own. Opening a file the user only means to read must not modify it —
	// a standalone write here is a full pdf-lib round trip and, under a
	// live-replicating sync, a full re-upload, neither of which the user
	// asked for by opening a book. The return value is ignored: there is
	// nothing to do differently either way now that the document in memory
	// is already correct.
	//
	// Run under the recorder rather than bare. On the incremental path the
	// objects it frees need free entries in the first section we append —
	// otherwise the prune corrects the document in memory and leaves the file
	// exactly as bloated as it was.
	const pruned = recordChanges(doc.context, () => {
		pruneOrphanedInklingAnnotations(doc);
	});

	// A second, independent parse of the same bytes — only worth it (and its
	// own save()) when this file actually has InklingExpanded annotations to strip
	// out; otherwise the original bytes are already exactly the right display
	// copy. `bytes` is safe to re-read here since nothing above mutated or
	// transferred it away — pdf-lib doesn't detach the buffers it parses.
	let displayBytes: ArrayBuffer;
	if (savedAnnotations.size > 0) {
		const displayDoc = await PDFDocument.load(bytes);
		stripInklingAnnotations(displayDoc);
		displayBytes = toArrayBuffer(await displayDoc.save());
	} else {
		displayBytes = bytes.slice(0);
	}

	// A view over the caller's buffer, not a copy. `bytes` came in over
	// postMessage and nothing else retains it once this returns — displayBytes
	// above is either its own slice or a fresh save — so a second copy would
	// be 40 MB of a large book held for nothing. This is the reference that
	// has to stay in step with what is on disk.
	//
	// A file the classifier declines is not logged here. incrementalSave's own
	// declineOnce says so at the first save that actually happens — once per
	// file per session, never per save, and never surfaced to the user — and
	// saying it twice would be noise in a console the user may be reading for
	// something else.
	const session = beginIncrementalSession(new Uint8Array(bytes), doc, pruned.freed);

	return {
		doc,
		savedAnnotations,
		displayBytes,
		profile: profileFromPdfLib(doc),
		risky: riskyFeatures(doc),
		session,
		incremental: session.classification.supported,
		pageIds: pageIdsOf(doc),
	};
}

// One save, which may be an append or a full rewrite — and the caller is told
// which rather than being allowed to assume.
//
// Verification has moved inside saveIncrementally, ahead of the write,
// because an append cannot be undone: Obsidian's API has no truncate, so
// bytes on the end of the file stay there. The same fingerprint comparison
// runs either way; what changed is only *when*.
export async function writeDocument(
	doc: PDFDocument,
	session: IncrementalSession,
	pages: { pageNumber: number; annotations: Annotation[] }[],
): Promise<SaveOutcome> {
	return saveIncrementally(doc, session, (touch) => {
		for (const { pageNumber, annotations } of pages) {
			writeInklingAnnotations(doc, pageNumber - 1, annotations, touch);
		}
	});
}

// Re-exported so the worker and the main-thread fallback import every piece
// of their work from one module.
export { abandonIncremental, commitAppend };
export type { IncrementalSession, SaveOutcome };
