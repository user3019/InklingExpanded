import { MarkdownPostProcessorContext, MarkdownView, Notice, Plugin, TFile } from 'obsidian';
import { findScrollParent } from '../annotate';
import { createId } from '../annotate/id';
import {
	INK_BLOCK_VERSION,
	findInkBlockById,
	findUniqueInkBlockByBody,
	parseInkBlock,
	serializeInkBlock,
	type InkBlockData,
	type InkBlockDamage,
} from './inkBlockFormat';
import type { BlockRefusal, InkBlockStorage, StorageHost, StorageWriteResult } from './inkBlockStorage';
import { mergeInkBlocks } from './mergeInkBlocks';

// A block whose strokes live in its own fence, as every block did before ink
// files: saving rewrites the fence, through the editor when the note is open
// and through the file when it is not.

// How long to wait before trying again when the block cannot be found
// in its own note, and how many times. A note being actively edited can
// briefly not contain the fence a save is looking for — the user is
// midway through cutting and pasting a section, say. Retrying rather
// than giving up is what stops a transient state from needing a
// re-render to recover from.
const LOCATE_RETRY_MS = 1200;
const LOCATE_RETRIES = 4;

// How long to keep restoring the note's scroll position after a save. See
// keepScrollPosition — the scroll that has to be undone happens *after* the
// edit that caused it, and in reading view after the re-render later still,
// so one synchronous reset is not enough. Short enough that a deliberate
// scroll begun in the same breath as a pen-lift is at worst briefly
// interrupted.
const SCROLL_RESTORE_MS = 120;

// What the banner says, which differs by damage because what the user can do
// about it differs by damage. The old text covered all three at once — "may
// have been written by a newer version" — which was a guess presented to
// someone who could not check it and could not act on it either way.
function damageMessage(damage: InkBlockDamage): string {
	switch (damage.kind) {
		case 'unreadable':
			return 'InklingExpanded could not read this ink block at all, so it will not be saved over. Its text is still in the note, exactly as it was.';
		case 'partial':
			return `InklingExpanded could read ${damage.kept} of the ${damage.kept + damage.dropped} annotations in this ink block, so it will not be saved over.`;
		case 'from-future':
			return `This ink block is in format ${damage.version} and this version of InklingExpanded reads format ${INK_BLOCK_VERSION}, so it will not be saved over. Update InklingExpanded to edit it.`;
		case 'none':
			return '';
	}
}

function refusalFor(damage: InkBlockDamage): BlockRefusal {
	// Only a partly-read block is offered a way out, and the reason is the
	// whole shape of this feature. Nothing survived an unreadable one, so
	// there is nothing to keep. A block from a newer version did not fail
	// to parse so much as fail to be understood — what this build dropped
	// is most likely what that version added, so "keep what survived"
	// there means "throw away the part written by the newer plugin".
	if (damage.kind === 'partial') {
		return { message: damageMessage(damage), recoverable: { kept: damage.kept, dropped: damage.dropped } };
	}
	return { message: damageMessage(damage) };
}

export class InNoteStorage implements InkBlockStorage {
	readonly rescuePath: string;
	readonly blockId: string;
	// The exact text this block rendered from — what a save checks before
	// overwriting a fence. See locate/findUniqueInkBlockByBody for why "it's
	// an ink block" was not enough.
	private renderedSource: string;
	private readonly initial: InkBlockData;
	private readonly damage: InkBlockDamage;
	private host: StorageHost | null = null;
	// One report per view, not one per save: a mismatch repeats on every
	// debounce tick for as long as the note is open.
	private reportedMismatch = false;
	// Consecutive failures to find this block in its own note. Reset on
	// every successful save.
	private locateFailures = 0;
	// Said once per view, like the locate-failure notice: a refusal repeats
	// on every retry, and a notice per attempt is noise about one problem.
	private reportedStaleWrite = false;
	private disposeRepairWatch: (() => void) | null = null;

	constructor(
		private readonly plugin: Plugin,
		private readonly ctx: MarkdownPostProcessorContext,
		private readonly containerEl: HTMLElement,
		source: string,
	) {
		const { data, damage } = parseInkBlock(source);
		// A block written before ids existed picks one up the first time it
		// saves; until then it is located by its exact source text instead.
		this.blockId = data.id ?? createId();
		this.renderedSource = source.trim();
		this.initial = { ...data, id: this.blockId };
		this.damage = damage;
		this.rescuePath = ctx.sourcePath;
	}

