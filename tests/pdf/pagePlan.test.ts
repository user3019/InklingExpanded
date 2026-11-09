import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { applyPagePlan, extractPages } from '../../src/pdf/pages';
import { layoutStampOf } from '../../src/pdf/outline';

async function pdfOf(widths: number[]): Promise<PDFDocument> {
	const doc = await PDFDocument.create();
	for (const width of widths) doc.addPage([width, 700]);
	return doc;
}

const widths = (doc: PDFDocument) => doc.getPages().map((page) => page.getWidth());

function addInk(doc: PDFDocument, pageIndex: number, id: string, extra: Record<string, unknown> = {}) {
	const page = doc.getPage(pageIndex);
	const ref = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Ink', Rect: [0, 0, 10, 10], ...extra } as never));
	doc.context.lookup(ref, PDFDict).set(PDFName.of('NM'), PDFString.of(id));
	page.node.addAnnot(ref);
}

const idsOn = (doc: PDFDocument, pageIndex: number) =>
	(doc.getPage(pageIndex).node.Annots()?.asArray() ?? []).map((entry) => doc.context.lookup(entry, PDFDict).lookup(PDFName.of('NM'), PDFString).decodeText());

const applied = async (doc: PDFDocument, plan: Parameters<typeof applyPagePlan>[1]) => {
	const result = await applyPagePlan(await doc.save(), plan);
	if (result.kind !== 'reordered') throw new Error(`not applied: ${result.kind}`);
	return PDFDocument.load(result.bytes);
};

const pageObjects = (doc: PDFDocument) =>
	doc.context.enumerateIndirectObjects().filter(([, object]) => object instanceof PDFDict && object.get(PDFName.of('Type')) === PDFName.of('Page')).length;

describe('applying a plan to a PDF', () => {
	it('moves, deletes and leaves out exactly what the plan says', async () => {
		const out = await applied(await pdfOf([100, 200, 300, 400]), [{ page: 4 }, { page: 2 }, { page: 1 }]);
		expect(widths(out)).toEqual([400, 200, 100]);
		expect(pageObjects(out)).toBe(3);
	});

	it('turns a page on top of the turn it already had', async () => {
		const doc = await pdfOf([100, 200]);
		doc.getPage(0).setRotation({ type: 'degrees', angle: 90 } as never);
		const out = await applied(doc, [{ page: 1, turn: 270 }, { page: 2, turn: -90 }]);
		expect(out.getPages().map((page) => page.getRotation().angle)).toEqual([0, 270]);
	});

	it('gives a duplicated page its own ink ids, so sync sees two drawings', async () => {
		const doc = await pdfOf([100, 200]);
		addInk(doc, 0, 'ink-original');
		const out = await applied(doc, [{ page: 1 }, { page: 1, turn: 90 }, { page: 2 }]);
		expect(widths(out)).toEqual([100, 100, 200]);
		expect(out.getPage(0).ref).not.toBe(out.getPage(1).ref);
		expect(idsOn(out, 0)).toEqual(['ink-original']);
		const [copyId] = idsOn(out, 1);
		expect(copyId).toMatch(/^ink-/);
		expect(copyId).not.toBe('ink-original');
		expect(out.getPage(1).getRotation().angle).toBe(90);
		expect(out.getPage(0).getRotation().angle).toBe(0);
	});

	it('keeps a content stream that a remaining page shares with a deleted one', async () => {
		const doc = await pdfOf([100, 200]);
		doc.getPage(0).drawText('shared');
		doc.getPage(1).node.set(PDFName.of('Contents'), doc.getPage(0).node.get(PDFName.of('Contents')) as never);
		const out = await applied(doc, [{ page: 2 }]);
		const contents = out.getPage(0).node.Contents();
		expect(contents).toBeDefined();
		expect(contents instanceof PDFArray ? contents.size() : 1).toBeGreaterThan(0);
	});

	it('does nothing for a plan that changes nothing, and refuses an empty one', async () => {
		const bytes = await (await pdfOf([100, 200])).save();
		expect((await applyPagePlan(bytes, [{ page: 1 }, { page: 2 }])).kind).toBe('unchanged');
		expect((await applyPagePlan(bytes, [])).kind).toBe('refused');
		expect((await applyPagePlan(bytes, [{ page: 3 }])).kind).toBe('refused');
	});

	it('notices a turned page in the layout stamp, and not in anything else', async () => {
		const doc = await pdfOf([100, 200]);
		const before = layoutStampOf(await PDFDocument.load(await doc.save()));
		addInk(doc, 0, 'ink-a');
		expect(layoutStampOf(await PDFDocument.load(await doc.save()))).toBe(before);
		const out = await applied(doc, [{ page: 1, turn: 90 }, { page: 2 }]);
		expect(layoutStampOf(out)).not.toBe(before);
	});
});

describe('exporting pages to a new PDF', () => {
	it('takes only the pages asked for, with their ink and shown turn', async () => {
		const doc = await pdfOf([100, 200, 300]);
		addInk(doc, 1, 'ink-kept');
		const result = await extractPages(await doc.save(), [{ page: 2, turn: 90 }]);
		if (result.kind !== 'exported') throw new Error('refused');
		const out = await PDFDocument.load(result.bytes);
		expect(widths(out)).toEqual([200]);
		expect(idsOn(out, 0)).toEqual(['ink-kept']);
		expect(out.getPage(0).getRotation().angle).toBe(90);
	});

	it('does not carry the rest of the document along through an annotation or a link', async () => {
		const doc = await pdfOf([100, 200, 300]);
		// An annotation naming its page, and a link to another: both lead,
		// followed, to the whole page tree.
		addInk(doc, 0, 'ink-a', { P: doc.getPage(0).ref });
		const link = doc.context.register(doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 1, 1], Dest: [doc.getPage(2).ref, PDFName.of('Fit')] } as never));
		doc.getPage(0).node.addAnnot(link);
		const source = await doc.save();
		const result = await extractPages(source, [{ page: 1 }]);
		if (result.kind !== 'exported') throw new Error('refused');
		const out = await PDFDocument.load(result.bytes);
		expect(pageObjects(out)).toBe(1);
		expect(idsOn(out, 0)).toEqual(['ink-a']);
	});
});
