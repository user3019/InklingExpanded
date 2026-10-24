import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import { getDocument, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
// From types, not the '../annotate' barrel: the barrel re-exports the
// toolbar, which imports the Obsidian API, and pulling that in here made
// this module — the whole of PDF reading — impossible to test in Node.
import { ALL_PRESET_COLORS } from '../annotate/types';
import { ID_PREFIX, INKLING_EXTRAS, QUOTE_KEY } from '../pdf/annotationFormat';
import { groupIntoLines, quoteBetween, type PositionedBox } from '../pdf/textLines';
import type { ExtractedAnnotation } from './extractFormat';

// Reading a PDF's annotations back out, with their text.
//
// Two libraries, each doing the half it can. pdf-lib reads the annotation
// dictionaries — it sees every key, including /NM (the stable `ink-` id)
// and our own private /InklingExpanded /Q (the words a highlight covered, captured
// when it was drawn). pdf.js reads the page text, which is the one thing
// pdf-lib cannot do.
//
// This was pdf.js for both, on the reasoning that one parse and one set of
// conventions beats reconciling two views of the same file. The reasoning
// was sound; the premise was not. pdf.js exposes no /NM and no private keys
// at all, so every annotation read back as foreign however plainly it was
// ours, every block reference was derived from a position rather than the
// stable id sitting right there in the file, and the stored quote was never
// read — which meant a scanned page, with highlights but no text layer,
// extracted nothing at all.
//
// Nothing extra is written to make this work. The PDF already carried all
// of it; only the reader had to change. Extraction stays strictly
// read-only: pdf-lib is used to load and inspect, never to save.

// The default colour categories: the palette's own names. Track D lets
// these be renamed, so "Yellow = definition, Red = disagree" works.
export function defaultColorLabels(): Record<string, string> {
	const labels: Record<string, string> = {};
	for (const { value, label } of ALL_PRESET_COLORS) labels[value.toLowerCase()] = label;
	return labels;
}

interface Rect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

// Annotations a person added to mark up the document, which is the PDF
// specification's own distinction (a "markup annotation", ISO 32000-1
// table 171) and exactly the line extraction wants.
//
// Everything outside this set is furniture rather than markup: /Link most
// of all. A link's rectangle sits directly on the text it links from, and
// since a quote is recovered from the words under a rectangle, every entry
// in a table of contents came back looking precisely like a highlight of
// its own chapter title. Measured on the book that prompted this: 195
// pages, 201 link annotations, 0 of them anybody's highlight, and an
// annotations note with 207 entries in it.
//
// /Widget (form fields) and /Popup (the box attached to another
// annotation, whose text belongs to its parent) are excluded for the same
// reason.
const MARKUP_SUBTYPES: ReadonlySet<string> = new Set([
	'Text',
	'FreeText',
	'Line',
	'Square',
	'Circle',
	'Polygon',
	'PolyLine',
	'Highlight',
	'Underline',
	'Squiggly',
	'StrikeOut',
	'Stamp',
	'Caret',
	'Ink',
	'FileAttachment',
	'Redact',
]);

// A text string out of a dictionary.
//
// Both string types are accepted because both are legal and other software
// writes both: a literal `(note)` and a hex `<6E6F7465>` are the same value
// spelled differently, and a reader that knows only one of them silently
// loses every comment written by whichever tool prefers the other.
function textOf(dict: PDFDict, key: string): string {
	const value = dict.lookup(PDFName.of(key));
	if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText().trim();
	return '';
}

function toHex(r: number, g: number, b: number): string {
	const part = (v: number) =>
		Math.round(Math.max(0, Math.min(1, v)) * 255)
			.toString(16)
			.padStart(2, '0');
	return `#${part(r)}${part(g)}${part(b)}`;
}

// An annotation's colour from /C, whose component count says which space it
// is in — 1 grey, 3 RGB, 4 CMYK, and 0 meaning "no colour", which the spec
// allows and which is why this can come back empty.
function colorOf(dict: PDFDict): string {
	const array = dict.lookupMaybe(PDFName.of('C'), PDFArray);
	if (!array) return '';

	const parts = array
		.asArray()
		.filter((entry): entry is PDFNumber => entry instanceof PDFNumber)
		.map((entry) => entry.asNumber());

	const [a, b, c, d] = parts;
	if (parts.length === 1 && a !== undefined) return toHex(a, a, a);
	if (parts.length === 3 && a !== undefined && b !== undefined && c !== undefined) return toHex(a, b, c);
	if (parts.length === 4 && a !== undefined && b !== undefined && c !== undefined && d !== undefined) {
		return toHex((1 - a) * (1 - d), (1 - b) * (1 - d), (1 - c) * (1 - d));
	}
	return '';
}

function rectOf(dict: PDFDict): Rect | null {
	const array = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
	if (!array) return null;

	const [x1, y1, x2, y2] = array
		.asArray()
		.filter((entry): entry is PDFNumber => entry instanceof PDFNumber)
		.map((entry) => entry.asNumber());
	if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return null;

	// Normalised, because a /Rect is only required to name two opposite
	// corners — it is not required to name them in any particular order.
	return {
		minX: Math.min(x1, x2),
		minY: Math.min(y1, y2),
		maxX: Math.max(x1, x2),
		maxY: Math.max(y1, y2),
	};
}

// A page's text, grouped into lines, in the page's own PDF space — which is
// the space annotation rects are already in, so no viewport conversion is
// needed here at all. That is the whole reason extraction can work on a
// file nobody has opened for editing.
async function pageLines(page: PDFPageProxy) {
	const content = await page.getTextContent();
	const boxes: PositionedBox[] = [];
	for (const item of content.items) {
		if (!('str' in item) || !item.str.trim()) continue;
		const [, , , , e, f] = item.transform as [number, number, number, number, number, number];
		boxes.push({
			text: item.str,
			minX: e,
			maxX: e + item.width,
			centerY: f + item.height / 2,
			height: Math.max(item.height, 1),
		});
	}
	return groupIntoLines(boxes);
}

// The words an annotation's rectangle covers, recomputed from the page's
// text. This is what makes extraction work retroactively — on highlights
// made before quotes were stored, and on ones made in other PDF software,
// which never stored anything of ours at all.
function quoteUnder(lines: ReturnType<typeof groupIntoLines>, rect: Rect): string {
	const parts: string[] = [];
	for (const line of lines) {
		const half = line.height / 2;
		if (line.centerY + half < rect.minY || line.centerY - half > rect.maxY) continue;
		const quote = quoteBetween(line, rect.minX, rect.maxX);
		if (quote) parts.push(quote);
	}
	return parts.join(' ');
}

export interface CollectOptions {
	// Called as each page is read, so a long book can report progress
	// instead of appearing to hang.
	onProgress?: (pageNumber: number, pageCount: number) => void;
}

// One annotation, read as far as the dictionaries alone can take it. `rect`
// and `needsQuote` are working state and do not survive into the result.
interface Pending {
	entry: ExtractedAnnotation;
	rect: Rect;
	needsQuote: boolean;
}

function readAnnotationDict(dict: PDFDict, pageNumber: number): Pending | null {
	const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() ?? '';
	if (!MARKUP_SUBTYPES.has(subtype)) return null;

	const rect = rectOf(dict);
	if (!rect) return null;

	const name = textOf(dict, 'NM');
	const foreign = !name.startsWith(ID_PREFIX);

	// Ours if it carries our tag, and then the quote it was drawn over was
	// stored with it — so no text layer is needed to recover it, and a
	// scanned page reads back exactly as well as a typeset one.
	const stored = dict.lookupMaybe(PDFName.of(INKLING_EXTRAS), PDFDict);
	const quote = stored ? textOf(stored, QUOTE_KEY) : '';

	return {
		rect,
		needsQuote: !quote,
		entry: {
			// A foreign annotation may carry no name of its own, so one is
			// derived from where it sits. Ours does carry one, and using it
			// is what makes a block reference in the extracted note survive
			// the annotation moving.
			id: name || `ext-p${pageNumber}-${Math.round(rect.minX)}-${Math.round(rect.minY)}`,
			pageNumber,
			color: colorOf(dict) || '#1e1e1e',
			quote,
			note: textOf(dict, 'Contents'),
			foreign,
			top: rect.maxY,
		},
	};
}

// Recovers the quotes that were not stored, by reading the text under each
// annotation. Only pages that need it are opened, and if none do, pdf.js is
// never loaded at all — which is the common case for a book annotated in
// InklingExpanded, and why reading annotation dictionaries with a second library
// does not make extraction slower.
async function fillMissingQuotes(bytes: ArrayBuffer, byPage: Map<number, Pending[]>): Promise<void> {
	const pages = [...byPage].filter(([, pending]) => pending.some((p) => p.needsQuote)).map(([pageNumber]) => pageNumber);
	if (pages.length === 0) return;

	let pdf: PDFDocumentProxy | null = null;
	try {
		pdf = await getDocument({ data: bytes, isEvalSupported: false }).promise;
		for (const pageNumber of pages) {
			if (pageNumber > pdf.numPages) continue;
			const lines = await pageLines(await pdf.getPage(pageNumber));
			for (const pending of byPage.get(pageNumber) ?? []) {
				if (pending.needsQuote) pending.entry.quote = quoteUnder(lines, pending.rect);
			}
		}
	} finally {
		await pdf?.destroy();
	}
}

export async function collectAnnotations(bytes: ArrayBuffer, options: CollectOptions = {}): Promise<ExtractedAnnotation[]> {
	const doc = await PDFDocument.load(bytes, { updateMetadata: false });
	const pages = doc.getPages();

	const byPage = new Map<number, Pending[]>();
	for (let index = 0; index < pages.length; index++) {
		const pageNumber = index + 1;
		options.onProgress?.(pageNumber, pages.length);

		const annots = pages[index]?.node.Annots();
		if (!annots) continue;

		const pending: Pending[] = [];
		for (const entry of annots.asArray()) {
			// An /Annots entry is normally a reference, but the spec permits
			// the dictionary inline and some writers take it.
			const dict = entry instanceof PDFRef ? doc.context.lookupMaybe(entry, PDFDict) : entry instanceof PDFDict ? entry : null;
			if (!dict) continue;

			try {
				const read = readAnnotationDict(dict, pageNumber);
				if (read) pending.push(read);
			} catch (error) {
				// One malformed annotation in a book is not a reason to
				// extract none of the others.
				console.error('InklingExpanded: skipping an unreadable annotation while extracting.', error);
			}
		}

		if (pending.length > 0) byPage.set(pageNumber, pending);
	}

	await fillMissingQuotes(bytes, byPage);

	const found: ExtractedAnnotation[] = [];
	for (const pending of byPage.values()) {
		for (const { entry } of pending) {
			// A pen doodle in a margin is not a note. Including every stroke
			// would bury the annotations that are.
			if (!entry.quote && !entry.note) continue;
			found.push(entry);
		}
	}
	return found;
}
