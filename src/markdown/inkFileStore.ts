import { INK_BLOCK_VERSION, type InkBlockData } from './inkBlockFormat';
import { decodeStrokes } from './inkFileCodec';
import {
	byteLength,
	isRecord,
	parseInkFile,
	readInkFileBlock,
	serializeInkFile,
	writeInkFileBlock,
	type BlockRead,
	type InkFileBlock,
	type InkFileContents,
} from './inkFile';
import { mergeInkBlocks } from './mergeInkBlocks';

// One live ink file, shared by every block that names it.
//
// It reads the file, holds the last parse that succeeded, tells blocks when
// something they show has changed, and — see the write half below — queues
// every write to the file one after another. Everything that changes what
// the store holds runs through that one queue, reads included, so an
// external change and a save can never interleave halfway through either.
//
// Pure of Obsidian: the file is reached through InkFileIO, which the plugin
// implements over the Vault (inkFileVaultIO.ts) and the tests over a Map.

export interface InkFileIO {
	/** The file's text, or null when there is no file at `path`. */
	read(path: string): Promise<string | null>;
	/**
	 * Writes `next` only if the file still reads `expected` (null: only if it
	 * does not exist, creating it). The comparison and the write are one
	 * operation, so a change landing between them cannot be overwritten.
	 */
	replaceIf(path: string, expected: string | null, next: string): Promise<ReplaceResult>;
	/** The file's size on disk in bytes, or null when that cannot be known. */
	size(path: string): Promise<number | null>;
}

export type ReplaceResult = { written: true } | { written: false; found: string | null };

export type InkFileStatus =
	| { kind: 'loading' }
	| { kind: 'readable' }
	// No file at this path. Blocks already held are kept, not forgotten: they
	// may be the only copy there is.
	| { kind: 'absent' }
	| { kind: 'from-future'; version: number }
	// Unreadable, with no good parse held from earlier in the session.
	| { kind: 'damaged' };

export type BlockState =
	| { kind: 'decoded'; block: InkFileBlock; revision: number; strokes: string }
	| { kind: 'undecodable' }
	| { kind: 'unsupported'; codec: string }
	| { kind: 'absent' };

export type StoreChange = ReadonlySet<string> | 'all';
// `origin` is whoever caused the change — a block's own storage for its own
// save, null for anything that came from the file.
export type StoreListener = (change: StoreChange, origin: object | null) => void;

// What a block last put on screen: the data, and the revision it came from.
export interface BlockBase {
	block: InkFileBlock;
	revision: number;
}

export type WriteRefusal =
	// The file is absent, from the future, damaged, or not what was last read
	// and unreadable now.
	| 'not-writable'
	| 'block-absent'
	| 'block-unreadable'
	| 'block-exists'
	// The encoded block did not decode back to what was encoded.
	| 'encoding-mismatch'
	| 'no-blocks-over-blocks'
	// The file kept changing underneath every attempt.
	| 'moved-on'
	| 'failed';

export type WriteOutcome =
	| { kind: 'written'; block: InkFileBlock; revision: number; merged: boolean }
	| { kind: 'refused'; reason: WriteRefusal };

// A save that finds the file changed goes round again, merging. More than a
// few in a row is not a race, it is something rewriting the file constantly,
// and the drawing is safer held than chasing it.
const MAX_WRITE_ATTEMPTS = 3;
// A read that threw is tried again after 2s, then 4s, then 6s.
const READ_RETRY_MS = 2000;
const READ_RETRIES = 3;

function refused(reason: WriteRefusal): WriteOutcome {
	return { kind: 'refused', reason };
}

// The in-note block's shape, which is what the merge and the rescue store
// already speak.
export function toInkBlockData(block: InkFileBlock, id?: string): InkBlockData {
	return {
		version: INK_BLOCK_VERSION,
		...(id ? { id } : {}),
		width: block.width,
		height: block.height,
		...(block.caption ? { caption: block.caption } : {}),
		annotations: block.annotations,
	};
}

export function toFileBlock(data: InkBlockData): InkFileBlock {
	return {
		width: data.width,
		height: data.height,
		...(data.caption?.trim() ? { caption: data.caption.trim() } : {}),
		// A copy of the list: the store holds this as the block's base, and
		// must not see a live array change underneath it.
		annotations: [...data.annotations],
	};
}

interface PendingUpdate {
	id: string;
	writer: object;
	data: InkFileBlock;
	base: BlockBase;
	waiters: Array<(outcome: WriteOutcome) => void>;
}

interface HeldBlock {
	read: BlockRead;
	// The block exactly as the file held it, serialized, which is how a
	// re-read tells a block that changed from one that did not without
	// decoding either.
	json: string;
	// Changes whenever the block does. See the write half: a save merges
	// whenever the revision it was based on is not the one held.
	revision: number;
}

