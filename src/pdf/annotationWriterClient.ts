import type { PDFDocument } from 'pdf-lib';
import type { Annotation } from '../annotate/types';
import type { StructureProfile } from './compatibility';
import {
	abandonIncremental,
	commitAppend,
	openDocument,
	toArrayBuffer,
	writeDocument,
	type IncrementalSession,
} from './annotationWriterCore';
import type { WorkerResponseMessage } from './annotationWriterProtocol';

// Supplies annotationWriter.worker.ts's bundled output as source text, which
// main.js carries embedded (see main.ts's configureAnnotationWriterWorker and
// esbuild.config.mjs). Deliberately the source, not a
// URL: desktop Obsidian serves plugin files from a per-vault origin
// (`app://<vaultId>`) distinct from the main window's (`app://obsidian.md`),
// and constructing a Worker from a script on that other origin throws
// SecurityError outright — for a classic worker just as much as a module
// one, so it isn't a module-only restriction to dodge by changing bundle
// format. Building the worker from a same-origin blob: URL containing the
// code itself sidesteps the cross-origin question entirely, with no
// dynamic import of a foreign URL involved either.
//
// A provider rather than the text itself so tests can hand in their own, and
// so nothing is turned into a blob until someone actually annotates
// something; cached below after the first call. A module singleton because
// PdfAnnotateView, which needs this, has no handle on the Plugin instance
// to resolve it itself.
let sourceProvider: (() => Promise<string>) | null = null;
let cachedSource: string | null = null;

export function setAnnotationWriterWorkerSourceProvider(provider: () => Promise<string>): void {
	sourceProvider = provider;
}

export interface OpenResult {
	savedAnnotations: Map<number, Annotation[]>;
	displayBytes: ArrayBuffer;
	profile: StructureProfile;
	risky: string[];
	// Whether this file can be appended to rather than rewritten. The view
	// scales its save cadence on it, and pairs it with a feature check for
	// Vault.appendBinary — which this side of the wire cannot see.
	incremental: boolean;
	// Each page's identity in the file, by index — see pageIdsOf in
	// annotationWriterCore.ts.
	pageIds: string[];
}

// What a save produced. The two go to different Vault calls, so the view is
// told which it got rather than left to guess.
export type WriteOutcome =
	| { mode: 'full'; bytes: ArrayBuffer }
	| { mode: 'append'; appendix: ArrayBuffer; baseLength: number };

export interface WritePage {
	pageNumber: number;
	annotations: Annotation[];
}

// A request that never gets a reply would otherwise hang forever, which is
// exactly what "opens to a black page area that never loads" turned out to
// be. Generous on purpose: a legitimately slow save (see
// annotationWriterCore.ts on pdf-lib's cost) should still be allowed to
// finish rather than being mistaken for a hang.
const REQUEST_TIMEOUT_MS = 30000;

// How long to wait for the worker's unprompted 'ready' before giving up on
// it and running everything on the main thread instead. Short, because
// nothing can be drawn until this resolves — and because a worker that is
// going to start at all starts promptly; the failure mode this guards
// against isn't slowness, it's a worker that never runs its script at all.
const WORKER_READY_TIMEOUT_MS = 3000;

type Mode = 'worker' | 'main';

