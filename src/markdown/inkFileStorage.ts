import { Notice } from 'obsidian';
import { createId } from '../annotate/id';
import { emptyInkBlock, type InkBlockData } from './inkBlockFormat';
import type { BlockRefusal, InkBlockStorage, StorageHost, StorageWriteResult } from './inkBlockStorage';
import type { InkFenceDamage, InkFenceRead } from './inkFence';
import { INK_FILE_VERSION } from './inkFile';
import {
	toFileBlock,
	toInkBlockData,
	type BlockBase,
	type BlockState,
	type InkFileStatus,
	type InkFileStore,
	type InkFileStores,
	type StoreChange,
	type WriteRefusal,
} from './inkFileStore';

// A block whose strokes live in an ink file. Saving writes one block of that
// file through the store every block naming it shares; the note is never
// touched, so none of the in-note path's fence search, merge into the note,
// or scroll restoration exists here.

// A save that failed for a reason that may pass — the vault threw, or the file
// kept changing — is tried again this many times before the drawing is only
// held.
const FAILED_SAVE_RETRY_MS = 2000;
const FAILED_SAVE_RETRIES = 3;

function fenceMessage(reason: InkFenceDamage): string {
	switch (reason) {
		case 'missing-file':
			return 'This ink block does not say which ink file holds its drawing, so it cannot be shown or saved. Its fence needs a "file:" line.';
		case 'missing-id':
			return 'This ink block does not say which drawing in its ink file is its own, so it cannot be shown or saved. Its fence needs an "id:" line.';
		case 'duplicate-key':
			return 'This ink block names its ink file or its id twice, so InklingExpanded cannot tell which is meant and will not save it.';
		case 'not-a-vault-path':
			return 'This ink block names an ink file outside the vault or in a hidden folder, so it cannot be shown or saved.';
	}
}

function refusalFor(status: InkFileStatus, state: BlockState, path: string): BlockRefusal | null {
	switch (status.kind) {
		case 'absent':
			return { message: `InklingExpanded cannot find the ink file ${path}, so this block will not be saved. Anything drawn here is held on this device.` };
		case 'from-future':
			return {
				message: `The ink file ${path} was written by a newer version of InklingExpanded (format ${status.version}; this version reads format ${INK_FILE_VERSION}), so this block will not be saved over it. Update InklingExpanded to edit it.`,
			};
		case 'damaged':
			return { message: `InklingExpanded could not read the ink file ${path}, so this block will not be saved over it.` };
		case 'loading':
		case 'readable':
			break;
	}
	switch (state.kind) {
		case 'absent':
			return { message: `The ink file ${path} holds no drawing for this block, so it will not be saved.` };
		case 'undecodable':
			return { message: `InklingExpanded could not read this block's drawing in ${path}, so it will not be saved over it. The file's other drawings are unaffected.` };
		case 'unsupported':
			return { message: `This block's drawing is stored with ${state.codec} compression, which this device cannot read, so it will not be saved over it.` };
		case 'decoded':
			return null;
	}
}

export class InkFileStorage implements InkBlockStorage {
	readonly rescuePath: string;
	readonly blockId: string;
	private host: StorageHost | null = null;
	private store: InkFileStore | null = null;
	private unsubscribe: (() => void) | null = null;
	// The block as this view last put it on screen, and the revision that was.
	// A save based on a revision the store has moved past is merged — and a
	// merged result this view could not show leaves this unchanged, so the
	// next merge does not read the other side's strokes as erasures.
	private base: BlockBase | null = null;
	private strokes = '';
	private shown = false;
	private refusalShown: string | null = null;
	// A save refused because the block could not be written. Tried again as
	// soon as it can be.
	private waitingToSave = false;
	private failedSaves = 0;
	private closed = false;

	constructor(
		private readonly stores: InkFileStores,
		private readonly fence: InkFenceRead,
	) {
		this.rescuePath = fence.kind === 'fence' ? fence.fence.file : '';
		this.blockId = fence.kind === 'fence' ? fence.fence.id : createId();
	}

	rescueSource(): string {
		return this.strokes;
	}

