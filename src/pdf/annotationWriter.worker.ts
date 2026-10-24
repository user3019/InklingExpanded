import type { PDFDocument } from 'pdf-lib';
import {
	abandonIncremental,
	commitAppend,
	openDocument,
	toArrayBuffer,
	writeDocument,
	type IncrementalSession,
} from './annotationWriterCore';
import type { WorkerRequestMessage, WorkerResponseMessage } from './annotationWriterProtocol';

// Runs pdf-lib's parse/mutate/save entirely off the main thread. pdf-lib's
// save() is a full-document re-serialize with no true incremental mode —
// for a densely annotated PDF that's real, sustained CPU work (seconds, on
// a page thick with strokes), and running it on the main thread stalled
// pointer input for that whole stretch, felt directly as "the pen won't
// write." One worker instance == one open file's PDFDocument for the life
// of an InklingExpanded editing session (PdfAnnotateView terminates it and spawns a
// fresh one for the next file, rather than juggling several documents in
// here) — so `doc` staying alive across multiple 'write' messages also
// avoids re-parsing the whole file from scratch on every autosave.
//
// The actual work lives in annotationWriterCore.ts, shared with the main-
// thread fallback in annotationWriterClient.ts — see there for why a
// fallback is needed at all.
let doc: PDFDocument | null = null;
// The append state for the open file, alongside the document itself and for
// the same reason: neither may be rebuilt between saves.
let session: IncrementalSession | null = null;

function reply(message: WorkerResponseMessage, transfer: Transferable[] = []): void {
	(self as unknown as Worker).postMessage(message, transfer);
}

self.onmessage = async (event: MessageEvent<WorkerRequestMessage>) => {
	const message = event.data;

	if (message.type === 'open') {
		try {
			const opened = await openDocument(message.bytes);
			doc = opened.doc;
			session = opened.session;

			reply(
				{
					type: 'opened',
					requestId: message.requestId,
					ok: true,
					savedAnnotations: opened.savedAnnotations,
					displayBytes: opened.displayBytes,
					profile: opened.profile,
					risky: opened.risky,
					incremental: opened.incremental,
					pageIds: opened.pageIds,
				},
				[opened.displayBytes],
			);
		} catch (error) {
			reply({ type: 'opened', requestId: message.requestId, ok: false, error: String(error) });
		}
		return;
	}

	if (!doc || !session) {
		const type = message.type === 'write' ? 'written' : 'acknowledged';
		reply({ type, requestId: message.requestId, ok: false, error: 'InklingExpanded: no document open in the annotation writer.' });
		return;
	}

	// Told only after the write has actually landed. Nothing else may advance
	// the session's idea of what is on disk.
	if (message.type === 'commit') {
		commitAppend(session);
		reply({ type: 'acknowledged', requestId: message.requestId, ok: true });
		return;
	}

	if (message.type === 'abandon') {
		abandonIncremental(session, message.reason);
		reply({ type: 'acknowledged', requestId: message.requestId, ok: true });
		return;
	}

	try {
		const outcome = await writeDocument(doc, session, message.pages);
		// Transferred, not copied: a full rewrite of a large book is the whole
		// file, and structured-cloning it would cost as much as the save. An
		// appendix is small enough that it hardly matters, but both paths
		// transfer alike so neither can drift.
		if (outcome.mode === 'full') {
			const bytes = toArrayBuffer(outcome.bytes);
			reply({ type: 'written', requestId: message.requestId, ok: true, outcome: { mode: 'full', bytes } }, [bytes]);
		} else {
			const appendix = toArrayBuffer(outcome.appendix);
			reply(
				{
					type: 'written',
					requestId: message.requestId,
					ok: true,
					outcome: { mode: 'append', appendix, baseLength: outcome.baseLength },
				},
				[appendix],
			);
		}
	} catch (error) {
		reply({ type: 'written', requestId: message.requestId, ok: false, error: String(error) });
	}
};

// Sent unprompted, as the last thing this script does: the client waits a
// short while for exactly this before trusting the worker with any real
// work, and falls back to running everything on the main thread if it never
// arrives. Desktop Obsidian turned out to need that — a worker there can be
// constructed without error and then never run its script at all, so
// "constructed successfully" is not on its own evidence of a live worker.
reply({ type: 'ready' });
