import { describe, expect, it } from 'vitest';
import { sanitizeFilename } from '../src/noteCreation';

// The name typed for a new handwritten note, made into a file name — to
// which ".pdf" is added after.

describe('a new note’s file name', () => {
	it('does not end up with .pdf twice when the extension is typed too', () => {
		expect(sanitizeFilename('Physics.pdf')).toBe('Physics');
		expect(sanitizeFilename('Physics.PDF ')).toBe('Physics');
	});

	it('keeps a name that only has .pdf inside it', () => {
		expect(sanitizeFilename('my.pdf notes')).toBe('my.pdf notes');
	});

	it('replaces characters a file name may not have', () => {
		expect(sanitizeFilename('a/b:c')).toBe('a-b-c');
	});
});