interface LastSave {
	block: InkFileBlock;
	revision: number;
	merged: boolean;
}


export class InkFileStore {
	private current: InkFileStatus = { kind: 'loading' };
	// The last parse that succeeded, blocks still raw. Null until one has.
	private contents: InkFileContents | null = null;
	private readonly held = new Map<string, HeldBlock>();
	// The file's text as last read or written; null when there was no file.
	// A save writes only over exactly this.
	private lastText: string | null = null;
	private revisions = 0;
	private readonly listeners = new Set<StoreListener>();
	private tail: Promise<unknown> = Promise.resolve();
	private loading: Promise<void> | null = null;
	// Saves queued and not yet started, so a later save from the same block
	// can take the place of an earlier one rather than follow it.
	private readonly pending: PendingUpdate[] = [];
	// The first write after the file is opened is read back and parsed. A file
	// that was already wrong shows it there; after that, a size check is enough.
	private verifyNextWrite = true;
	// What each writer last saved of each block, at the revision that save
	// made. A writer's next save may name an older base than that — it began
	// while that save was still running, or that save was merged and the view
	// could not show the result — and merging against the older base would
	// read a stroke from that save the user has since erased as one added
	// elsewhere, and put it back.
	// Reads in a row that threw, for spacing out the tries after them.
	private failedReads = 0;
	private readonly lastSaved =new WeakMap<object, Map<string, LastSave>>();

	constructor(
		readonly path: string,
		private readonly io: InkFileIO,
	) {}

	status(): InkFileStatus {
		return this.current;
	}

	load(): Promise<void> {
		this.loading ??= this.enqueue(() => this.readFromDisk());
		return this.loading;
	}

	/** Settles once everything queued so far has run. */
	async whenIdle(): Promise<void> {
		await this.tail;
	}

	blockState(id: string): BlockState {
		const held = this.held.get(id);
		if (!held) return { kind: 'absent' };
		if (held.read.kind !== 'decoded') return held.read;
		return { kind: 'decoded', block: held.read.block, revision: held.revision, strokes: this.strokesOf(id) };
	}