// Thin promise-based wrapper around annotationWriter.worker.ts — one
// instance per open editing session (see PdfAnnotateView), so the worker on
// the other end never has to juggle more than one file's pdf-lib document.
//
// Prefers running that work off the main thread, but transparently falls
// back to running it here when a worker can't be brought up. pdf.js does
// the same thing for its own worker (PDFWorker._setupFakeWorker in
// pdfjs-dist) and that fallback is the only reason PDFs render at all in
// desktop Obsidian, where workers built from plugin resource paths fail —
// silently, in the observed case: constructed with no error thrown, no
// error event, and no script execution. Without a fallback of our own,
// that left every request waiting on a reply that could never come.
export class AnnotationWriterClient {
	private worker: Worker | null = null;
	private blobUrl: string | null = null;
	private nextRequestId = 1;
	private readonly pending = new Map<number, { resolve: (value: never) => void; reject: (error: unknown) => void; timeout: number }>();
	// Resolved once, on first use, to whichever mode actually works here —
	// memoized so a session pays the readiness wait at most once.
	private mode: Promise<Mode> | null = null;
	// Main-thread mode's equivalent of the worker's own long-lived document:
	// parsed by open(), reused by every later write() (see openDocument).
	private mainDoc: PDFDocument | null = null;
	// Its append state, held for exactly as long as the document is.
	private mainSession: IncrementalSession | null = null;
	private terminated = false;

	async open(bytes: ArrayBuffer): Promise<OpenResult> {
		if (this.terminated) throw new Error('InklingExpanded: annotation writer is no longer usable.');

		if ((await this.ensureMode()) === 'main') {
			const opened = await openDocument(bytes);
			this.mainDoc = opened.doc;
			this.mainSession = opened.session;
			return {
				savedAnnotations: opened.savedAnnotations,
				displayBytes: opened.displayBytes,
				profile: opened.profile,
				risky: opened.risky,
				incremental: opened.incremental,
				pageIds: opened.pageIds,
			};
		}

		const requestId = this.nextRequestId++;
		const promise = this.awaitResponse<OpenResult>(requestId);
		this.worker?.postMessage({ type: 'open', requestId, bytes }, [bytes]);
		return promise;
	}

	async write(pages: WritePage[]): Promise<WriteOutcome> {
		if (this.terminated) throw new Error('InklingExpanded: annotation writer is no longer usable.');

		if ((await this.ensureMode()) === 'main') {
			if (!this.mainDoc || !this.mainSession) throw new Error('InklingExpanded: no document open in the annotation writer.');
			const outcome = await writeDocument(this.mainDoc, this.mainSession, pages);
			return outcome.mode === 'full'
				? { mode: 'full', bytes: toArrayBuffer(outcome.bytes) }
				: { mode: 'append', appendix: toArrayBuffer(outcome.appendix), baseLength: outcome.baseLength };
		}

		const requestId = this.nextRequestId++;
		const promise = this.awaitResponse<WriteOutcome>(requestId);
		this.worker?.postMessage({ type: 'write', requestId, pages });
		return promise;
	}

	// Told only after the write has actually landed. Nothing else may advance
	// the session's idea of what is on disk — a session that advanced
	// optimistically would build the next append onto bytes that were never
	// written, and land it at the wrong offset entirely.
	async commit(): Promise<void> {
		if (this.terminated) return;
		if ((await this.ensureMode()) === 'main') {
			if (this.mainSession) commitAppend(this.mainSession);
			return;
		}
		const requestId = this.nextRequestId++;
		const promise = this.awaitResponse<void>(requestId);
		this.worker?.postMessage({ type: 'commit', requestId });
		return promise;
	}

	// After a write that failed, or one whose outcome we cannot vouch for. The
	// session gives up appending for good and every later save is a full
	// rewrite, which is always correct.
	async abandon(reason: string): Promise<void> {
		if (this.terminated) return;
		if ((await this.ensureMode()) === 'main') {
			if (this.mainSession) abandonIncremental(this.mainSession, reason);
			return;
		}
		const requestId = this.nextRequestId++;
		const promise = this.awaitResponse<void>(requestId);
		this.worker?.postMessage({ type: 'abandon', requestId, reason });
		return promise;
	}

	terminate(): void {
		this.terminated = true;
		this.disposeWorker();
		this.mainDoc = null;
		this.mainSession = null;
		this.failPending(new Error('InklingExpanded: annotation writer terminated.'));
	}

