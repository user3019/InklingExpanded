import { describe, expect, it, vi } from 'vitest';
import { findMatches, flattenOutline, type RawOutlineItem } from '../../src/pdf/navigation';

// Resolves a destination by reading a page number straight off it, which is
// all the real resolver does once pdf.js has done its lookups.
const resolveDest = async (dest: unknown): Promise<number | null> =>
	typeof dest === 'number' ? dest : null;

describe('flattenOutline', () => {
	it('has nothing to show for a document with no outline', async () => {
		expect(await flattenOutline(null, resolveDest)).toEqual([]);
		expect(await flattenOutline(undefined, resolveDest)).toEqual([]);
		expect(await flattenOutline([], resolveDest)).toEqual([]);
	});

	it('flattens a tree, recording how deep each entry sat', async () => {
		const outline: RawOutlineItem[] = [
			{
				title: 'Part one',
				dest: 1,
				items: [
					{ title: 'Chapter 1', dest: 2 },
					{ title: 'Chapter 2', dest: 40, items: [{ title: 'A section', dest: 45 }] },
				],
			},
			{ title: 'Part two', dest: 90 },
		];

		expect(await flattenOutline(outline, resolveDest)).toMatchObject([
			{ title: 'Part one', pageNumber: 1, depth: 0 },
			{ title: 'Chapter 1', pageNumber: 2, depth: 1 },
			{ title: 'Chapter 2', pageNumber: 40, depth: 1 },
			{ title: 'A section', pageNumber: 45, depth: 2 },
			{ title: 'Part two', pageNumber: 90, depth: 0 },
		]);
	});

	it('drops an entry whose destination will not resolve, but keeps its children', async () => {
		// An entry that does nothing when clicked is worse than one that
		// isn't there. Its children may still be perfectly good.
		const outline: RawOutlineItem[] = [
			{ title: 'Broken', dest: 'nowhere', items: [{ title: 'Fine', dest: 12 }] },
		];
		expect(await flattenOutline(outline, resolveDest)).toMatchObject([{ title: 'Fine', pageNumber: 12, depth: 1 }]);
	});

	it('drops an untitled entry', async () => {
		const outline: RawOutlineItem[] = [{ dest: 3 }, { title: '   ', dest: 4 }, { title: 'Real', dest: 5 }];
		expect(await flattenOutline(outline, resolveDest)).toMatchObject([{ title: 'Real', pageNumber: 5, depth: 0 }]);
	});

	it('survives a resolver that throws, without losing the rest of the tree', async () => {
		const resolve = vi.fn(async (dest: unknown) => {
			if (dest === 'bad') throw new Error('dangling destination');
			return typeof dest === 'number' ? dest : null;
		});
		const outline: RawOutlineItem[] = [
			{ title: 'First', dest: 1 },
			{ title: 'Explodes', dest: 'bad' },
			{ title: 'Last', dest: 9 },
		];
		expect(await flattenOutline(outline, resolve)).toMatchObject([
			{ title: 'First', pageNumber: 1, depth: 0 },
			{ title: 'Last', pageNumber: 9, depth: 0 },
		]);
	});

	it('stops descending a pathologically deep tree', async () => {
		// A malformed document can describe an absurdly deep — or effectively
		// cyclic — tree. This is a list in a side panel, not something anyone
		// needs in full.
		let deepest: RawOutlineItem = { title: 'Bottom', dest: 1 };
		for (let level = 0; level < 50; level++) deepest = { title: `Level ${level}`, dest: 1, items: [deepest] };

		const entries = await flattenOutline([deepest], resolveDest);
		expect(entries.length).toBeLessThan(20);
		for (const entry of entries) expect(entry.depth).toBeLessThanOrEqual(6);
	});
});

describe('findMatches', () => {
	it('counts occurrences regardless of case', () => {
		expect(findMatches('The Cat sat on the CAT mat', 'cat')).toBe(2);
	});

	it('counts non-overlapping occurrences', () => {
		expect(findMatches('aaaa', 'aa')).toBe(2);
	});

	it('finds nothing for an empty query rather than matching everything', () => {
		expect(findMatches('anything at all', '')).toBe(0);
		expect(findMatches('anything at all', '   ')).toBe(0);
	});

	it('finds nothing in empty text', () => {
		expect(findMatches('', 'cat')).toBe(0);
	});

	it('treats the query as text, not as a pattern', () => {
		// Whatever the user typed goes straight in. A regular expression
		// built from it would either need escaping or would throw on a stray
		// bracket in the middle of a 900-page walk.
		expect(findMatches('a.b', '.')).toBe(1);
		expect(findMatches('cost is $5 (approx)', '(approx)')).toBe(1);
		expect(() => findMatches('anything', '[')).not.toThrow();
		expect(findMatches('nothing here', '.*')).toBe(0);
	});
});
