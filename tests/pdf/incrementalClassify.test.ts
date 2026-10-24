import { PDFDocument, PDFNumber, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { classifyIncrementalSave } from '../../src/pdf/incrementalClassify';
import { toArrayBuffer } from '../../src/binary';

// One fixture per structural class, each built here rather than read from
// the vault. A suite that depends on the user's library cannot run in CI,
// depends on files not in the repository, and changes meaning every time a
// book is added or removed.
//
// One class the spec names is missing and is missing on purpose:
// **linearized**. pdf-lib cannot produce one, and hand-assembling a
// plausible linearized file would be testing the fixture rather than the
// classifier. A linearized file's *last* cross-reference section — the only
// one this module chains to — is an ordinary table or stream, so nothing
// here is specific to it; that it reaches a decision at all is covered by
// the fuzz case below and by the opt-in library check in
// tests/pdf/vaultLibrary.test.ts, where real linearized books actually are.

async function classicTableBytes(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	doc.addPage([612, 792]).drawText('Chapter one', { x: 72, y: 700, size: 24, font });
	// useObjectStreams: false is what makes pdf-lib emit a classic table
	// through PDFWriter rather than an xref stream through PDFStreamWriter.
	return doc.save({ useObjectStreams: false });
}

async function xrefStreamBytes(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	doc.addPage([612, 792]).drawText('Chapter one', { x: 72, y: 700, size: 24, font });
	// The default. Object streams and an xref stream together, which is what
	// the largest books in the vault use.
	return doc.save({ useObjectStreams: true });
}

async function load(bytes: Uint8Array): Promise<PDFDocument> {
	return PDFDocument.load(toArrayBuffer(bytes), { updateMetadata: false });
}

const latin1 = new TextDecoder('latin1');
const encode = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

describe('classifyIncrementalSave', () => {
	it('takes the fast path on a classic cross-reference table', async () => {
		const bytes = await classicTableBytes();
		const result = classifyIncrementalSave(bytes, await load(bytes));
		expect(result.supported).toBe(true);
		if (!result.supported) return;
		expect(result.style).toBe('table');
		expect(result.xrefOffset).toBeGreaterThan(0);
	});

	it('takes the fast path on a cross-reference stream', async () => {
		const bytes = await xrefStreamBytes();
		const result = classifyIncrementalSave(bytes, await load(bytes));
		expect(result.supported).toBe(true);
		if (!result.supported) return;
		expect(result.style).toBe('stream');
	});

	it('declines a hybrid-reference file', async () => {
		// /XRefStm means the classic table the offset points at is shadowed
		// by an xref stream elsewhere, and the two describe the file
		// differently. Two of the twenty books in the vault are shaped this
		// way; the spec's spike found both.
		const original = await classicTableBytes();
		// Same length, so every offset in the table stays honest and the only
		// thing this fixture changes is the presence of the key.
		const bytes = encode(latin1.decode(original).replace('/Size', '/XRefStm 9 /Sze'));
		const result = classifyIncrementalSave(bytes, await load(original));
		expect(result.supported).toBe(false);
		if (result.supported) return;
		expect(result.reason).toMatch(/hybrid/i);
	});

	it('declines a file whose startxref points at nothing', async () => {
		// The corruption our own reader is blind to. pdf-lib opens this
		// happily, which is exactly why the classifier has to ask.
		const original = await classicTableBytes();
		const bytes = encode(latin1.decode(original).replace(/startxref\n\d+/, 'startxref\n17'));
		const result = classifyIncrementalSave(bytes, await load(original));
		expect(result.supported).toBe(false);
	});

	it('declines a classic table whose entries do not point at their objects', async () => {
		// A table that parses but lies. Shifting one in-use entry's offset by
		// a few bytes leaves a file pdf-lib still reads perfectly.
		const original = await classicTableBytes();
		let patched = false;
		const bytes = encode(
			latin1.decode(original).replace(/\n(\d{10}) 00000 n/g, (whole, offset: string) => {
				if (patched) return whole;
				patched = true;
				return `\n${String(Number(offset) + 3).padStart(10, '0')} 00000 n`;
			}),
		);
		expect(patched).toBe(true);
		const result = classifyIncrementalSave(bytes, await load(original));
		expect(result.supported).toBe(false);
		if (result.supported) return;
		expect(result.reason).toMatch(/entry/i);
	});

	it('declines an encrypted document', async () => {
		const bytes = await classicTableBytes();
		const doc = await load(bytes);
		// An encrypted book cannot reach the writer at all — PDFDocument.load
		// throws EncryptedPDFError and InklingExpanded never passes ignoreEncryption
		// — so this can only be reached by a file that acquired /Encrypt some
		// other way. Declining is still the right answer.
		doc.context.trailerInfo.Encrypt = PDFNumber.of(1);
		const result = classifyIncrementalSave(bytes, doc);
		expect(result.supported).toBe(false);
		if (result.supported) return;
		expect(result.reason).toMatch(/encrypt/i);
	});

	it('reaches a decision on a file that has already been updated once', async () => {
		// Not "takes the fast path": a chain of updates is legal and common,
		// and what matters is that the classifier answers rather than throws.
		const first = await classicTableBytes();
		const doc = await load(first);
		doc.addPage([612, 792]);
		const second = await doc.save({ useObjectStreams: false });
		const result = classifyIncrementalSave(second, await load(second));
		expect(typeof result.supported).toBe('boolean');
	});

	it('declines rather than throwing on bytes that are not a PDF at all', async () => {
		const bytes = new TextEncoder().encode('x'.repeat(4096));
		const result = classifyIncrementalSave(bytes, await load(await classicTableBytes()));
		expect(result.supported).toBe(false);
	});

	it('never throws, whatever it is handed', async () => {
		// The property the whole decline path rests on. A classifier that can
		// throw is a classifier that can take an open failure with it.
		const original = await classicTableBytes();
		const doc = await load(original);
		for (let cut = 0; cut < original.length; cut += 97) {
			expect(() => classifyIncrementalSave(original.subarray(0, cut), doc)).not.toThrow();
		}
	});
});
