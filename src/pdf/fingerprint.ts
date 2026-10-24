import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPage, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';
import { isInklingAnnotationDict } from './annotationSync';

// A structural summary of everything a save must leave alone.
//
// pdf-lib is pinned at 1.17.1, its last release, and upstream is dormant.
// Its save() is a full re-serialize from its own object model, so anything
// that model doesn't represent faithfully is re-encoded from an incomplete
// picture. The failure that matters isn't a crash — it's a file that still
// opens, with something quietly missing, discovered months later. This is
// what makes that failure loud at the moment it happens.
//
// Deliberately excluded: InklingExpanded's own annotations, which every save is
// supposed to change. Everything else — page geometry, page content, the
// resources content refers to, other software's annotations, and the
// Keywords field carrying a handwritten note's template style — must come
// back identical.
//
// Every field here has to survive a pdf-lib round trip unchanged, or
// verification would refuse legitimate saves. That property is what
// tests/pdf/fingerprint.test.ts pins down first.

export interface PageFingerprint {
	mediaBox: string;
	contentLength: number;
	fontCount: number;
	xObjectCount: number;
	foreignAnnotations: string[];
}

export interface DocumentFingerprint {
	pageCount: number;
	keywords: string;
	pages: PageFingerprint[];
}

function streamLength(value: unknown): number {
	// A stream pdf-lib parsed but never decoded keeps its original bytes,
	// which is the strongest thing to compare; one it built itself reports
	// its own size.
	if (value instanceof PDFRawStream) return value.contents.length;
	if (value instanceof PDFStream) return value.getContentsSize();
	return 0;
}

// Note on what this can and cannot see: pdf-lib buffers page drawing
// operations and only materialises them into /Contents when the document is
// saved, so a page drawn on but not yet saved reports its pre-draw size.
// That is harmless here because InklingExpanded never draws into a page's content
// stream — every mark it makes is an annotation with its own appearance
// stream — so a content stream that changes at all is a change we did not
// make, which is exactly what this is watching for.
function contentLength(page: PDFPage): number {
	// Typed as unknown so the instanceof checks below do the narrowing —
	// /Contents is legally either one stream or an array of them.
	const contents: unknown = page.node.Contents();
	if (contents instanceof PDFArray) {
		let total = 0;
		for (let index = 0; index < contents.size(); index++) total += streamLength(contents.lookup(index));
		return total;
	}
	return streamLength(contents);
}

function resourceCount(page: PDFPage, key: string): number {
	const resources = page.node.Resources();
	if (!resources) return 0;
	return resources.lookupMaybe(PDFName.of(key), PDFDict)?.keys().length ?? 0;
}

function rectangle(dict: PDFDict): string {
	const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
	if (!rect) return '';
	const parts: string[] = [];
	for (let index = 0; index < rect.size(); index++) {
		const value = rect.lookupMaybe(index, PDFNumber);
		parts.push(value ? value.asNumber().toFixed(2) : '?');
	}
	return parts.join(',');
}

// Sorted, because /Annots order is not something we promise to preserve —
// removing and re-adding our own annotations legitimately reshuffles the
// array around the foreign ones left in place.
function foreignAnnotations(doc: PDFDocument, page: PDFPage): string[] {
	const annots = page.node.Annots();
	if (!annots) return [];

	const found: string[] = [];
	for (const entry of annots.asArray()) {
		let dict: PDFDict | undefined;
		try {
			if (entry instanceof PDFRef) dict = doc.context.lookupMaybe(entry, PDFDict);
			else if (entry instanceof PDFDict) dict = entry;
		} catch {
			// Unresolvable entry. Recorded as such rather than skipped, so
			// one appearing or vanishing still counts as a change.
			found.push('unresolvable');
			continue;
		}
		if (!dict || isInklingAnnotationDict(dict)) continue;
		const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() ?? 'unknown';
		found.push(`${subtype}[${rectangle(dict)}]`);
	}
	return found.sort();
}

export function fingerprintDocument(doc: PDFDocument): DocumentFingerprint {
	const pages = doc.getPages().map((page): PageFingerprint => {
		const box = page.getMediaBox();
		return {
			mediaBox: `${box.x.toFixed(2)},${box.y.toFixed(2)},${box.width.toFixed(2)},${box.height.toFixed(2)}`,
			contentLength: contentLength(page),
			fontCount: resourceCount(page, 'Font'),
			xObjectCount: resourceCount(page, 'XObject'),
			foreignAnnotations: foreignAnnotations(doc, page),
		};
	});

	return {
		// doc.getPageCount(), not pages.length. pdf-lib 1.17.1's removePage
		// updates its page count but — unlike insertPage — never invalidates
		// the page cache getPages() reads from, so getPages() goes stale
		// after a removal. Taking the count from the maintained counter means
		// a vanished page is caught here rather than slipping through into a
		// page-by-page walk of a list that still claims it exists.
		pageCount: doc.getPageCount(),
		// Carries a handwritten note's template style (inkling:template=...),
		// which "Add page" reads back — losing it silently breaks that.
		keywords: doc.getKeywords() ?? '',
		pages,
	};
}

// The first difference found, phrased for a log line and a notice, or null
// when the two are identical. First rather than all: the caller's only
// decision is whether to write, and one confirmed change already answers it.
export function compareFingerprints(before: DocumentFingerprint, after: DocumentFingerprint): string | null {
	if (before.pageCount !== after.pageCount) {
		return `page count changed from ${before.pageCount} to ${after.pageCount}`;
	}
	if (before.keywords !== after.keywords) {
		return `document keywords changed from "${before.keywords}" to "${after.keywords}"`;
	}

	for (let index = 0; index < before.pages.length; index++) {
		const wasPage = before.pages[index];
		const nowPage = after.pages[index];
		const number = index + 1;
		if (!wasPage || !nowPage) return `page ${number} is missing`;
		if (wasPage.mediaBox !== nowPage.mediaBox) {
			return `page ${number} media box changed from ${wasPage.mediaBox} to ${nowPage.mediaBox}`;
		}
		if (wasPage.contentLength !== nowPage.contentLength) {
			return `page ${number} content stream length changed from ${wasPage.contentLength} to ${nowPage.contentLength}`;
		}
		if (wasPage.fontCount !== nowPage.fontCount) {
			return `page ${number} font count changed from ${wasPage.fontCount} to ${nowPage.fontCount}`;
		}
		if (wasPage.xObjectCount !== nowPage.xObjectCount) {
			return `page ${number} XObject count changed from ${wasPage.xObjectCount} to ${nowPage.xObjectCount}`;
		}
		if (wasPage.foreignAnnotations.join('|') !== nowPage.foreignAnnotations.join('|')) {
			return `page ${number} annotations from other software changed`;
		}
	}

	return null;
}
