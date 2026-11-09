import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { getDocument } from 'pdfjs-dist';
import { changeBookmarks, type BookmarkChange } from '../../src/pdf/outline';
import { applyPagePlan } from '../../src/pdf/pages';

async function blank(pages: number): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	for (let index = 0; index < pages; index++) doc.addPage([200 + index, 300]);
	return doc.save();
}

async function change(bytes: Uint8Array, step: BookmarkChange): Promise<Uint8Array> {
	const result = await changeBookmarks(bytes, step);
	if (result.kind !== 'changed') throw new Error(result.reason);
	return result.bytes;
}

interface Node {
	title: string;
	items: Node[];
}

// As a reader will see them: pdf.js is what the panel lists them with.
async function outline(bytes: Uint8Array): Promise<Node[]> {
	const pdf = await getDocument({ data: bytes.slice(), isEvalSupported: false, useWorkerFetch: false }).promise;
	const shape = (items: Node[] | null): Node[] => (items ?? []).map((item) => ({ title: item.title, items: shape(item.items) }));
	const result = shape(await pdf.getOutline());
	await pdf.destroy();
	return result;
}

const leaf = (title: string, items: Node[] = []): Node => ({ title, items });
const add = (title: string, pageNumber: number, inside: number[] | null = null): BookmarkChange => ({ kind: 'add', title, pageNumber, inside });

describe('bookmarks', () => {
	it('adds them in page order, whatever order they are added in', async () => {
		let bytes = await blank(4);
		bytes = await change(bytes, add('Three', 3));
		bytes = await change(bytes, add('One', 1));
		bytes = await change(bytes, add('Four', 4));
		expect(await outline(bytes)).toEqual([leaf('One'), leaf('Three'), leaf('Four')]);
	});

	it('nests one under another and renames, with umlauts intact', async () => {
		let bytes = await blank(3);
		bytes = await change(bytes, add('Kapitel', 1));
		bytes = await change(bytes, add('Abschnitt', 2, [0]));
		bytes = await change(bytes, { kind: 'rename', path: [0, 0], expected: 'Abschnitt', title: 'Übung für später' });
		expect(await outline(bytes)).toEqual([leaf('Kapitel', [leaf('Übung für später')])]);
	});

	it('removes one and relinks its neighbours', async () => {
		let bytes = await blank(3);
		for (const [title, page] of [['A', 1], ['B', 2], ['C', 3]] as const) bytes = await change(bytes, add(title, page));
		bytes = await change(bytes, { kind: 'remove', path: [1], expected: 'B' });
		expect(await outline(bytes)).toEqual([leaf('A'), leaf('C')]);
		bytes = await change(bytes, { kind: 'remove', path: [0], expected: 'A' });
		bytes = await change(bytes, { kind: 'remove', path: [0], expected: 'C' });
		expect(await outline(bytes)).toEqual([]);
	});

	it('will not touch an entry that is no longer the one on the list', async () => {
		let bytes = await blank(2);
		bytes = await change(bytes, add('Real', 1));
		const result = await changeBookmarks(bytes, { kind: 'remove', path: [0], expected: 'Stale' });
		expect(result.kind).toBe('refused');
		expect(await outline(bytes)).toEqual([leaf('Real')]);
	});

	it('survives the pages moving, and goes with a deleted page', async () => {
		let bytes = await blank(3);
		bytes = await change(bytes, add('Keep', 1));
		bytes = await change(bytes, add('Lose', 2));
		const result = await applyPagePlan(bytes, [{ page: 3 }, { page: 1 }]);
		if (result.kind !== 'reordered') throw new Error(result.kind);
		expect(await outline(result.bytes)).toEqual([leaf('Keep')]);
	});

	it('keeps a folded entry folded when another is added', async () => {
		let bytes = await blank(3);
		bytes = await change(bytes, add('Folded', 1));
		bytes = await change(bytes, add('Inside', 1, [0]));
		const doc = await PDFDocument.load(bytes);
		const root = doc.context.lookup(doc.catalog.get(PDFName.of('Outlines')), PDFDict);
		const entry = doc.context.lookup(root.get(PDFName.of('First')), PDFDict);
		entry.set(PDFName.of('Count'), doc.context.obj(-1));
		bytes = await change(await doc.save(), add('After', 3));
		const out = await PDFDocument.load(bytes);
		const outRoot = out.context.lookup(out.catalog.get(PDFName.of('Outlines')), PDFDict);
		const first = out.context.lookup(outRoot.get(PDFName.of('First')), PDFDict);
		expect(first.get(PDFName.of('Count'))?.toString()).toBe('-1');
		expect(outRoot.get(PDFName.of('Count'))?.toString()).toBe('2');
	});
});
