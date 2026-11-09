import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { StrokeAnnotation } from '../../src/annotate/types';
import { readInklingAnnotations, writeInklingAnnotations } from '../../src/pdf/annotationSync';
import { pageIdsOf } from '../../src/pdf/annotationWriterCore';
import { movedOrder, reorderPages } from '../../src/pdf/pages';

// Putting a PDF's pages in a new order.

function stroke(id: string): StrokeAnnotation {
	return { id, kind: 'stroke', tool: 'pen', color: '#1e1e1e', width: 3, points: [{ x: 100, y: 100 }, { x: 300, y: 100 }] };
}

// Three pages of different widths, each with its own ink.
async function threePages(): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	for (const [index, width] of [300, 400, 500].entries()) {
		doc.addPage([width, 700]);
		writeInklingAnnotations(doc, index, [stroke(`ink-${index + 1}`)]);
	}
	return doc.save();
}

const reordered = async (bytes: Uint8Array, order: number[]): Promise<PDFDocument> => {
	const result = await reorderPages(bytes, order);
	if (result.kind !== 'reordered') throw new Error(result.kind);
	return PDFDocument.load(result.bytes);
};

describe('moving pages in a PDF', () => {
	it('works out the order a move makes', () => {
		expect(movedOrder(4, 0, 2)).toEqual([2, 3, 1, 4]);
		expect(movedOrder(4, 3, 0)).toEqual([4, 1, 2, 3]);
	});

	it('puts the pages in the order asked for, each with its own ink', async () => {
		const doc = await reordered(await threePages(), [3, 1, 2]);
		expect(doc.getPages().map((page) => page.getWidth())).toEqual([500, 300, 400]);
		expect([0, 1, 2].map((index) => readInklingAnnotations(doc, index).map((a) => a.id))).toEqual([['ink-3'], ['ink-1'], ['ink-2']]);
	});

	it('leaves every page the same object in the file, which is how another device finds it', async () => {
		const original = await threePages();
		const before = pageIdsOf(await PDFDocument.load(original));
		const after = pageIdsOf(await reordered(original, [2, 3, 1]));
		expect(after).toEqual([before[1], before[2], before[0]]);
	});

	it('keeps what a page inherited from a branch of the tree it was moved out of', async () => {
		// Two pages under a branch that gives them their size and rotation.
		const doc = await PDFDocument.create();
		doc.addPage([100, 100]);
		doc.addPage([100, 100]);
		doc.addPage([612, 792]);
		const context = doc.context;
		const rootRef = doc.catalog.get(PDFName.of('Pages')) as PDFRef;
		const [first, second, third] = doc.getPages() as [ReturnType<typeof doc.getPage>, ReturnType<typeof doc.getPage>, ReturnType<typeof doc.getPage>];
		const branch = context.obj({
			Type: 'Pages',
			Parent: rootRef,
			Kids: [first.ref, second.ref],
			Count: 2,
			MediaBox: [0, 0, 300, 400],
			Rotate: 90,
		});
		const branchRef = context.register(branch);
		for (const page of [first, second]) {
			page.node.delete(PDFName.of('MediaBox'));
			page.node.set(PDFName.of('Parent'), branchRef);
		}
		const root = doc.catalog.Pages();
		root.set(PDFName.of('Kids'), context.obj([branchRef, third.ref]));

		const moved = await reordered(await doc.save(), [3, 1, 2]);
		expect(moved.getPages().map((page) => page.getWidth())).toEqual([612, 300, 300]);
		expect(moved.getPage(1).getRotation().angle).toBe(90);
		// And the tree is flat: nothing is left of the branch.
		const kids = moved.catalog.Pages().Kids();
		expect(kids.size()).toBe(3);
		expect(moved.catalog.Pages().lookup(PDFName.of('Count'), PDFNumber).asNumber()).toBe(3);
		for (let index = 0; index < 3; index++) expect(kids.lookup(index, PDFDict).lookup(PDFName.of('Parent'))).toBe(moved.catalog.Pages());
	});

	it('does nothing for the order the pages are already in', async () => {
		expect((await reorderPages(await threePages(), [1, 2, 3])).kind).toBe('unchanged');
	});

	it('refuses an order that is not every page exactly once', async () => {
		const bytes = await threePages();
		for (const order of [[1, 2], [1, 1, 2], [1, 2, 4], [1, 2, 3, 4]]) {
			expect((await reorderPages(bytes, order)).kind).toBe('refused');
		}
	});
});
