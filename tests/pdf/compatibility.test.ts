import { PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
	compareProfiles,
	formatMediaBox,
	normalizeRotation,
	profileFromPdfLib,
	riskyFeatures,
	samplePageIndices,
	type StructureProfile,
} from '../../src/pdf/compatibility';

describe('samplePageIndices', () => {
	it('takes every page of a short document', () => {
		expect(samplePageIndices(3)).toEqual([0, 1, 2]);
		expect(samplePageIndices(10)).toHaveLength(10);
	});

	it('spreads a fixed number of samples through a long one', () => {
		const indices = samplePageIndices(900);
		expect(indices).toHaveLength(10);
		// The ends matter disproportionately: a truncated page tree shows up
		// at the end, and a misread first page is what a cover produces.
		expect(indices[0]).toBe(0);
		expect(indices[indices.length - 1]).toBe(899);
	});

	it('never samples a page that does not exist', () => {
		for (const pageCount of [1, 2, 7, 11, 12, 99, 1000]) {
			for (const index of samplePageIndices(pageCount)) {
				expect(index).toBeGreaterThanOrEqual(0);
				expect(index).toBeLessThan(pageCount);
			}
		}
	});

	it('returns ascending, unique indices', () => {
		const indices = samplePageIndices(37);
		expect([...new Set(indices)]).toEqual(indices);
		expect([...indices].sort((a, b) => a - b)).toEqual(indices);
	});

	it('copes with a document that has no pages at all', () => {
		expect(samplePageIndices(0)).toEqual([]);
		expect(samplePageIndices(-4)).toEqual([]);
		expect(samplePageIndices(Number.NaN)).toEqual([]);
	});

	it('is deterministic, so both parsers sample the same pages', () => {
		// Load-bearing: the two sides run this independently and the
		// comparison matches them up by page index.
		expect(samplePageIndices(517)).toEqual(samplePageIndices(517));
	});
});

describe('normalizeRotation', () => {
	it('folds any legal statement of rotation into 0/90/180/270', () => {
		expect(normalizeRotation(0)).toBe(0);
		expect(normalizeRotation(90)).toBe(90);
		expect(normalizeRotation(360)).toBe(0);
		expect(normalizeRotation(450)).toBe(90);
		expect(normalizeRotation(-90)).toBe(270);
		expect(normalizeRotation(Number.NaN)).toBe(0);
	});
});

describe('compareProfiles', () => {
	const profile = (pageCount: number, mediaBox: string, rotation = 0): StructureProfile => ({
		pageCount,
		sampledPages: [{ index: 0, page: { mediaBox, rotation } }],
	});

	it('accepts two parsers that agree', () => {
		expect(compareProfiles(profile(5, '0.00,0.00,612.00,792.00'), profile(5, '0.00,0.00,612.00,792.00'))).toBeNull();
	});

	it('reports a page-count disagreement', () => {
		expect(compareProfiles(profile(5, '0.00,0.00,612.00,792.00'), profile(4, '0.00,0.00,612.00,792.00'))).toMatch(
			/how many pages/,
		);
	});

	it('reports a page-size disagreement', () => {
		expect(compareProfiles(profile(5, '0.00,0.00,612.00,792.00'), profile(5, '0.00,0.00,595.00,842.00'))).toMatch(/size of page 1/);
	});

	it('reports a rotation disagreement', () => {
		expect(compareProfiles(profile(5, '0.00,0.00,612.00,792.00', 0), profile(5, '0.00,0.00,612.00,792.00', 90))).toMatch(
			/rotation of page 1/,
		);
	});

	it('does not compare annotation counts', () => {
		// Deliberate: the pdf.js side reads displayBytes, which has InklingExpanded's
		// own annotations stripped, so on any already-annotated file the two
		// sides differ by design. A book opening read-only for that reason
		// would be a false positive worse than the check is worth.
		expect(Object.keys(profile(1, '0.00,0.00,10.00,10.00').sampledPages[0]?.page ?? {})).toEqual(['mediaBox', 'rotation']);
	});
});

describe('profileFromPdfLib', () => {
	it('reads page count, size and rotation from a real document', async () => {
		const doc = await PDFDocument.create();
		doc.addPage([612, 792]);
		doc.addPage([595, 842]);
		const profile = profileFromPdfLib(doc);
		expect(profile.pageCount).toBe(2);
		expect(profile.sampledPages[0]?.page.mediaBox).toBe(formatMediaBox(0, 0, 612, 792));
		expect(profile.sampledPages[1]?.page.mediaBox).toBe(formatMediaBox(0, 0, 595, 842));
		expect(profile.sampledPages[0]?.page.rotation).toBe(0);
	});

	it('agrees with itself across a save and reload', async () => {
		// If this drifted, every file would open read-only.
		const doc = await PDFDocument.create();
		for (let index = 0; index < 25; index++) doc.addPage([612, 792]);
		const before = profileFromPdfLib(doc);
		const after = profileFromPdfLib(await PDFDocument.load(await doc.save(), { updateMetadata: false }));
		expect(compareProfiles(before, after)).toBeNull();
	});
});

describe('riskyFeatures', () => {
	it('finds nothing in an ordinary document', async () => {
		const doc = await PDFDocument.create();
		doc.addPage([612, 792]);
		expect(riskyFeatures(doc)).toEqual([]);
	});

	it('ignores an AcroForm with no fields in it', async () => {
		// Plenty of real PDFs carry an empty one. Refusing to annotate them
		// would be a false positive on a very ordinary book.
		const doc = await PDFDocument.create();
		doc.addPage([612, 792]);
		doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [] }));
		expect(riskyFeatures(doc)).toEqual([]);
	});

	it('refuses a form that actually has fields', async () => {
		const doc = await PDFDocument.create();
		doc.addPage([612, 792]);
		const field = doc.context.register(doc.context.obj({ FT: 'Tx', T: 'name' }));
		doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [field] }));
		expect(riskyFeatures(doc)).toContain('an interactive form');
	});

	it('refuses a signed document, declared either way', async () => {
		const signedViaFlags = await PDFDocument.create();
		signedViaFlags.addPage([612, 792]);
		const field = signedViaFlags.context.register(signedViaFlags.context.obj({ FT: 'Sig' }));
		signedViaFlags.catalog.set(PDFName.of('AcroForm'), signedViaFlags.context.obj({ Fields: [field], SigFlags: 3 }));
		expect(riskyFeatures(signedViaFlags)).toContain('a digital signature');

		const signedViaPerms = await PDFDocument.create();
		signedViaPerms.addPage([612, 792]);
		signedViaPerms.catalog.set(PDFName.of('Perms'), signedViaPerms.context.obj({ DocMDP: {} }));
		expect(riskyFeatures(signedViaPerms)).toContain('a digital signature');
	});
});
