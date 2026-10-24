import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';

// Whether `pdf-lib` can be trusted to rewrite a given document at all.
//
// The save-time fingerprint (see fingerprint.ts) compares a saved document
// against the in-memory one it came from. That cannot catch the case where
// `pdf-lib`'s *initial parse* already lost something — by then the loss is
// baked into the baseline being compared against.
//
// InklingExpanded already parses every file twice on open: once with `pdf.js`, to
// render, and once with `pdf-lib`, to read annotations back. Those are two
// independent implementations reading the same bytes, so comparing what
// they each believe about the document's shape costs almost nothing and
// catches exactly that case. Disagreement means `pdf-lib`'s model of this
// file is incomplete, and every save would serialize from that incomplete
// model — so the file opens read-only instead.
//
// This module holds the shape both sides produce and the comparison
// between them. Neither parser is imported by the pdf.js side; it builds
// the same structure from its own API (see src/pdfView.ts).

export interface PageProfile {
	mediaBox: string;
	// Normalised to 0/90/180/270. The two parsers report rotation from
	// different places in the page tree, and a document can legally state it
	// as a negative or out-of-range multiple of 90.
	rotation: number;
}

export interface StructureProfile {
	pageCount: number;
	// Only the sampled pages, not all of them — see samplePageIndices.
	sampledPages: { index: number; page: PageProfile }[];
}

// How many pages to check. Every page beyond page count costs a pdf.js
// `getPage` call, which on a 900-page scanned book is real time on the one
// thread the user is waiting on. Ten pages spread through the document is
// enough to catch a parser that has misread the document's structure, which
// is a whole-document property rather than something that afflicts one page
// in five hundred.
const DEFAULT_SAMPLE_LIMIT = 10;

// Evenly spread, always including the first and last page. The ends matter
// disproportionately: a truncated page tree shows up at the end, and a
// misread first page is what a cover or a scanned insert produces.
export function samplePageIndices(pageCount: number, limit: number = DEFAULT_SAMPLE_LIMIT): number[] {
	if (!Number.isFinite(pageCount) || pageCount <= 0) return [];
	const count = Math.min(Math.floor(pageCount), Math.max(1, Math.floor(limit)));
	if (pageCount <= count) return Array.from({ length: Math.floor(pageCount) }, (_, index) => index);
	if (count === 1) return [0];

	const indices = new Set<number>();
	for (let step = 0; step < count; step++) {
		indices.add(Math.round((step * (pageCount - 1)) / (count - 1)));
	}
	return [...indices].sort((a, b) => a - b);
}

// One string, so a comparison is one `!==` rather than four float
// comparisons with their own tolerance question. Two decimal places: the
// two parsers agree to well within that, and a raw float comparison would
// disagree on the last bit for no reason anyone cares about.
export function formatMediaBox(x: number, y: number, width: number, height: number): string {
	return `${x.toFixed(2)},${y.toFixed(2)},${width.toFixed(2)},${height.toFixed(2)}`;
}

export function normalizeRotation(degrees: number): number {
	if (!Number.isFinite(degrees)) return 0;
	return (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;
}

export function profileFromPdfLib(doc: PDFDocument): StructureProfile {
	const pageCount = doc.getPageCount();
	const sampledPages: StructureProfile['sampledPages'] = [];
	for (const index of samplePageIndices(pageCount)) {
		const page = doc.getPage(index);
		const box = page.getMediaBox();
		sampledPages.push({
			index,
			page: { mediaBox: formatMediaBox(box.x, box.y, box.width, box.height), rotation: normalizeRotation(page.getRotation().angle) },
		});
	}
	return { pageCount, sampledPages };
}

// Deliberately not compared: **annotation counts**.
//
// An earlier draft had them. They cannot work here. The pdf.js side parses
// `displayBytes`, which is the file with InklingExpanded's own annotations stripped
// out precisely so its annotation-baking render doesn't double up with our
// live overlay — so on any file the user has already annotated the two
// sides disagree by design. Beyond that, pdf.js filters what it returns by
// render intent and pdf-lib does not, so the counts would drift on ordinary
// documents too.
//
// The cost of a false positive here is a book that opens read-only for no
// reason, which is worse than the check is worth. Losing annotations to a
// bad round trip is caught by the save-time fingerprint instead, which
// compares pdf-lib against pdf-lib and so has no cross-parser problem.
export function compareProfiles(pdfLib: StructureProfile, pdfJs: StructureProfile): string | null {
	if (pdfLib.pageCount !== pdfJs.pageCount) {
		return `the two PDF readers disagree on how many pages it has (${pdfLib.pageCount} and ${pdfJs.pageCount})`;
	}

	const byIndex = new Map(pdfJs.sampledPages.map((entry) => [entry.index, entry.page]));
	for (const { index, page } of pdfLib.sampledPages) {
		const other = byIndex.get(index);
		// A page one side sampled and the other didn't is not a
		// disagreement about the document — samplePageIndices is
		// deterministic, so this only happens if the counts already differ,
		// which is handled above.
		if (!other) continue;
		if (page.mediaBox !== other.mediaBox) {
			return `the two PDF readers disagree on the size of page ${index + 1} (${page.mediaBox} and ${other.mediaBox})`;
		}
		if (page.rotation !== other.rotation) {
			return `the two PDF readers disagree on the rotation of page ${index + 1} (${page.rotation}° and ${other.rotation}°)`;
		}
	}

	return null;
}

// Structure `pdf-lib` is known to round-trip badly, named for a notice.
// Empty for almost every real book.
//
// Checked independently of the cross-parser comparison above, because these
// are cases where both parsers can agree perfectly and the round trip still
// destroys something: a form's field values, a signature's validity. Both
// are things the file's owner would not forgive losing, and neither shows
// up as a geometry difference.
export function riskyFeatures(doc: PDFDocument): string[] {
	const found: string[] = [];
	try {
		const catalog = doc.catalog;

		const acroForm = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
		const fields = acroForm?.lookupMaybe(PDFName.of('Fields'), PDFArray);
		if (fields && fields.size() > 0) found.push('an interactive form');

		// A signature makes itself known two ways: a /SigFlags bit on the
		// form, and /Perms on the catalog. Either is enough — re-serializing
		// invalidates the signature whichever way it was declared.
		const sigFlags = acroForm?.lookupMaybe(PDFName.of('SigFlags'), PDFNumber)?.asNumber() ?? 0;
		const signed = (sigFlags & 1) === 1 || catalog.lookupMaybe(PDFName.of('Perms'), PDFDict) !== undefined;
		if (signed) found.push('a digital signature');
	} catch (error) {
		// A catalog this can't walk is itself a reason for caution, but not
		// a reason to fail the open — the cross-parser comparison above still
		// gets its say.
		console.error('InklingExpanded: could not check this PDF for forms or signatures.', error);
		found.push('structure that could not be read');
	}
	return found;
}
