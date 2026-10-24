import { PDFDict, PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { compareFingerprints, fingerprintDocument } from '../../src/pdf/fingerprint';
import { writeInklingAnnotations } from '../../src/pdf/annotationSync';
import type { Annotation } from '../../src/annotate/types';

async function sampleDoc(): Promise<PDFDocument> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const page = doc.addPage([612, 792]);
	page.drawText('Chapter one', { x: 72, y: 700, size: 24, font });
	doc.addPage([612, 792]);
	doc.setKeywords(['inkling:template=lined']);
	return doc;
}

async function reload(doc: PDFDocument): Promise<PDFDocument> {
	return PDFDocument.load(await doc.save(), { updateMetadata: false });
}

const stroke: Annotation = {
	id: 'ink-a',
	kind: 'stroke',
	tool: 'pen',
	color: '#000000',
	width: 3,
	points: [{ x: 10, y: 10 }, { x: 100, y: 100 }],
};

describe('fingerprintDocument', () => {
	it('is stable across a save and reload with no edits', async () => {
		// The load-bearing property. If this fails, verification would refuse
		// every save, so the fingerprint is measuring something pdf-lib
		// legitimately re-encodes and that field has to go.
		const doc = await sampleDoc();
		const before = fingerprintDocument(doc);
		const after = fingerprintDocument(await reload(doc));
		expect(compareFingerprints(before, after)).toBeNull();
	});

	it('is stable across several consecutive round trips', async () => {
		let current = await sampleDoc();
		const first = fingerprintDocument(current);
		for (let pass = 0; pass < 3; pass++) {
			current = await reload(current);
			expect(compareFingerprints(first, fingerprintDocument(current))).toBeNull();
		}
	});

	it("ignores InklingExpanded's own annotations being added", async () => {
		const doc = await sampleDoc();
		const before = fingerprintDocument(doc);
		writeInklingAnnotations(doc, 0, [stroke]);
		expect(compareFingerprints(before, fingerprintDocument(doc))).toBeNull();
	});

	it('notices a foreign annotation disappearing', async () => {
		const doc = await sampleDoc();
		doc.getPage(0).node.addAnnot(
			doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [10, 10, 60, 60], F: 4 })),
		);
		const before = fingerprintDocument(doc);

		const stripped = await sampleDoc();
		expect(compareFingerprints(before, fingerprintDocument(stripped))).toMatch(/other software/);
	});

	it('notices a page disappearing', async () => {
		const doc = await sampleDoc();
		const before = fingerprintDocument(doc);
		doc.removePage(1);
		expect(compareFingerprints(before, fingerprintDocument(doc))).toMatch(/page count/);
	});

	it('notices page content being replaced', async () => {
		// Damage is simulated by swapping the content stream itself, rather
		// than by drawing on the page. pdf-lib buffers drawing operations and
		// only materialises them into /Contents at save time, so a drawn
		// rectangle would be measuring pdf-lib's own deferral rather than
		// this check. Losing a page's content is what the check is for, and
		// this is what that looks like.
		const doc = await reload(await sampleDoc());
		const before = fingerprintDocument(doc);
		doc.getPage(0).node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('1 0 0 RG')));
		expect(compareFingerprints(before, fingerprintDocument(doc))).toMatch(/content stream/);
	});

	it('notices a resource the content stream refers to going missing', async () => {
		// The failure mode that matters most and shows least: the page's
		// drawing operators survive, the font they name does not, and the
		// page renders blank or in a substituted face.
		const doc = await reload(await sampleDoc());
		const before = fingerprintDocument(doc);
		const fonts = doc.getPage(0).node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
		for (const key of fonts?.keys() ?? []) fonts?.delete(key);
		expect(compareFingerprints(before, fingerprintDocument(doc))).toMatch(/font count/);
	});

	it('notices the template keyword being lost', async () => {
		const doc = await sampleDoc();
		const before = fingerprintDocument(doc);
		doc.setKeywords([]);
		expect(compareFingerprints(before, fingerprintDocument(doc))).toMatch(/keywords/);
	});

	it('notices a page being resized', async () => {
		const doc = await sampleDoc();
		const before = fingerprintDocument(doc);
		doc.getPage(0).setSize(400, 400);
		expect(compareFingerprints(before, fingerprintDocument(doc))).toMatch(/media box/);
	});
});
