// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountNote, type TestNote } from '../harness/note';
import { INK_BLOCK_VERSION, parseInkBlock } from '../../src/markdown/inkBlockFormat';

// A block InklingExpanded cannot fully read is never written over, and that is not
// changing: what failed to parse is exactly the part nobody can see, and
// overwriting it with what little survived is the one failure here that
// cannot be undone.
//
// What is changing is that the refusal used to be the end of the road. There
// was no way out from inside Obsidian — the user was left hand-editing JSON —
// and the banner was decided once when the block rendered and never revisited,
// so it outlived the condition that caused it. Both showed up together after a
// LiveSync conflict on a note whose blocks turned out to be perfectly healthy.

let note: TestNote;

beforeEach(() => {
	document.body.innerHTML = '';
});

afterEach(() => {
	vi.useRealTimers();
});

// Format 2 holds a stroke's coordinates as a flat run of numbers. A nested
// array is not a point, and a stroke built that way is dropped — which would
// make every "good" annotation below silently bad.
function goodStroke(id: string): unknown {
	return { id, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 2, points: [1, 2, 3, 4] };
}

function badStroke(id: string): unknown {
	return { id, kind: 'stroke', tool: 'notatool', color: '#1e1e1e', width: 2, points: [] };
}

function block(id: string, annotations: unknown[], version = INK_BLOCK_VERSION): unknown {
	return { version, id, width: 800, height: 450, annotations };
}

function noteText(body: unknown): string {
	const json = typeof body === 'string' ? body : JSON.stringify(body);
	return `# Notes\n\n\`\`\`inkling\n${json}\n\`\`\`\n`;
}

function noteHolding(body: unknown, blockId: string): TestNote {
	return mountNote({ path: `${blockId}.md`, contents: noteText(body), openInEditor: true });
}

function banner(): HTMLElement | null {
	return note.block(0).el.querySelector('.inkling-ink-block-banner');
}

function bannerText(): string {
	return note.block(0).el.querySelector('.inkling-ink-block-banner-text')?.textContent ?? '';
}

function recoverButton(): HTMLButtonElement | null {
	return note.block(0).el.querySelector<HTMLButtonElement>('.inkling-ink-block-banner-action');
}

describe('a block InklingExpanded could only partly read', () => {
	beforeEach(() => {
		note = noteHolding(
			block('ink-partial', [goodStroke('a'), badStroke('b'), goodStroke('c'), badStroke('d'), goodStroke('e')]),
			'ink-partial',
		);
	});

	it('says how much of it survived rather than only that something failed', () => {
		expect(bannerText()).toContain('3 of the 5');
	});

	it('offers to keep what survived', () => {
		expect(recoverButton()).not.toBeNull();
	});

	it('changes nothing on the first click', async () => {
		const before = note.contents();

		recoverButton()?.click();
		await note.flushWrites();

		expect(note.contents()).toBe(before);
	});

	it('says what will be lost before it is lost', () => {
		recoverButton()?.click();

		expect(recoverButton()?.textContent ?? '').toContain('2');
	});

	it('keeps exactly the annotations that survived, once confirmed', async () => {
		recoverButton()?.click();
		recoverButton()?.click();
		await note.flushWrites();

		const { data, malformed } = parseInkBlock(note.fenceBody(0));
		expect(malformed).toBe(false);
		expect(data.annotations).toHaveLength(3);
	});

	it('leaves the block writable afterwards', async () => {
		recoverButton()?.click();
		recoverButton()?.click();
		await note.flushWrites();
		note.rerender();

		expect(banner()).toBeNull();
	});
});

describe('a block that yielded nothing at all', () => {
	beforeEach(() => {
		note = noteHolding('{"version":2,"id":"ink-unreadable","annotations":[', 'ink-unreadable');
	});

	it('says so rather than implying something is there', () => {
		expect(bannerText()).toContain('could not read');
	});

	it('offers nothing to keep, because nothing survived', () => {
		expect(recoverButton()).toBeNull();
	});
});

describe('a block written by a newer version of InklingExpanded', () => {
	beforeEach(() => {
		note = noteHolding(block('ink-future', [goodStroke('a'), badStroke('b')], INK_BLOCK_VERSION + 1), 'ink-future');
	});

	it('says which version wrote it', () => {
		expect(bannerText()).toContain(String(INK_BLOCK_VERSION + 1));
	});

	it('never offers to keep what survived, which would be a downgrade', () => {
		expect(recoverButton()).toBeNull();
	});
});

describe('a banner whose block has since been repaired', () => {
	const repaired = noteText(block('ink-repaired', [goodStroke('a')]));

	beforeEach(() => {
		note = noteHolding(block('ink-repaired', [goodStroke('a'), badStroke('b')]), 'ink-repaired');
	});

	it('starts out refusing the block', () => {
		expect(banner()).not.toBeNull();
	});

	it('clears once the file reads cleanly again', async () => {
		// A LiveSync conflict resolved in the user's favour, or the JSON fixed
		// by hand. The block itself never re-renders, so the decision made
		// when it did is the only one there is unless it is revisited.
		await note.sync(repaired);

		expect(banner()).toBeNull();
	});

	it('takes ink again once it clears', async () => {
		await note.sync(repaired);
		note.block(0).reveal();
		note.block(0).openForEditing();
		note.block(0).drawStroke([
			[100, 100],
			[150, 120],
			[200, 100],
		]);
		await note.flushWrites();

		expect(note.strokeCountIn(0)).toBe(2);
	});

	it('leaves the banner alone while the block is still unreadable', async () => {
		await note.sync(noteText(block('ink-repaired', [badStroke('a'), badStroke('b')])));

		expect(banner()).not.toBeNull();
	});

	it('refuses the block again if it is damaged a second time', async () => {
		// Conflicts keep happening in a live-replicating vault, so a block
		// that healed once can be damaged again. Lifting the refusal on one
		// reading of the file and never looking again is the same mistake the
		// stale banner was, pointing the other way — and this direction fails
		// open rather than closed.
		await note.sync(repaired);
		await note.sync(noteText(block('ink-repaired', [goodStroke('a'), badStroke('b')])));

		expect(banner()).not.toBeNull();
	});

	it('will not write over a block that was damaged again', async () => {
		await note.sync(repaired);
		const damagedAgain = noteText(block('ink-repaired', [goodStroke('a'), badStroke('b')]));
		await note.sync(damagedAgain);

		note.block(0).reveal();
		note.block(0).openForEditing();
		note.block(0).drawStroke([
			[100, 100],
			[150, 120],
			[200, 100],
		]);
		await note.flushWrites();

		// The entry this build could not read is still in the file. Asserting
		// on that rather than only on the note being unchanged: a block that
		// refused the ink for some unrelated reason would pass the weaker
		// check while proving nothing.
		expect(note.fenceBody(0)).toContain('notatool');
		expect(note.contents()).toBe(damagedAgain);
	});
});

describe('a block too damaged to name itself', () => {
	beforeEach(() => {
		note = noteHolding('{"version":2,"id":"ink-nameless","annotations":[', 'ink-nameless');
	});

	it('keeps its banner even after the note is repaired', async () => {
		// Its id was inside the JSON that failed to parse, so there is nothing
		// to match a fence against and no way to know which block became
		// which. Waiting for the note to re-render is the honest answer;
		// guessing at a fence is how one block's drawing once reached another's.
		await note.sync(noteText(block('ink-nameless', [goodStroke('a')])));

		expect(banner()).not.toBeNull();
	});
});