	subscribe(listener: StoreListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	fileChanged(): void {
		void this.enqueue(() => this.readFromDisk());
	}

	fileDeleted(): void {
		void this.enqueue(() => this.adopt(null, null));
	}

	/**
	 * Saves one block. `writer` is whoever is saving — one block view — and
	 * `base` is the block as that writer last showed it. When the store holds a
	 * different revision by the time the save runs, the three are merged.
	 */
	updateBlock(id: string, writer: object, data: InkFileBlock, base: BlockBase): Promise<WriteOutcome> {
		const queued = this.pending.find((update) => update.id === id && update.writer === writer);
		if (queued) {
			// Collapsed into the later save. Only for the same writer: two blocks
			// showing one drawing are two sets of strokes, and both must land.
			queued.data = data;
			queued.base = base;
			return new Promise((resolve) => queued.waiters.push(resolve));
		}

		const update: PendingUpdate = { id, writer, data, base, waiters: [] };
		this.pending.push(update);
		return this.enqueue(async () => {
			this.pending.splice(this.pending.indexOf(update), 1);
			const outcome = await this.commit(update.id, update.data, update.base, update.writer);
			for (const waiter of update.waiters) waiter(outcome);
			return outcome;
		});
	}

	/** Adds a block the file does not hold yet, creating the file if there is none. */
	createBlock(id: string, data: InkFileBlock): Promise<WriteOutcome> {
		return this.enqueue(() => this.commit(id, data, null, null));
	}

	// The opaque stroke payload, which is what the rescue store compares a
	// held drawing against to prove the file has not moved on.
	private strokesOf(id: string): string {
		const raw = this.contents?.blocks.get(id);
		return isRecord(raw) && typeof raw.strokes === 'string' ? raw.strokes : '';
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.tail.then(task);
		// The queue survives a task that throws; the caller still sees it.
		this.tail = run.catch(() => undefined);
		return run;
	}

	private notify(change: StoreChange, origin: object | null): void {
		for (const listener of [...this.listeners]) listener(change, origin);
	}

	private async readFromDisk(): Promise<void> {
		let text: string | null;
		try {
			text = await this.io.read(this.path);
		} catch (error) {
			console.error(`InklingExpanded: could not read ${this.path}.`, error);
			// Not the same as absent: something is there. Nothing is known about
			// it, so nothing may be written over it.
			if (this.current.kind === 'loading') {
				this.current = { kind: 'damaged' };
				this.notify('all', null);
			}
			// Tried again, a little later each time, while nothing better is
			// known. Otherwise a file locked for a moment as it opened would
			// refuse every block naming it until something happened to modify it.
			if (this.current.kind === 'damaged' && this.failedReads < READ_RETRIES) {
				this.failedReads += 1;
				window.setTimeout(() => this.fileChanged(), READ_RETRY_MS * this.failedReads);
			}
			return;
		}
		this.failedReads = 0;
		await this.adopt(text, null);
	}

	// Takes on what the file says now.
	private async adopt(text: string | null, origin: object | null): Promise<void> {
		if (text === null) {
			if (this.current.kind === 'absent') return;
			this.lastText = null;
			this.current = { kind: 'absent' };
			this.notify('all', origin);
			return;
		}

		// Almost always our own write, reported back by the vault.
		if (text === this.lastText && this.current.kind !== 'loading') return;

		const read = parseInkFile(text);
		if (read.kind === 'damaged') {
			// A damaged read never displaces a good one. A file caught mid-sync
			// is partial for a moment and whole a moment later, and the session
			// goes on serving what it holds while that settles. lastText is left
			// alone, so a save made meanwhile sees the file is not what it last
			// saw and refuses rather than writing over it.
			if (this.contents && this.current.kind === 'readable') return;
			this.current = { kind: 'damaged' };
			this.notify('all', origin);
			return;
		}

		if (read.kind === 'from-future') {
			this.lastText = text;
			this.current = { kind: 'from-future', version: read.version };
			this.notify('all', origin);
			return;
		}

		const changed = new Set<string>();
		const next = new Map<string, HeldBlock>();
		for (const [id, raw] of read.contents.blocks) {
			const json = JSON.stringify(raw);
			const previous = this.held.get(id);
			if (previous && previous.json === json) {
				next.set(id, previous);
				continue;
			}
			next.set(id, { read: await readInkFileBlock(raw), json, revision: ++this.revisions });
			changed.add(id);
		}
		for (const id of this.held.keys()) {
			if (!next.has(id)) changed.add(id);
		}

		this.held.clear();
		for (const [id, block] of next) this.held.set(id, block);
		this.contents = read.contents;
		this.lastText = text;

		const wasReadable = this.current.kind === 'readable';
		this.current = { kind: 'readable' };
		if (!wasReadable) this.notify('all', origin);
		else if (changed.size > 0) this.notify(changed, origin);
	}

	private async commit(id: string, data: InkFileBlock, named: BlockBase | null, writer: object | null): Promise<WriteOutcome> {
		const creating = named === null;
		const base = named && writer ? this.catchUp(named, writer, id) : named;

		for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
			const status = this.current.kind;
			// Only creating a block may create a file. A save that finds no file
			// is a save for a file that went missing, and writing it would put a
			// one-block file over one that was merely misplaced.
			if (status !== 'readable' && !(creating && status === 'absent')) return refused('not-writable');

			// Blocks held from a file that has since gone are not written into a
			// new one as a side effect of inserting a block.
			const from = status === 'absent' ? null : this.contents;
			const current = status === 'absent' ? undefined : this.held.get(id);

			let next = data;
			let merged = false;
			if (base === null) {
				if (current) return refused('block-exists');
			} else {
				if (!current) return refused('block-absent');
				if (current.read.kind !== 'decoded') return refused('block-unreadable');
				if (current.revision !== base.revision) {
					next = toFileBlock(
						mergeInkBlocks(toInkBlockData(base.block), toInkBlockData(data), toInkBlockData(current.read.block)),
					);
					merged = true;
				}
			}

			const raw = await writeInkFileBlock(from?.blocks.get(id), next);

			// Before: the block must decode back to what was encoded. This is
			// what stops an empty or corrupt payload being written over a block
			// whose view holds annotations — and a legitimately empty block
			// still passes, because it decodes to zero of zero.
			const check = await decodeStrokes(raw.strokes, raw.codec);
			if (check.kind !== 'decoded' || check.annotations.length !== next.annotations.length) {
				console.error(`InklingExpanded: block ${id} did not encode faithfully, so ${this.path} was not written.`);
				return refused('encoding-mismatch');
			}

			const blocks = new Map(from?.blocks ?? []);
			blocks.set(id, raw);
			// Before: a serialization holding no blocks never goes over a file
			// that held some. Unreachable from a save, which always adds one; it
			// guards whatever writes through here next.
			if ((from?.blocks.size ?? 0) > 0 && blocks.size === 0) return refused('no-blocks-over-blocks');

			const contents: InkFileContents = { extra: from?.extra ?? [], blocks };
			const text = serializeInkFile(contents);

			let result: ReplaceResult;
			try {
				result = await this.io.replaceIf(this.path, status === 'absent' ? null : this.lastText, text);
			} catch (error) {
				console.error(`InklingExpanded: could not write ${this.path}.`, error);
				return refused('failed');
			}

			if (!result.written) {
				// The file is not what was last seen. A file gone bad refuses
				// outright: there is nothing to merge into, and writing over it
				// is exactly what repair (not a save) is for.
				//
				// Recorded, not only refused. The store would otherwise still
				// call the file readable, so every block naming it would retry
				// forever without a word to the user. Taking the damaged text as
				// the last seen means any later version of the file — even the
				// one this store held before — is read again and lifts this.
				if (result.found !== null && parseInkFile(result.found).kind === 'damaged') {
					this.lastText = result.found;
					this.current = { kind: 'damaged' };
					this.notify('all', null);
					return refused('not-writable');
				}
				await this.adopt(result.found, null);
				continue;
			}

			// After: a write cut short leaves a shorter file. lastText is left as
			// it was, so the next save finds the file changed, reads what was
			// left, and refuses rather than writing on the strength of it.
			let size: number | null = null;
			try {
				size = await this.io.size(this.path);
			} catch {
				size = null;
			}
			if (size !== null && size !== byteLength(text)) {
				console.error(`InklingExpanded: ${this.path} is ${size} bytes after writing ${byteLength(text)}; the write did not complete.`);
				return refused('failed');
			}

			if (this.verifyNextWrite) {
				let reread: string | null = null;
				try {
					reread = await this.io.read(this.path);
				} catch {
					reread = null;
				}
				const read = reread === null ? null : parseInkFile(reread);
				if (read?.kind !== 'readable' || JSON.stringify(read.contents.blocks.get(id)) !== JSON.stringify(raw)) {
					console.error(`InklingExpanded: ${this.path} did not read back as written.`);
					return refused('failed');
				}
				this.verifyNextWrite = false;
			}

			if (status === 'absent') this.held.clear();
			this.contents = contents;
			this.lastText = text;
			const revision = ++this.revisions;
			this.held.set(id, { read: { kind: 'decoded', block: next }, json: JSON.stringify(raw), revision });
			if (writer) {
				let saved = this.lastSaved.get(writer);
				if (!saved) {
					saved = new Map<string, LastSave>();
					this.lastSaved.set(writer, saved);
				}
				saved.set(id, { block: data, revision, merged });
			}
			this.current = { kind: 'readable' };
			this.notify(status === 'readable' ? new Set([id]) : 'all', writer);
			return { kind: 'written', block: next, revision, merged };
		}

		return refused('moved-on');
	}

