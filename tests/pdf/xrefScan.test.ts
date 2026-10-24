import { describe, expect, it } from 'vitest';
import { findStartXref, objectHeaderAt, scanLastXref } from '../../src/pdf/xrefScan';

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

// The smallest thing that is shaped like a classic-table PDF. The offsets in
// it are deliberately not real: nothing in this module resolves them, and a
// fixture that pretends otherwise invites a reader to trust the wrong thing.
const classicTail = [
	'xref',
	'0 3',
	'0000000000 65535 f ',
	'0000000009 00000 n ',
	'0000000074 00000 n ',
	'trailer',
	'<< /Size 3 /Root 1 0 R >>',
	'startxref',
	'0',
	'%%EOF',
].join('\n');

describe('findStartXref', () => {
	it('reads the offset from the tail', () => {
		const file = bytes(`%PDF-1.7\nstartxref\n9\n%%EOF\n`);
		expect(findStartXref(file)).toBe(9);
	});

	it('takes the last startxref, not the first', () => {
		// An already-incrementally-updated file has one per update section,
		// and only the last one is the entry point. Padded so the second
		// offset is actually inside the file — an offset past the end is a
		// different case, checked below.
		const file = bytes(`%PDF-1.7\n${'% filler\n'.repeat(50)}startxref\n17\n%%EOF\nstartxref\n412\n%%EOF\n`);
		expect(findStartXref(file)).toBe(412);
	});

	it('declines a file with no startxref at all', () => {
		expect(findStartXref(bytes('%PDF-1.7\nnothing to see here\n'))).toBeNull();
	});

	it('declines an offset that is not a number', () => {
		expect(findStartXref(bytes('%PDF-1.7\nstartxref\nlater\n%%EOF\n'))).toBeNull();
	});

	it('declines an offset past the end of the file', () => {
		expect(findStartXref(bytes('%PDF-1.7\nstartxref\n999999\n%%EOF\n'))).toBeNull();
	});

	it('declines an offset of zero, where the header is', () => {
		expect(findStartXref(bytes('%PDF-1.7\nstartxref\n0\n%%EOF\n'))).toBeNull();
	});
});

describe('objectHeaderAt', () => {
	it('reads an indirect object header', () => {
		const file = bytes('%PDF-1.7\n12 0 obj\n<< /Type /XRef >>\n');
		const header = objectHeaderAt(file, 9);
		expect(header?.objectNumber).toBe(12);
		expect(header?.generationNumber).toBe(0);
	});

	it('returns null where there is no header', () => {
		const file = bytes('%PDF-1.7\nnot an object\n');
		expect(objectHeaderAt(file, 9)).toBeNull();
	});
});

describe('scanLastXref', () => {
	it('recognises a classic cross-reference table', () => {
		const head = '%PDF-1.7\n';
		const file = bytes(`${head}${classicTail.replace('\n0\n%%EOF', `\n${head.length}\n%%EOF`)}`);
		const scan = scanLastXref(file);
		expect(scan.style).toBe('table');
		if (scan.style !== 'table') return;
		expect(scan.offset).toBe(head.length);
		expect(scan.trailerText).toContain('/Root');
	});

	it('recognises a cross-reference stream', () => {
		const head = '%PDF-1.7\n';
		const object = '9 0 obj\n<< /Type /XRef /W [1 2 1] /Size 10 >>\nstream\nendstream\nendobj\n';
		const file = bytes(`${head}${object}startxref\n${head.length}\n%%EOF\n`);
		const scan = scanLastXref(file);
		expect(scan.style).toBe('stream');
		if (scan.style !== 'stream') return;
		expect(scan.trailerText).toContain('/Type /XRef');
	});

	it('declines when startxref points at something that is neither', () => {
		// The failure this whole module exists to catch: a file whose
		// cross-reference table is already broken opens fine in InklingExpanded today,
		// because pdf-lib never consults it. Appending to one produces a file
		// a stricter reader cannot follow.
		const head = '%PDF-1.7\n';
		const file = bytes(`${head}this is not a cross-reference section\nstartxref\n${head.length}\n%%EOF\n`);
		expect(scanLastXref(file).style).toBe('unknown');
	});

	it('declines a stream object that does not say it is an XRef', () => {
		const head = '%PDF-1.7\n';
		const object = '9 0 obj\n<< /Type /ObjStm >>\nstream\nendstream\nendobj\n';
		const file = bytes(`${head}${object}startxref\n${head.length}\n%%EOF\n`);
		expect(scanLastXref(file).style).toBe('unknown');
	});

	it('declines a table with no trailer behind it', () => {
		const head = '%PDF-1.7\n';
		const file = bytes(`${head}xref\n0 1\n0000000000 65535 f \nstartxref\n${head.length}\n%%EOF\n`);
		expect(scanLastXref(file).style).toBe('unknown');
	});
});
