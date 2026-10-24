// Turning a book's annotations into a note, as pure text.
//
// All of extraction's decision-making — grouping, ordering, categorising,
// and how a regenerated note merges with one the user has written around —
// with no Obsidian and no pdf.js in it, so it can be tested properly. The
// half that reads a PDF lives in extract.ts.

export interface ExtractedAnnotation {
	id: string;
	pageNumber: number;
	color: string;
	quote: string;
	note: string;
	// Written by other PDF software rather than by InklingExpanded. Labelled in the
	// output, because "I highlighted this in Xodo two years ago" is real
	// context about how much to trust a quote.
	foreign: boolean;
	// The annotation's top edge in PDF space, where y grows upward — so
	// sorting descending puts the top of the page first.
	top: number;
}

// The generated region's fences. Everything outside them is the user's and
// is never touched, so a note can carry an introduction, tags, links and
// outgoing thoughts across re-runs.
//
// Inside, the region is rebuilt from scratch every time. That is a
// deliberate simplification over merging per annotation: a predictable rule
// the user can plan around beats a clever one they have to reverse-engineer
// on the day it guesses wrong. The marker says so, in the note itself.
export const BEGIN_MARKER = '%% inkling:begin — generated, edits inside this block are replaced %%';
export const END_MARKER = '%% inkling:end %%';

// Neutralises anything in a quote that would break the note's structure.
//
// The text comes out of a PDF that other software can write to, so it is
// not trusted: a quote containing the end marker would truncate the managed
// region and orphan everything after it. Nothing here is rendered as
// markup, so this is about structure, not safety.
function safeText(text: string): string {
	return text
		.replace(/%%/g, '%​%')
		.replace(/\s+/g, ' ')
		.trim();
}

function colorLabel(color: string, labels: Record<string, string>): string {
	// An unrecognised colour renders as its hex value rather than being
	// dropped or lumped in with a known one: a custom colour is still a
	// category, just an unnamed one.
	return labels[color.toLowerCase()] ?? color;
}

function renderEntry(annotation: ExtractedAnnotation, pdfPath: string, labels: Record<string, string>): string[] {
	const category = colorLabel(annotation.color, labels);
	const source = annotation.foreign ? `${category} · external` : category;

	const lines: string[] = [];
	const quote = safeText(annotation.quote);
	lines.push(quote ? `- **p. ${annotation.pageNumber}** · ${source} — > ${quote}` : `- **p. ${annotation.pageNumber}** · ${source}`);

	const note = safeText(annotation.note);
	if (note) lines.push(`\t${note}`);

	// The block reference is built from the annotation's own id, so any note
	// in the vault can link to one specific highlight and the link survives
	// every re-run.
	lines.push(`\t[[${pdfPath}#page=${annotation.pageNumber}]] ^${annotation.id}`);
	return lines;
}

export function renderExtraction(
	pdfPath: string,
	annotations: ExtractedAnnotation[],
	colorLabels: Record<string, string>,
): string {
	const labels: Record<string, string> = {};
	for (const [color, label] of Object.entries(colorLabels)) labels[color.toLowerCase()] = label;

	const byPage = new Map<number, ExtractedAnnotation[]>();
	for (const annotation of annotations) {
		const page = byPage.get(annotation.pageNumber) ?? [];
		page.push(annotation);
		byPage.set(annotation.pageNumber, page);
	}

	const lines: string[] = [BEGIN_MARKER, ''];
	if (annotations.length === 0) {
		lines.push('No annotations found in this PDF yet.', '');
	}

	for (const pageNumber of [...byPage.keys()].sort((a, b) => a - b)) {
		const page = byPage.get(pageNumber) ?? [];
		// Top of the page first. Ties broken by id so two annotations on the
		// same line come out in a stable order rather than in whatever order
		// the PDF happened to list them — which is what makes a re-run
		// byte-identical.
		page.sort((a, b) => b.top - a.top || a.id.localeCompare(b.id));

		lines.push(`### Page ${pageNumber}`, '');
		for (const annotation of page) lines.push(...renderEntry(annotation, pdfPath, labels));
		lines.push('');
	}

	lines.push(END_MARKER);
	return lines.join('\n');
}

// Puts `generated` into `existing`, replacing whatever was between the
// markers and leaving everything outside them exactly as it was.
export function mergeIntoNote(existing: string, generated: string): string {
	const begin = existing.indexOf(BEGIN_MARKER);
	if (begin === -1) {
		// No managed region yet. Appended rather than prepended, so an
		// existing note keeps whatever it opens with.
		const prefix = existing.trim();
		return prefix ? `${prefix}\n\n${generated}\n` : `${generated}\n`;
	}

	const endIndex = existing.indexOf(END_MARKER, begin);
	// A begin with no end is a previous run that was cut short — the rest of
	// the file is the region. Treating it as unmanaged instead would append
	// a second region below the truncated first, and do it again every run.
	const after = endIndex === -1 ? '' : existing.slice(endIndex + END_MARKER.length);

	return `${existing.slice(0, begin)}${generated}${after}`;
}

// Where a PDF's annotations note lives. `{folder}` and `{name}` are the
// PDF's own, so the note sits beside the book by default and moves with a
// setting rather than with code (Track D).
export function extractionNotePath(pattern: string, pdfPath: string): string {
	const lastSlash = pdfPath.lastIndexOf('/');
	const folder = lastSlash === -1 ? '' : pdfPath.slice(0, lastSlash);
	const file = pdfPath.slice(lastSlash + 1);
	const name = file.replace(/\.pdf$/i, '');

	const filled = pattern.replace(/\{folder\}/g, folder).replace(/\{name\}/g, name);
	// A PDF at the vault root leaves {folder} empty, which would otherwise
	// produce a path starting with a slash.
	return filled.replace(/^\/+/, '');
}
