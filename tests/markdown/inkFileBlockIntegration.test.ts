// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation } from '../../src/annotate/types';
import { emptyFileBlock, type InkFileBlock } from '../../src/markdown/inkFile';
import { inkFenceMarkdown } from '../../src/markdown/inkFence';
import { emptyInkBlock, inkBlockMarkdown } from '../../src/markdown/inkBlockFormat';
import { inkFileText } from '../harness/inkFileIO';
import { mountNote, type TestNote } from '../harness/note';

// A block whose strokes live in an ink file, from pen to disk. The note is
// the thing that must not change; the file is where the work has to land.

const INK = 'Ink/Physics.ink';
const STROKE: Array<[number, number]> = [
	[100, 100],
	[150, 120],
	[200, 100],
];

let note: TestNote;

// A fresh block id for every test, like the ids in inkBlockIntegration.test.ts
// and for the same reason: the rescue store is module-level, so a drawing one
// test holds is still held when the next runs, and clearing localStorage does
// not reach the copy it keeps in memory. Two tests sharing a path and an id
// share an entry — and since both start from the same empty block, the source
// check passes and the second test adopts the first's strokes.
let blockId = 'a';
let nextBlockId = 0;

beforeEach(() => {
	document.body.innerHTML = '';
	window.localStorage.clear();
	blockId = `block-${++nextBlockId}`;
});

afterEach(() => {
	vi.useRealTimers();
});

function stroke(id: string): Annotation {
	return { id, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 2, points: [{ x: 1, y: 2 }, { x: 30, y: 40 }] };
}

function holding(...ids: string[]): InkFileBlock {
	return { ...emptyFileBlock(), annotations: ids.map(stroke) };
}

function fence(id: string, file = INK): string {
	return inkFenceMarkdown({ file, id, extra: [] });
}

function noteText(...blocks: string[]): string {
	return ['# Physics', '', ...blocks.flatMap((block) => [block, '', 'Prose between.', ''])].join('\n');
}

async function open(contents: string, inkFiles: Record<string, string>): Promise<TestNote> {
	const mounted = mountNote({ path: 'Physics.md', contents, inkFiles, openInEditor: true });
	await mounted.settle();
	return mounted;
}

function banner(index = 0): string | null {
	return note.block(index).el.querySelector('.inkling-ink-block-banner-text')?.textContent ?? null;
}

describe('a block whose ink is in a file', () => {
	beforeEach(async () => {
		note = await open(noteText(fence(blockId)), { [INK]: await inkFileText({ [blockId]: holding() }) });
	});

	it('writes a stroke to the ink file', async () => {
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		expect(await note.inkStrokeCount(INK, blockId)).toBe(1);
	});

	it('leaves the note exactly as it was', async () => {
		const before = note.contents();
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		expect(note.contents()).toBe(before);
	});

	it('shows no banner', () => {
		expect(banner()).toBeNull();
	});
});

describe('an in-note block and an ink-file block in one note', () => {
	beforeEach(async () => {
		note = await open(noteText(inkBlockMarkdown({ ...emptyInkBlock(), id: 'old' }), fence('new')), {
			[INK]: await inkFileText({ new: holding() }),
		});
	});

	it('saves each where it lives', async () => {
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		note.block(1).openForEditing();
		note.block(1).drawStroke(STROKE);
		await note.flushWrites();

		expect(note.strokeCountIn(0)).toBe(1);
		expect(await note.inkStrokeCount(INK, 'new')).toBe(1);
	});
});

describe('a fence copied so two blocks show one drawing', () => {
	beforeEach(async () => {
		note = await open(noteText(fence('shared'), fence('shared')), { [INK]: await inkFileText({ shared: holding() }) });
	});

	it('keeps what was drawn in both', async () => {
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		note.block(1).openForEditing();
		note.block(1).drawStroke([
			[300, 300],
			[320, 330],
		]);
		await note.flushWrites();

		expect(await note.inkStrokeCount(INK, 'shared')).toBe(2);
	});
});

describe('a change to the ink file made elsewhere', () => {
	it('is merged with a save that had not heard of it', async () => {
		note = await open(noteText(fence(blockId)), { [INK]: await inkFileText({ [blockId]: holding() }) });
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		note.setInkFile(INK, await inkFileText({ [blockId]: holding('theirs') }));
		await note.flushWrites();

		expect(await note.inkStrokeCount(INK, blockId)).toBe(2);
	});

	it('is taken on by a block nobody is drawing in, and survives its next save', async () => {
		note = await open(noteText(fence(blockId)), { [INK]: await inkFileText({ [blockId]: holding() }) });
		await note.syncInkFile(INK, await inkFileText({ [blockId]: holding('theirs') }));

		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		expect(await note.inkStrokeCount(INK, blockId)).toBe(2);
	});
});

