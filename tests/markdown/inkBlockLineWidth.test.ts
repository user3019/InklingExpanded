import { describe, expect, it } from 'vitest';
import {
	MAX_STORED_LINE_LENGTH,
	findInkBlockById,
	findUniqueInkBlockByBody,
	inkBlockMarkdown,
	parseInkBlock,
	readInkBlockId,
	serializeInkBlock,
} from '../../src/markdown/inkBlockFormat';
import type { InkBlockData } from '../../src/markdown/inkBlockFormat';
import type { Annotation } from '../../src/annotate/types';

// A block used to be written as one line of compact JSON, on the reasoning
// that a few hundred lines of formatted JSON per drawing would swamp the
// writing around it. The cost of that was not measured until it was found in
// use: a page of handwriting is a line of 164,799 characters, and Obsidian's
// Live Preview cannot edit a document shaped like that. Typing anywhere in
// the note lagged.
//
// Confirmed by experiment rather than reasoned about. A copy of the note with
// the fence language changed so the plugin never ran was just as laggy, which
// ruled out anything InklingExpanded executes; the same copy with the JSON wrapped
// was smooth. Source mode was always smooth, which is what pointed at the
// rendering pass rather than at CodeMirror's handling of long lines.
//
// So the JSON is wrapped. It is still one JSON document — whitespace between
// tokens means nothing to a parser — and every path that reads a block
// already joins the fence's lines before parsing, so nothing else changes.

function longStroke(points: number): Annotation {
	return {
		id: 'ink-long',
		kind: 'stroke',
		tool: 'pen',
		color: '#1e1e1e',
		width: 3,
		// Already rounded the way the writer rounds, so a round-trip comparison
		// is testing the wrapping rather than the coordinate precision that
		// inkBlockFormat has always applied.
		points: Array.from({ length: points }, (_, i) => ({
			x: +(i * 1.7).toFixed(1),
			y: +(i * 2.3).toFixed(1),
			p: 0.5,
		})),
	};
}

function block(annotations: Annotation[]): InkBlockData {
	return { version: 2, id: 'ink-block', width: 800, height: 450, annotations };
}

function longestLine(text: string): number {
	return text.split('\n').reduce((max, line) => Math.max(max, line.length), 0);
}

describe('a serialized block', () => {
	it('never writes a line long enough to bog the editor down', () => {
		const source = serializeInkBlock(block([longStroke(4000)]));

		expect(longestLine(source)).toBeLessThanOrEqual(MAX_STORED_LINE_LENGTH);
	});

	it('stays one line when the block is small enough to fit', () => {
		const source = serializeInkBlock(block([]));

		expect(source).not.toContain('\n');
	});

	it('is still valid JSON once wrapped', () => {
		const source = serializeInkBlock(block([longStroke(2000)]));

		expect(() => JSON.parse(source) as unknown).not.toThrow();
	});

	it('round-trips a long stroke unchanged', () => {
		const original = longStroke(2000);
		const { data, malformed } = parseInkBlock(serializeInkBlock(block([original])));

		expect(malformed).toBe(false);
		expect(data.annotations[0]).toEqual(original);
	});

	// The wrap point is a comma, and a comma inside a string is not a wrap
	// point — a newline inside a JSON string is a parse error, so getting this
	// wrong would corrupt every block carrying text with a comma in it.
	it('never breaks a line inside a string', () => {
		const withText: Annotation = {
			...longStroke(500),
			note: 'One, two, three, and a great many more commas, all inside one string, ' .repeat(20),
		};
		const source = serializeInkBlock(block([withText]));

		expect(() => JSON.parse(source) as unknown).not.toThrow();
		const reread = JSON.parse(source) as { annotations: { note?: string }[] };
		expect(reread.annotations[0]?.note).toBe(withText.note);
	});

	it('reads its id back without parsing past the wrap', () => {
		const source = serializeInkBlock(block([longStroke(2000)]));

		expect(readInkBlockId(source)).toBe('ink-block');
	});
});

describe('finding a wrapped block in its note', () => {
	const wrapped = serializeInkBlock(block([longStroke(1500)]));
	const note = `# Notes\n\nBefore.\n\n\`\`\`inkling\n${wrapped}\n\`\`\`\n\nAfter.\n`;
	const lines = note.split('\n');

	it('spans many lines, which is the point', () => {
		expect(wrapped.split('\n').length).toBeGreaterThan(10);
	});

	it('locates it by id', () => {
		const range = findInkBlockById(lines, 'ink-block');

		expect(range).not.toBeNull();
		expect(lines.slice((range?.lineStart ?? 0) + 1, range?.lineEnd).join('\n')).toBe(wrapped);
	});

	it('locates it by body, for a block with no id yet', () => {
		const anonymous = serializeInkBlock({ version: 2, width: 800, height: 450, annotations: [longStroke(1500)] });
		const anonNote = `# Notes\n\n\`\`\`inkling\n${anonymous}\n\`\`\`\n`;
		const range = findUniqueInkBlockByBody(anonNote.split('\n'), anonymous);

		expect(range).not.toBeNull();
	});

	it('does not mistake a wrapped block for the start of another', () => {
		const two = `# Notes\n\n\`\`\`inkling\n${wrapped}\n\`\`\`\n\nBetween.\n\n\`\`\`inkling\n${wrapped}\n\`\`\`\n`;

		// Two blocks with identical bodies identify neither, which is the
		// existing refusal — what matters here is that the scan does not run
		// off the end or find a phantom third block.
		expect(findUniqueInkBlockByBody(two.split('\n'), wrapped)).toBeNull();
	});

	it('renders a fence that still opens and closes cleanly', () => {
		const markdown = inkBlockMarkdown(block([longStroke(800)]));
		const markdownLines = markdown.split('\n');

		expect(markdownLines[0]).toBe('```inkling');
		expect(markdownLines[markdownLines.length - 1]).toBe('```');
		expect(markdownLines.filter((line) => line.startsWith('```'))).toHaveLength(2);
	});
});
