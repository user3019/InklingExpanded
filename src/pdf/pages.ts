import { degrees, PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString, type PDFObject, type PDFPage } from 'pdf-lib';
import { createId } from '../annotate/id';
import { isInklingAnnotationDict } from './annotationSync';
import { removeBookmarksTo } from './outline';
import { riskyFeatures } from './compatibility';

// Taking a page out of a PDF, for good.

export type PageRemoval = { kind: 'removed'; bytes: Uint8Array; pageCount: number } | { kind: 'refused'; reason: string };

// The PDF without page `pageNumber` (from 1). Refused for the only page —
// a PDF with none is not one any reader opens — and for a PDF with a form
// or a signature, which rewriting it would break, for the same reason the
// annotate view will not write to one (see pdf/compatibility.ts).
//
// The page's own objects go with it: its dictionary, its content streams
// and its annotations. pdf-lib only unhooks a removed page from the page
// tree and writes everything else back, so without this the page would
// still be in the file, invisible but there to anyone who looked — which
// is not what deleting a page means. Fonts and images are left: another
// page may share them.
export async function removePage(bytes: ArrayBuffer | Uint8Array, pageNumber: number): Promise<PageRemoval> {
	const doc = await PDFDocument.load(bytes);
	const pageCount = doc.getPageCount();
	if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) return { kind: 'refused', reason: 'that page is not in this PDF' };
	if (pageCount === 1) return { kind: 'refused', reason: 'it is the only page' };
	const risky = riskyFeatures(doc);
	if (risky.length > 0) return { kind: 'refused', reason: `the PDF contains ${risky.join(' and ')}, which rewriting it would break` };

	const page = doc.getPage(pageNumber - 1);
	removeBookmarksTo(doc, new Set([page.ref]));
	doc.removePage(pageNumber - 1);
	deletePageObjects(doc, [page], doc.getPages());
	return { kind: 'removed', bytes: await doc.save(), pageCount: pageCount - 1 };
}

// ---- Rearranging a document ----

export type PageReorder = { kind: 'reordered'; bytes: Uint8Array } | { kind: 'unchanged' } | { kind: 'refused'; reason: string };

// One page of a document as it should come out: which page it is now (from
// 1), and how far to turn it, clockwise, in quarter turns' degrees. A page
// listed twice is duplicated; one not listed at all is deleted.
export interface PlannedPage {
	page: number;
	turn?: number;
}

// What a page has from the nodes above it in the tree unless it says
// otherwise (PDF 32000, table 31).
const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'].map((name) => PDFName.of(name));

// `count` pages with the one at index `from` moved to index `to`, as page
// numbers from 1 in their new order.
export function movedOrder(count: number, from: number, to: number): number[] {
	const order = Array.from({ length: count }, (_, index) => index + 1);
	const [page] = order.splice(from, 1);
	if (page !== undefined) order.splice(to, 0, page);
	return order;
}

function quarterTurns(angle: number): number {
	return ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
}

// A page's own objects, which go with it when it is deleted: its dictionary,
// content streams and annotations, with their appearances. Fonts and images
// are not among them: another page may share them.
function ownedObjects(doc: PDFDocument, page: PDFPage): PDFRef[] {
	const owned: PDFRef[] = [page.ref];
	const contents = page.node.get(PDFName.of('Contents'));
	if (contents instanceof PDFRef) {
		owned.push(contents);
		const list = doc.context.lookupMaybe(contents, PDFArray);
		if (list) for (const entry of list.asArray()) if (entry instanceof PDFRef) owned.push(entry);
	} else if (contents instanceof PDFArray) {
		for (const entry of contents.asArray()) if (entry instanceof PDFRef) owned.push(entry);
	}
	const annots = page.node.Annots();
	if (annots) {
		for (const entry of annots.asArray()) {
			if (!(entry instanceof PDFRef)) continue;
			owned.push(entry);
			const appearance = doc.context.lookupMaybe(entry, PDFDict)?.lookupMaybe(PDFName.of('AP'), PDFDict)?.get(PDFName.of('N'));
			if (appearance instanceof PDFRef) owned.push(appearance);
		}
	}
	return owned;
}

