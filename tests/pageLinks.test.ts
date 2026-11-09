// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { followPageLinks, pageMapOfDeletion, pageMapOfInsertion, pageMapOfPlan, rewritePageLinks } from '../src/pageLinks';
import { exportedPagesName } from '../src/pageMenu';
import { TFile } from './harness/obsidian';

const isBook = (path: string) => path === 'Book.pdf' || path === 'Folder/Book.pdf' || path === 'My Book.pdf';
const swap = pageMapOfPlan([{ page: 2 }, { page: 1 }, { page: 3 }]);

describe('following a PDF\'s pages through the notes that link to them', () => {
	it('updates a wiki link, its alias, and keeps what follows the page', () => {
		expect(rewritePageLinks('see [[Book.pdf#page=1|Book, page 1]] and [[Book.pdf#page=2&selection=1,2,3]]', isBook, swap).text).toBe(
			'see [[Book.pdf#page=2|Book, page 2]] and [[Book.pdf#page=1&selection=1,2,3]]',
		);
	});

	it('updates a Markdown link, however its path is written', () => {
		expect(rewritePageLinks('[Book, page 2](My%20Book.pdf#page=2) [x](<My Book.pdf#page=1>)', isBook, swap).text).toBe('[Book, page 1](My%20Book.pdf#page=1) [x](<My Book.pdf#page=2>)');
	});

	it('swaps two links without one overwriting the other', () => {
		expect(rewritePageLinks('[[Book.pdf#page=1]] [[Book.pdf#page=2]]', isBook, swap)).toEqual({ text: '[[Book.pdf#page=2]] [[Book.pdf#page=1]]', changed: 2, orphaned: 0 });
	});

	it('leaves other files and an alias about something else', () => {
		const text = '[[Other.pdf#page=1]] [[Book.pdf#page=3|page 3]] [web](https://example.com/Book.pdf#page=1)';
		expect(rewritePageLinks(text, isBook, swap)).toEqual({ text, changed: 0, orphaned: 0 });
		expect(rewritePageLinks('[[Book.pdf#page=1|page 7 of it]]', isBook, swap).text).toBe('[[Book.pdf#page=2|page 7 of it]]');
	});

	it('leaves a link to a deleted page alone, and counts it', () => {
		expect(rewritePageLinks('[[Book.pdf#page=2]] [[Book.pdf#page=3]]', isBook, pageMapOfDeletion(2))).toEqual({
			text: '[[Book.pdf#page=2]] [[Book.pdf#page=2]]',
			changed: 1,
			orphaned: 1,
		});
	});

	it('counts pages added and duplicated correctly', () => {
		const inserted = pageMapOfInsertion(2, 3);
		expect([1, 2, 3].map(inserted)).toEqual([1, 2, 6]);
		const copied = pageMapOfPlan([{ page: 1 }, { page: 1 }, { page: 2 }]);
		expect([1, 2].map(copied)).toEqual([1, 3]);
	});

	it('writes only the notes that link to this PDF', async () => {
		const book = new TFile('Book.pdf');
		const note = new TFile('Note.md');
		let written = '[[Book.pdf#page=1]]';
		const process = vi.fn(async (_file: unknown, change: (text: string) => string) => {
			written = change(written);
			return written;
		});
		const app = {
			metadataCache: {
				resolvedLinks: { 'Note.md': { 'Book.pdf': 1 }, 'Elsewhere.md': { 'Other.pdf': 1 } },
				getFirstLinkpathDest: (link: string) => (link === 'Book.pdf' ? book : null),
			},
			vault: { process, getAbstractFileByPath: (path: string) => (path === 'Note.md' ? note : new TFile(path)) },
		};
		await followPageLinks(app as never, book as never, swap);
		expect(process).toHaveBeenCalledTimes(1);
		expect(written).toBe('[[Book.pdf#page=2]]');
	});
});

describe('names of exported pages', () => {
	it('says which pages they are', () => {
		expect(exportedPagesName('Book', [3])).toBe('Book - page 3');
		expect(exportedPagesName('Book', [3, 4, 5])).toBe('Book - pages 3-5');
		expect(exportedPagesName('Book', [5, 2])).toBe('Book - 2 pages');
	});
});