describe('blocks that may not be saved', () => {
	it.each([
		['the ink file does not exist', {}, 'cannot find the ink file'],
		['the ink file holds no such block', { [INK]: 'placeholder' }, 'holds no drawing for this block'],
		['the ink file is from a newer version', { [INK]: '{"version":4,"blocks":{}}' }, 'newer version of InklingExpanded'],
		['the ink file cannot be read', { [INK]: '{"version":1,"blocks":{"a":' }, 'could not read the ink file'],
	])('refuse ink, change nothing, and say why, when %s', async (_label, files: Record<string, string>, says) => {
		const inkFiles = files[INK] === 'placeholder' ? { [INK]: await inkFileText({ other: holding() }) } : files;
		note = await open(noteText(fence(blockId)), inkFiles);
		const before = note.inkFile(INK);

		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();

		expect(note.inkFile(INK)).toBe(before);
		expect(banner()).toContain(says);
	});

	it('refuses a fence that does not name its file', async () => {
		note = await open(noteText('```inkling\nid: a\n```'), {});
		expect(banner()).toContain('does not say which ink file');
	});
});

describe('an ink file deleted while its note is open', () => {
	beforeEach(async () => {
		note = await open(noteText(fence(blockId)), { [INK]: await inkFileText({ [blockId]: holding() }) });
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.deleteInkFile(INK);
		await note.flushWrites();
	});

	it('is not recreated by a save', () => {
		expect(note.inkFile(INK)).toBeUndefined();
	});

	it('keeps the drawing somewhere that survives quitting', () => {
		expect(Object.keys(window.localStorage).some((key) => key === `inkling:unsaved:${INK}::${blockId}`)).toBe(true);
	});

	it('saves the drawing once the file comes back', async () => {
		await note.syncInkFile(INK, await inkFileText({ [blockId]: holding() }));
		await note.flushWrites();

		expect(banner()).toBeNull();
		expect(await note.inkStrokeCount(INK, blockId)).toBe(1);
	});
});

describe('inserting a block', () => {
	beforeEach(() => {
		note = mountNote({ path: 'Physics.md', contents: '# Physics\n\n', openInEditor: true });
	});

	it('puts a three-line fence in the note', async () => {
		await note.runInsertCommand();
		expect(note.contents()).toMatch(/```inkling\nfile: Ink\/Physics\.ink\nid: ink-[^\n]+\n```\n$/);
	});

	it('creates the block in the ink file, so it is never mistaken for a missing one', async () => {
		await note.runInsertCommand();
		const id = /id: (.+)\n/.exec(note.contents())?.[1];
		if (!id) throw new Error('no id in the inserted fence');
		expect(await note.inkStrokeCount('Ink/Physics.ink', id)).toBe(0);
	});

	it('gives a block that renders ready to draw in, and saves', async () => {
		await note.runInsertCommand();
		note.rerender();
		await note.settle();
		expect(banner()).toBeNull();

		const id = /id: (.+)\n/.exec(note.contents())?.[1] ?? '';
		note.block(0).openForEditing();
		note.block(0).drawStroke(STROKE);
		await note.flushWrites();
		expect(await note.inkStrokeCount('Ink/Physics.ink', id)).toBe(1);
	});

	it('adds to an ink file the note already has', async () => {
		await note.runInsertCommand();
		await note.runInsertCommand();
		const ids = [...note.contents().matchAll(/id: (.+)\n/g)].map((match) => match[1] ?? '');
		expect(ids).toHaveLength(2);
		for (const id of ids) expect(await note.inkStrokeCount('Ink/Physics.ink', id)).toBe(0);
	});

	it('puts the block where the command was run, though the note changed while the file was written', async () => {
		await note.runInsertCommand();
		// Typed while the second block's drawing was being written to the file.
		note.interceptInkWrites(() => {
			note.setContents(`${note.contents()}Typed meanwhile.\n`);
			note.interceptInkWrites(null);
		});
		await note.runInsertCommand();

		const contents = note.contents();
		expect(contents.lastIndexOf('```inkling')).toBeLessThan(contents.indexOf('Typed meanwhile.'));
	});

	it('inserts nothing when the ink file cannot be written', async () => {
		note = mountNote({
			path: 'Physics.md',
			contents: '# Physics\n\n',
			openInEditor: true,
			inkFiles: { 'Ink/Physics.ink': '{"version":1,"blocks":{' },
		});
		await note.runInsertCommand();
		expect(note.contents()).toBe('# Physics\n\n');
		expect(note.notices().some((message) => message.includes('no ink block was inserted'))).toBe(true);
	});
});