	open(host: StorageHost): void {
		this.host = host;
		if (this.fence.kind === 'damaged') {
			host.refuse({ message: fenceMessage(this.fence.reason) });
			host.show(emptyInkBlock());
			return;
		}
		const store = this.stores.acquire(this.fence.fence.file);
		this.store = store;
		this.unsubscribe = store.subscribe((change, origin) => this.storeChanged(change, origin));
		void store.load().then(() => this.reflect());
	}

	async write(data: InkBlockData): Promise<StorageWriteResult> {
		const store = this.store;
		if (!store || !this.base) return { kind: 'held' };

		const outcome = await store.updateBlock(this.blockId, this, toFileBlock(data), this.base);
		if (outcome.kind === 'written') {
			this.failedSaves = 0;
			// A merged result goes on screen in afterWrite, when the view can
			// take it; until then the base stays what the screen shows.
			if (!outcome.merged) {
				this.base = { block: outcome.block, revision: outcome.revision };
				const state = store.blockState(this.blockId);
				if (state.kind === 'decoded' && state.revision === outcome.revision) this.strokes = state.strokes;
			}
			return { kind: 'saved' };
		}
		return this.refused(outcome.reason);
	}

	afterWrite(): void {
		this.reflect();
	}

	heldWhileRefused(): void {
		this.waitingToSave = true;
	}

	close(): void {
		this.closed = true;
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.store) this.stores.release(this.store.path);
		this.host = null;
	}

	private storeChanged(change: StoreChange, origin: object | null): void {
		// This block's own save; write() has already dealt with it.
		if (origin === this) return;
		if (change !== 'all' && !change.has(this.blockId)) return;
		this.reflect();
	}

	// Makes the block show what the store holds for it, or why it cannot.
	private reflect(): void {
		const host = this.host;
		const store = this.store;
		if (this.closed || !host || !store) return;
		const status = store.status();
		if (status.kind === 'loading') return;
		const state = store.blockState(this.blockId);

		const refusal = refusalFor(status, state, store.path);
		if (refusal) {
			if (!host.isRefused() || this.refusalShown !== refusal.message) host.refuse(refusal);
			this.refusalShown = refusal.message;
			if (!this.shown) {
				this.shown = true;
				host.show(emptyInkBlock());
			}
			return;
		}
		if (state.kind !== 'decoded') return;

		if (host.isRefused()) {
			host.lift();
			this.refusalShown = null;
		}

		if (this.base?.revision !== state.revision) {
			const previous = this.strokes;
			// Set first: the view compares a rescued drawing against it the
			// first time it is shown something.
			this.strokes = state.strokes;
			if (host.show(toInkBlockData(state.block, this.blockId))) {
				this.shown = true;
				this.base = { block: state.block, revision: state.revision };
			} else {
				this.strokes = previous;
				// The view has ink the file does not, and would not take the
				// file's version over it. Saving now merges the two, where
				// waiting could leave a held drawing waiting for good.
				host.scheduleWrite();
			}
		}

		if (this.waitingToSave && this.base) {
			this.waitingToSave = false;
			host.scheduleWrite();
		}
	}

	private refused(reason: WriteRefusal): StorageWriteResult {
		switch (reason) {
			case 'not-writable':
			case 'block-absent':
			case 'block-unreadable':
			case 'block-exists':
				// The banner says why, once reflect has seen what the store saw.
				this.waitingToSave = true;
				this.reflect();
				return { kind: 'held' };
			case 'failed':
			case 'moved-on':
			case 'encoding-mismatch':
			case 'no-blocks-over-blocks':
				this.failedSaves += 1;
				if (this.failedSaves <= FAILED_SAVE_RETRIES && reason !== 'encoding-mismatch') {
					return { kind: 'retry', afterMs: FAILED_SAVE_RETRY_MS };
				}
				if (this.failedSaves === FAILED_SAVE_RETRIES + 1 || reason === 'encoding-mismatch') {
					console.error(`InklingExpanded: could not save ink block ${this.blockId} to ${this.rescuePath} (${reason}). The drawing is held on this device.`);
					new Notice('InklingExpanded: could not save this ink block to its ink file. Your drawing is still on screen and is held on this device.');
				}
				return { kind: 'held' };
		}
	}
}