	rescueSource(): string {
		return this.renderedSource;
	}

	open(host: StorageHost): void {
		this.host = host;
		if (this.damage.kind !== 'none') {
			// Deliberately never saves over it: a block this build can't fully
			// read is far more likely to be from a newer version of the
			// plugin, or damaged in a way the original could still recover,
			// than something worth replacing with what little parsed.
			host.refuse(refusalFor(this.damage));
			this.watchForRepair();
		}
		host.show(this.initial);
	}

	close(): void {
		this.disposeRepairWatch?.();
		this.disposeRepairWatch = null;
	}

	// A block that could not be read watches its own note, so that the
	// decision made when it rendered is not the only one it ever makes.
	//
	// Registered only by a block that was damaged when it rendered, so a
	// healthy note carries no listeners at all — but kept for that block's
	// whole life, not only until it is repaired. Conflicts keep happening in
	// a live-replicating vault, and a block that healed once can be damaged
	// again; dropping the watch on the way out would leave it writable with
	// no banner, which fails open where the stale banner failed closed.
	private watchForRepair(): void {
		const vault = this.plugin.app.vault;
		const ref = vault.on('modify', (file) => {
			if (file.path !== this.ctx.sourcePath) return;
			void this.recheckDamage();
		});
		this.disposeRepairWatch = () => vault.offref(ref);
	}

	private async recheckDamage(): Promise<void> {
		const host = this.host;
		if (!host || host.isDetached()) return;
		const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		if (!(file instanceof TFile)) return;

		let contents: string;
		try {
			contents = await this.plugin.app.vault.cachedRead(file);
		} catch {
			return;
		}
		// Reading the file is asynchronous, so the block can have been
		// detached while it was in flight.
		if (host.isDetached()) return;

		const lines = contents.split('\n');
		// A block whose id was inside the JSON that failed to parse cannot be
		// located at all, and there is no honest way to guess which fence
		// became which — guessing at one is how a drawing once reached another
		// block. Its banner waits for the note to re-render, as it always did.
		const range = this.locate(lines);
		if (!range) return;

		const body = lines.slice(range.lineStart + 1, range.lineEnd).join('\n');
		const { data, damage } = parseInkBlock(body);

		if (damage.kind !== 'none') {
			// Damaged now, and the refusal has to come back. Nothing is
			// re-seeded: what is on screen is what the user drew, and
			// replacing it with the partial parse of a file we have just
			// refused to write would take strokes off the screen on the
			// strength of a version we do not trust.
			if (host.isRefused()) return;
			host.refuse(refusalFor(damage));
			return;
		}

		if (!host.isRefused()) return;
		host.lift();
		this.renderedSource = body.trim();
		host.show({ ...data, id: this.blockId });
	}

