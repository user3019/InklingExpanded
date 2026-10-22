import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
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

	doc.removePage(pageNumber - 1);
	for (const ref of owned) doc.context.delete(ref);
	return { kind: 'removed', bytes: await doc.save(), pageCount: pageCount - 1 };
}