// Everything that leaves a page by reference, set aside for the length of
// `copy`. Copying follows references, and these lead to other pages and from
// them to the whole document: a link to the next chapter, an annotation's
// /P naming its page, a thread's beads. Left in, a page exported on its own
// would carry every other page of the PDF with it, unseen, into the new file.
async function standingAlone<T>(doc: PDFDocument, page: PDFPage, copy: () => Promise<T>): Promise<T> {
	const annotsKey = PDFName.of('Annots');
	const beadsKey = PDFName.of('B');
	const ownerKey = PDFName.of('P');
	const annotsBefore = page.node.get(annotsKey);
	const beadsBefore = page.node.get(beadsKey);
	const owners: [PDFDict, PDFObject][] = [];
	const setOwnerAside = (dict: PDFDict | undefined) => {
		const owner = dict?.get(ownerKey);
		if (dict && owner) {
			owners.push([dict, owner]);
			dict.delete(ownerKey);
		}
	};
	const annots = page.node.Annots();
	if (annots) {
		const kept: PDFObject[] = [];
		for (const entry of annots.asArray()) {
			const dict = doc.context.lookupMaybe(entry, PDFDict);
			if (dict?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() === 'Link') continue;
			kept.push(entry);
			setOwnerAside(dict);
			setOwnerAside(dict?.lookupMaybe(PDFName.of('Popup'), PDFDict));
		}
		page.node.set(annotsKey, doc.context.obj(kept));
	}
	page.node.delete(beadsKey);
	try {
		return await copy();
	} finally {
		if (annotsBefore) page.node.set(annotsKey, annotsBefore);
		if (beadsBefore) page.node.set(beadsKey, beadsBefore);
		for (const [dict, owner] of owners) dict.set(ownerKey, owner);
	}
}

// Takes deleted pages' own objects out of the file — all but any a page that
// stays also uses, which a PDF is free to share between pages.
function deletePageObjects(doc: PDFDocument, removed: readonly PDFPage[], kept: readonly PDFPage[]): void {
	const stillUsed = new Set(kept.flatMap((page) => ownedObjects(doc, page)));
	for (const page of removed) for (const ref of ownedObjects(doc, page)) if (!stillUsed.has(ref)) doc.context.delete(ref);
}

// The document with its pages as `plan` says: in that order, turned, copied
// or left out. Refused for a form or a signature, as a deletion always was.
//
// Only the page tree changes, for the pages that stay. Each is the same
// object in the file as it was, with its ink, its links and every bookmark
// that points at it — which is also how another device with this PDF open
// finds its pages again after they have moved (see pageIdsOf in
// annotationWriterCore.ts).
//
// The tree is laid flat rather than edited branch by branch. A page can
// inherit its size, its fonts or its rotation from a branch above it, and
// would lose them on being moved out of it — so whatever a page inherits is
// first written onto the page.
export async function applyPagePlan(bytes: ArrayBuffer | Uint8Array, plan: readonly PlannedPage[]): Promise<PageReorder> {
	const doc = await PDFDocument.load(bytes);
	const count = doc.getPageCount();
	if (plan.length === 0) return { kind: 'refused', reason: 'a PDF needs at least one page' };
	if (plan.some(({ page, turn = 0 }) => !Number.isInteger(page) || page < 1 || page > count || turn % 90 !== 0)) {
		return { kind: 'refused', reason: 'the PDF changed while its pages were being arranged' };
	}
	if (plan.length === count && plan.every(({ page, turn = 0 }, index) => page === index + 1 && quarterTurns(turn) === 0)) return { kind: 'unchanged' };
	const risky = riskyFeatures(doc);
	if (risky.length > 0) return { kind: 'refused', reason: `the PDF contains ${risky.join(' and ')}, which rewriting it would break` };

	const parentKey = PDFName.of('Parent');
	const rootRef = doc.catalog.get(PDFName.of('Pages'));
	const root = doc.catalog.Pages();
	if (!(rootRef instanceof PDFRef)) return { kind: 'refused', reason: 'its page tree could not be read' };

	const pages = doc.getPages();
	const branches = new Set<PDFRef>();
	for (const page of pages) {
		const { node } = page;
		// Up the tree from the page, nearest first: the nearest value wins.
		let parentRef = node.get(parentKey);
		const inherited = INHERITED.filter((key) => !node.has(key));
		while (parentRef instanceof PDFRef) {
			const parent = doc.context.lookupMaybe(parentRef, PDFDict);
			if (!parent) break;
			if (parentRef !== rootRef) branches.add(parentRef);
			for (let index = inherited.length - 1; index >= 0; index--) {
				const key = inherited[index] as PDFName;
				const value = parent.get(key);
				if (!value) continue;
				node.set(key, value.clone(doc.context));
				inherited.splice(index, 1);
			}
			parentRef = parent.get(parentKey);
		}
		node.set(parentKey, rootRef);
	}

	// The first mention of a page is the page; any further one, a copy of it.
	// Turned afterwards, each by its own amount, so a copy can differ.
	const used = new Set<number>();
	const result: PDFPage[] = [];
	for (const { page: number, turn = 0 } of plan) {
		const original = pages[number - 1] as PDFPage;
		let page = original;
		if (used.has(number)) {
			const [copy] = await standingAlone(doc, original, () => doc.copyPages(doc, [number - 1]));
			if (!copy) return { kind: 'refused', reason: 'a page could not be copied' };
			giveCopyOwnIds(doc, copy);
			page = copy;
		}
		used.add(number);
		if (quarterTurns(turn) !== 0) page.setRotation(degrees(quarterTurns(page.getRotation().angle + turn)));
		page.node.set(parentKey, rootRef);
		result.push(page);
	}

	root.set(PDFName.of('Kids'), doc.context.obj(result.map((page) => page.ref)));
	root.set(PDFName.of('Count'), doc.context.obj(result.length));
	for (const branch of branches) doc.context.delete(branch);

	const removed = pages.filter((_, index) => !used.has(index + 1));
	if (removed.length > 0) {
		removeBookmarksTo(doc, new Set(removed.map((page) => page.ref)));
		deletePageObjects(doc, removed, result);
	}
	return { kind: 'reordered', bytes: await doc.save() };
}

