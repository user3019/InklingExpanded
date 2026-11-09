import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { openDocument } from '../../src/pdf/annotationWriterCore';
import { readInklingAnnotations, writeInklingAnnotations } from '../../src/pdf/annotationSync';

const stroke = (id: string) => ({ id, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 3, points: [{ x: 10, y: 10 }, { x: 90, y: 90 }] }) as never;

async function inkedWithForeignNote() {
	const doc = await PDFDocument.create();
	doc.addPage([200, 200]);
	doc.addPage([200, 200]);
	writeInklingAnnotations(doc, 0, [stroke('ink-a')]);
	const foreign = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [0, 0, 5, 5] } as never));
	doc.context.lookup(foreign, PDFDict).set(PDFName.of('NM'), PDFString.of('xodo-1'));
	doc.getPage(0).node.addAnnot(foreign);
	const bytes = await doc.save();
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const annotsOn = (doc: PDFDocument, page: number) => doc.getPage(page).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.size() ?? 0;

describe('the copy of a PDF that pdf.js draws', () => {
	it('has our ink off its pages and everyone else\'s still on them', async () => {
		const opened = await openDocument(await inkedWithForeignNote());
		const copy = await PDFDocument.load(opened.displayBytes);
		expect(readInklingAnnotations(copy, 0)).toEqual([]);
		expect(annotsOn(copy, 0)).toBe(1);
	});

	it('leaves the document being edited exactly as it was', async () => {
		const opened = await openDocument(await inkedWithForeignNote());
		expect(annotsOn(opened.doc, 0)).toBe(2);
		expect(readInklingAnnotations(opened.doc, 0).map((a) => a.id)).toEqual(['ink-a']);
		const saved = await PDFDocument.load(await opened.doc.save());
		expect(annotsOn(saved, 0)).toBe(2);
	});

	it('is the file itself when there is no ink to leave off', async () => {
		const doc = await PDFDocument.create();
		doc.addPage([200, 200]);
		const bytes = await doc.save();
		const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
		const opened = await openDocument(buffer);
		expect(new Uint8Array(opened.displayBytes)).toEqual(bytes);
	});
});