	// Saving a block rewrites the note, and any document change makes the
	// editor scroll its cursor back into view. Drawing with a stylus never
	// moves that cursor — it stays wherever it was last placed, which for a
	// note you opened and drew in is usually the very top — so every autosave
	// yanked the note back up to it a couple of seconds after the user
	// stopped writing, which is the whole time a debounced save takes to
	// fire. Reading view has the same symptom by a different route: the
	// re-render resets the preview scroller.
	//
	// So: remember where the note actually is, and put it back. Repeatedly,
	// for a moment, because the scroll being undone happens after the edit
	// returns rather than during it.
	private keepScrollPosition(): () => void {
		const scroller = findScrollParent(this.containerEl);
		if (!scroller) return () => undefined;
		const { scrollTop, scrollLeft } = scroller;

		return () => {
			const deadline = performance.now() + SCROLL_RESTORE_MS;
			const restore = () => {
				// Only ever corrects a jump away from where the note was. A
				// scroller already sitting where it should be is left alone, so
				// this can't fight the user for control of it.
				if (scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
				if (scroller.scrollLeft !== scrollLeft) scroller.scrollLeft = scrollLeft;
				if (performance.now() < deadline) window.requestAnimationFrame(restore);
			};
			restore();
		};
	}

	async write(data: InkBlockData): Promise<StorageWriteResult> {
		const restoreScroll = this.keepScrollPosition();

		const editor = this.findOpenEditor();
		if (editor) {
			// Through the editor, not the file, whenever the note is open:
			// this lands as an ordinary edit in the same document the user is
			// working in — one undo step, no external-modification reload,
			// and no fight with unsaved changes the editor hasn’t flushed to
			// disk yet.
			// One call, not one per line. Reading the document a line at a
			// time costs a tree lookup and a string slice apiece, which was
			// tolerable at 409 lines and is not at 7,788 — the count on the
			// largest note in the vault once stored JSON began wrapping. This
			// runs on the main thread while the pen is still moving.
			const lines = editor.getValue().split('\n');

			const range = this.locate(lines);
			if (!range) return this.locateFailed();

			const serialized = this.bodyToWrite(lines, range, data);
			if (serialized === null) return this.refuseStaleWrite();

			editor.replaceRange(`${serialized}\n`, { line: range.lineStart + 1, ch: 0 }, { line: range.lineEnd, ch: 0 });
			this.renderedSource = serialized;
			this.locateFailures = 0;
			restoreScroll();
			return { kind: 'saved' };
		}

		const file = this.plugin.app.vault.getAbstractFileByPath(this.ctx.sourcePath);
		// No editor and no file: there is nowhere left to write, so the only
		// copy of this drawing is the one being held.
		if (!(file instanceof TFile)) return { kind: 'held' };

		try {
			let wrote = false;
			let refused = false;
			let written = '';
			await this.plugin.app.vault.process(file, (contents) => {
				const lines = contents.split('\n');
				const range = this.locate(lines);
				if (!range) return contents;
				const body = this.bodyToWrite(lines, range, data);
				if (body === null) {
					refused = true;
					return contents;
				}
				written = body;
				lines.splice(range.lineStart + 1, range.lineEnd - range.lineStart - 1, body);
				wrote = true;
				return lines.join('\n');
			});
			if (refused) return this.refuseStaleWrite();
			if (!wrote) return this.locateFailed();
			this.renderedSource = written;
			this.locateFailures = 0;
			restoreScroll();
			return { kind: 'saved' };
		} catch (error) {
			console.error('InklingExpanded: failed to save an ink block.', error);
			new Notice('InklingExpanded: could not save this ink block. Your drawing is still on screen and will be saved again shortly.');
			return { kind: 'held' };
		}
	}

	// Where this block’s fence actually is in `lines`.
	//
	// By id first, because that answers the question directly. Obsidian’s
	// getSectionInfo is a report of where a block is, and in a note holding
	// several it is a report that can be wrong — which is how one block’s
	// drawing was written into another’s, and how refusing that write then
	// lost the drawing instead.
	//
	// For the one case an id search cannot answer — a block that has never
	// been saved, and so carries no id in the file yet — the note is searched
	// for the fence holding this view's exact text instead. getSectionInfo is
	// not consulted at all any more, and that is the fix for a second way
	// this lost work.
	//
	// It used to be the fallback, with its reported range checked against
	// that same text before writing. The check could not do the job it was
	// given: two ink blocks nobody has drawn in yet are the same fifty-five
	// bytes of empty JSON, so an empty block compared equal to *any* other
	// empty block, a misreported range sailed through, and one block's
	// drawing was written into another block's fence — which reads, from the
	// outside, as the work in the first block disappearing the moment the
	// second one was touched.
	//
	// Searching for a uniquely-matching fence answers the question directly
	// and refuses when the answer is ambiguous, which a failed save turns
	// into ink kept rather than ink misplaced.
	// What to put in the fence, decided against what the fence says *now*.
	//
	// A save used to overwrite whatever was there. That is correct while this
	// view is the only thing editing the block, and wrong the moment it is
	// not: a block flushes its pending write when it is torn down, and it is
	// torn down precisely because the note changed — a sync landing inside
	// the debounce is exactly that case. The other device's strokes went
	// silently.
	//
	// The comparison costs a join and a string equality on lines already in
	// hand, and the answer is "unchanged" for every save but the rare one, so
	// nothing below it runs in the ordinary case.
	//
	// Returns null to refuse: the fence holds something this build cannot
	// read, and merging into a block we could not parse is exactly the guess
	// the refusal elsewhere exists to prevent.
	private bodyToWrite(lines: readonly string[], range: { lineStart: number; lineEnd: number }, data: InkBlockData): string | null {
		const current = lines.slice(range.lineStart + 1, range.lineEnd).join('\n').trim();
		if (current === this.renderedSource) return serializeInkBlock(data);

		const { data: theirs, damage } = parseInkBlock(current);
		if (damage.kind !== 'none') return null;

		// The base is what this view last read, which is what makes this a
		// three-way merge rather than a guess about who is newer.
		const base = parseInkBlock(this.renderedSource).data;
		return serializeInkBlock(mergeInkBlocks(base, data, theirs));
	}

	// The fence moved on and holds something unreadable, so there is nothing
	// to merge into. The view holds and persists the drawing on `held`, so the
	// session can end without losing it, and the block's own damage banner
	// takes over from here.
	private refuseStaleWrite(): StorageWriteResult {
		if (this.reportedStaleWrite) return { kind: 'held' };
		this.reportedStaleWrite = true;
		console.error(
			`InklingExpanded: ink block ${this.blockId} in ${this.ctx.sourcePath} changed elsewhere and cannot be read, ` +
				'so this save was refused rather than written over it. The drawing is held on this device.',
		);
		new Notice('InklingExpanded: this ink block changed elsewhere and could not be read, so it was not saved over.');
		return { kind: 'held' };
	}

	private locate(lines: readonly string[]): { lineStart: number; lineEnd: number } | null {
		const byId = findInkBlockById(lines, this.blockId);
		if (byId) return byId;

		return findUniqueInkBlockByBody(lines, this.renderedSource);
	}

	// The block is not where it should be. The drawing is already held (see
	// the view's write), so nothing is lost either way — but a retry usually
	// resolves it without the user ever knowing, and only a run of failures
	// is worth telling them about.
	private locateFailed(): StorageWriteResult {
		this.locateFailures += 1;
		if (this.locateFailures <= LOCATE_RETRIES) return { kind: 'retry', afterMs: LOCATE_RETRY_MS };
		this.reportMismatch();
		return { kind: 'held' };
	}

	// Refusing to save is the safe outcome, but a silent one would look like
	// ink vanishing, so say so once. The block's own next render re-seeds
	// from the file and picks the work back up.
	private reportMismatch(): void {
		if (this.reportedMismatch) return;
		this.reportedMismatch = true;
		console.error(
			`InklingExpanded: could not find ink block ${this.blockId} in ${this.ctx.sourcePath} to save it. ` +
				'The drawing is still on screen and is held on this device, and will be written the next time the note renders. ' +
				'If the block was deleted from the note, that is expected.',
		);
		new Notice('InklingExpanded: an ink block could not be saved yet. Your drawing is safe — leave the note open.');
	}

	// Any open editor on this note, not just the focused one — drawing on a
	// canvas doesn't necessarily move focus to the note's editor, and a note
	// can be open in a split alongside the one being looked at.
	// The editor to save through, or null to go to the file instead.
	//
	// A view in reading mode is skipped, and that is not a nicety: an edit
	// made through its editor is silently discarded. Measured in the running
	// app — replaceRange on a reading-mode view changed the buffer, left
	// `dirty` false, never reached disk, and was gone the moment the view
	// re-synced from the file.
	//
	// That made this the worst kind of failure. The write did not throw, so
	// the save counted itself a success, cleared the recovery entry that
	// exists to survive a failed save, and left the ink on screen with
	// nothing in the file — until the next re-render, which took it. Exactly
	// the "it glitched and it was gone" this plugin already has one fix for;
	// that fix addressed a save that could not find its block, and this is a
	// save that finds it and writes somewhere that does not last.
	//
	// Live Preview reports 'source' here, the same as source mode, so only
	// reading view takes the file path below — which is the path that works
	// regardless of what is open.
	private findOpenEditor() {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || view.file?.path !== this.ctx.sourcePath) continue;
			if (view.getMode() === 'preview') continue;
			return view.editor;
		}
		return null;
	}
}