	// Brings up the worker and waits for it to prove it's alive, falling back
	// to main-thread mode on any failure — including the silent one where the
	// worker constructs fine and simply never runs. Memoized: every later
	// call reuses this same decision.
	private ensureMode(): Promise<Mode> {
		this.mode ??= this.resolveMode();
		return this.mode;
	}

	private async resolveMode(): Promise<Mode> {
		try {
			if (!sourceProvider) throw new Error('InklingExpanded: annotation writer worker source was never configured.');
			cachedSource ??= await sourceProvider();

			this.blobUrl = URL.createObjectURL(new Blob([cachedSource], { type: 'text/javascript' }));
			const worker = new Worker(this.blobUrl);
			this.worker = worker;

			const ready = new Promise<void>((resolve, reject) => {
				const timeout = window.setTimeout(
					() => reject(new Error('InklingExpanded: annotation writer worker never started.')),
					WORKER_READY_TIMEOUT_MS,
				);
				worker.onmessage = (event: MessageEvent<WorkerResponseMessage>) => {
					if (event.data.type === 'ready') {
						window.clearTimeout(timeout);
						// Handled from here on by the real dispatcher below.
						worker.onmessage = (later: MessageEvent<WorkerResponseMessage>) => this.handleMessage(later.data);
						resolve();
						return;
					}
					this.handleMessage(event.data);
				};
				worker.onerror = (event) => {
					window.clearTimeout(timeout);
					reject(new Error(`InklingExpanded: annotation writer worker failed to start. ${event.message}`));
				};
			});

			await ready;

			// terminate() may have landed while the above was still waiting
			// (a fast file switch) — it can't dispose a worker this hadn't
			// finished creating yet, so don't leave one running behind it.
			if (this.terminated) {
				this.disposeWorker();
				return 'main';
			}

			// Only meaningful once the worker is known good: from here a crash
			// should fail in-flight requests rather than let them time out.
			worker.onerror = (event) => {
				console.error('InklingExpanded: annotation writer worker crashed.', event);
				this.disposeWorker();
				this.failPending(new Error('InklingExpanded: annotation writer worker crashed.'));
			};

			return 'worker';
		} catch (error) {
			// Not a user-facing failure: everything still works, just on the
			// main thread, so saving a heavily annotated page can briefly stall
			// input where it otherwise wouldn't.
			console.warn('InklingExpanded: annotation writer worker unavailable, falling back to the main thread.', error);
			this.disposeWorker();
			return 'main';
		}
	}

	private disposeWorker(): void {
		this.worker?.terminate();
		this.worker = null;
		if (this.blobUrl) {
			URL.revokeObjectURL(this.blobUrl);
			this.blobUrl = null;
		}
	}

	private failPending(error: unknown): void {
		for (const { reject, timeout } of this.pending.values()) {
			window.clearTimeout(timeout);
			reject(error);
		}
		this.pending.clear();
	}

	private awaitResponse<T>(requestId: number): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timeout = window.setTimeout(() => {
				this.pending.delete(requestId);
				reject(new Error('InklingExpanded: annotation writer timed out.'));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(requestId, { resolve, reject, timeout });
		});
	}

	private handleMessage(message: WorkerResponseMessage): void {
		if (message.type === 'ready') return;

		const entry = this.pending.get(message.requestId);
		if (!entry) return;
		this.pending.delete(message.requestId);
		window.clearTimeout(entry.timeout);

		if (!message.ok) {
			entry.reject(new Error(message.error));
		} else if (message.type === 'opened') {
			entry.resolve({
				savedAnnotations: message.savedAnnotations,
				displayBytes: message.displayBytes,
				profile: message.profile,
				risky: message.risky,
				incremental: message.incremental,
				pageIds: message.pageIds,
			} as never);
		} else if (message.type === 'written') {
			entry.resolve(message.outcome as never);
		} else {
			// An acknowledgement carries nothing; the caller only waits on it
			// so a commit cannot race the next save.
			entry.resolve(undefined as never);
		}
	}
}