	// The base a writer's save is really from. When the writer's own last
	// save is newer than the base it names, that save is — what it sent was
	// on the writer's screen. Sent, not what landed: a merged save's other
	// side never reached the screen, so it is kept as a change from elsewhere,
	// which the revision set apart from the file's makes sure is merged.
	private catchUp(named: BlockBase, writer: object, id: string): BlockBase {
		const saved = this.lastSaved.get(writer)?.get(id);
		if (!saved || saved.revision <= named.revision) return named;
		return { block: saved.block, revision: saved.merged ? -saved.revision : saved.revision };
	}
}

// Every store in use, so blocks naming the same file share one — which is
// what makes a copied fence show the original's ink, and what keeps two
// blocks in one note from racing each other to write the same file.
export class InkFileStores {
	private readonly entries = new Map<string, { store: InkFileStore; users: number }>();

	constructor(private readonly io: InkFileIO) {}

	acquire(path: string): InkFileStore {
		let entry = this.entries.get(path);
		if (!entry) {
			entry = { store: new InkFileStore(path, this.io), users: 0 };
			this.entries.set(path, entry);
		}
		entry.users += 1;
		return entry.store;
	}

	// A store outlives its last user until its queue is empty, so a block that
	// flushes a save as it is torn down still gets that save written.
	release(path: string): void {
		const entry = this.entries.get(path);
		if (!entry) return;
		entry.users -= 1;
		if (entry.users > 0) return;
		void entry.store.whenIdle().then(() => {
			if (entry.users <= 0 && this.entries.get(path) === entry) this.entries.delete(path);
		});
	}

	isHeld(path: string): boolean {
		return this.entries.has(path);
	}

	/** Settles once every store in use has run everything it has queued. */
	async whenIdle(): Promise<void> {
		await Promise.all([...this.entries.values()].map((entry) => entry.store.whenIdle()));
	}

	fileChanged(path: string): void {
		this.entries.get(path)?.store.fileChanged();
	}

	fileDeleted(path: string): void {
		this.entries.get(path)?.store.fileDeleted();
	}

	// Until fences are rewritten on rename, a fence naming the old path is
	// naming a file that is not there.
	fileRenamed(oldPath: string, newPath: string): void {
		this.fileDeleted(oldPath);
		this.fileChanged(newPath);
	}
}