// Ink on a copied page is new ink: the same id twice would be one drawing
// to everything that merges or syncs by id.
function giveCopyOwnIds(doc: PDFDocument, copy: PDFPage): void {
	const annots = copy.node.Annots();
	if (!annots) return;
	for (const entry of annots.asArray()) {
		const dict = doc.context.lookupMaybe(entry, PDFDict);
		if (dict && isInklingAnnotationDict(dict)) dict.set(PDFName.of('NM'), PDFString.of(createId()));
	}
}

// The PDF with its pages in `order`: original page numbers, from 1, in the
// order they should now come.
export async function reorderPages(bytes: ArrayBuffer | Uint8Array, order: readonly number[]): Promise<PageReorder> {
	const unique = new Set(order);
	const total = (await PDFDocument.load(bytes)).getPageCount();
	if (order.length !== total || unique.size !== total) return { kind: 'refused', reason: 'the PDF changed while its pages were being arranged' };
	return applyPagePlan(bytes, order.map((page) => ({ page })));
}

export type PageExport = { kind: 'exported'; bytes: Uint8Array } | { kind: 'refused'; reason: string };

// A new PDF of just these pages, ink included. A form's fields are tied to
// the rest of the form, so a PDF with one is refused rather than exported
// with its answers missing; a picture of the page has no such problem.
export async function extractPages(bytes: ArrayBuffer | Uint8Array, plan: readonly PlannedPage[]): Promise<PageExport> {
	const source = await PDFDocument.load(bytes);
	const risky = riskyFeatures(source);
	if (risky.length > 0) return { kind: 'refused', reason: `the PDF contains ${risky.join(' and ')} — export the pages as pictures instead` };
	const count = source.getPageCount();
	if (plan.length === 0 || plan.some(({ page }) => !Number.isInteger(page) || page < 1 || page > count)) {
		return { kind: 'refused', reason: 'the PDF changed while its pages were being arranged' };
	}
	const target = await PDFDocument.create();
	for (const { page: number, turn = 0 } of plan) {
		const original = source.getPage(number - 1);
		const [copy] = await standingAlone(source, original, () => target.copyPages(source, [number - 1]));
		if (!copy) continue;
		if (quarterTurns(turn) !== 0) copy.setRotation(degrees(quarterTurns(copy.getRotation().angle + turn)));
		target.addPage(copy);
	}
	return { kind: 'exported', bytes: await target.save() };
}
