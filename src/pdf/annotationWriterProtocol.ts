import type { Annotation } from '../annotate/types';
import type { StructureProfile } from './compatibility';

// The message contract between the main thread (annotationWriterClient.ts)
// and annotationWriter.worker.ts. Kept as a separate types-only module so
// both sides import the same shapes without either needing to import the
// other's runtime code.

export interface OpenRequestMessage {
	type: 'open';
	requestId: number;
	bytes: ArrayBuffer;
}

export interface WriteRequestMessage {
	type: 'write';
	requestId: number;
	pages: { pageNumber: number; annotations: Annotation[] }[];
}

// The acknowledgement the append session needs. The worker's idea of what is
// on disk may only advance once the write has actually landed — a worker that
// advanced it optimistically would build the *next* append onto bytes that
// were never written, which is the corrupt-file case reached by our own hand.
export interface CommitRequestMessage {
	type: 'commit';
	requestId: number;
}

// After a write that failed, or one whose outcome the view cannot vouch for.
// The session stops appending for good and every later save is a full
// rewrite, which is always correct.
export interface AbandonRequestMessage {
	type: 'abandon';
	requestId: number;
	reason: string;
}

export type WorkerRequestMessage = OpenRequestMessage | WriteRequestMessage | CommitRequestMessage | AbandonRequestMessage;

interface OpenedOk {
	type: 'opened';
	requestId: number;
	ok: true;
	savedAnnotations: Map<number, Annotation[]>;
	// What pdf.js should render: the file with only Inkling's own
	// annotations stripped out (see stripInklingAnnotations), so its default
	// annotation-baking render still shows annotations from other PDF
	// software without doubling up with our own live overlay.
	displayBytes: ArrayBuffer;
	// pdf-lib's reading of the document's structure, and any feature it is
	// known to round-trip badly — the view compares the first against
	// pdf.js's own reading and opens read-only if they disagree. See
	// src/pdf/compatibility.ts.
	profile: StructureProfile;
	risky: string[];
	// Whether this file can be appended to rather than rewritten, which is
	// what the view's save cadence turns on.
	incremental: boolean;
	// See pageIdsOf in annotationWriterCore.ts.
	pageIds: string[];
}

// Discriminated, because the two outcomes go to different Vault calls and
// there must be no path where the view has to guess which it got.
interface WrittenOk {
	type: 'written';
	requestId: number;
	ok: true;
	outcome: { mode: 'full'; bytes: ArrayBuffer } | { mode: 'append'; appendix: ArrayBuffer; baseLength: number };
}

interface AcknowledgedOk {
	type: 'acknowledged';
	requestId: number;
	ok: true;
}

interface RequestFailed {
	type: 'opened' | 'written' | 'acknowledged';
	requestId: number;
	ok: false;
	error: string;
}

// Sent unprompted by the worker once its script has actually executed, not
// in reply to any request — hence no request id. The client waits for this
// before trusting the worker with real work, because a Worker that
// constructs without throwing is not by itself evidence that its script
// ever ran (see annotationWriterClient.ts's fallback).
export interface ReadyMessage {
	type: 'ready';
}

export type WorkerResponseMessage = OpenedOk | WrittenOk | AcknowledgedOk | RequestFailed | ReadyMessage;
