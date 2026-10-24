import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { classifyIncrementalSave } from '../../src/pdf/incrementalClassify';
import { beginIncrementalSession, saveIncrementally } from '../../src/pdf/incrementalSave';
import { writeInklingAnnotations } from '../../src/pdf/annotationSync';
import { toArrayBuffer } from '../../src/binary';
import type { Annotation } from '../../src/annotate/types';

const probeStroke: Annotation = {
	id: 'ink-vault-probe',
	kind: 'stroke',
	tool: 'pen',
	color: '#e03131',
	width: 3,
	points: [
		{ x: 40, y: 40 },
		{ x: 120, y: 120 },
	],
};

// Opt-in, because a suite that depends on the user's library cannot run in
// CI, depends on files not in the repository, and changes meaning every time
// a book is added or removed. Point it at one and it answers the only
// question the generated fixtures cannot:
//
//   INKLING_PDF_LIBRARY=/path/to/vault npx vitest run tests/pdf/vaultLibrary.test.ts
//
// What it checks is *total coverage*, not a decline rate. A library where
// every file declines is a disappointing result, not a failing test — the
// failure worth catching is a file the classifier cannot reach a decision
// about at all, because that is the case the whole decline path exists to
// make impossible.
const library = process.env.INKLING_PDF_LIBRARY;

// The append check below parses each book with pdf-lib *and* pdf.js, and the
// memory never comes back between books: pdf-lib interns every PDFRef in a
// module-level pool that is never cleared, so twenty books' worth of refs
// accumulate for the life of the process. Twenty real books exhausted a 10 GB
// heap.
//
// That is a property of checking a whole library in one process, not of the
// plugin — which holds exactly one book, in one worker, for one file. So the
// append check is capped by default and the cap is liftable per run:
//
//   INKLING_PDF_MAX_MB=40 NODE_OPTIONS=--max-old-space-size=8192 //     INKLING_PDF_LIBRARY=... npx vitest run tests/pdf/vaultLibrary.test.ts
//
// Point it at a folder holding only the largest books to cover those. The
// classifier check above has no such cap: it never parses anything.
const maxAppendBytes = Number(process.env.INKLING_PDF_MAX_MB ?? 12) * 1024 * 1024;

function pdfsUnder(root: string, found: string[] = []): string[] {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue;
		const path = join(root, entry.name);
		if (entry.isDirectory()) pdfsUnder(path, found);
		else if (entry.name.toLowerCase().endsWith('.pdf')) found.push(path);
	}
	return found;
}

describe.skipIf(!library)('the classifier against a real library', () => {
	it(
		'reaches a decision on every PDF it finds, without throwing',
		async () => {
			const files = pdfsUnder(library ?? '');
			expect(files.length).toBeGreaterThan(0);

			const declined: string[] = [];
			const byStyle = new Map<string, number>();

			for (const path of files) {
				const bytes = new Uint8Array(readFileSync(path));
				let doc: PDFDocument;
				try {
					doc = await PDFDocument.load(toArrayBuffer(bytes), { updateMetadata: false });
				} catch {
					// A book InklingExpanded cannot open for annotation either —
					// encrypted, most likely. Not this module's problem.
					continue;
				}

				// The property under test, and the only one asserted per file:
				// an answer, either way, with no exception escaping.
				const result = classifyIncrementalSave(bytes, doc);
				expect(typeof result.supported).toBe('boolean');

				if (result.supported) byStyle.set(result.style, (byStyle.get(result.style) ?? 0) + 1);
				else declined.push(`${path} — ${result.reason}`);

				// Cheap, and worth asserting per file rather than in aggregate:
				// a size mismatch here would mean the classifier read a file it
				// was not handed.
				expect(statSync(path).size).toBe(bytes.length);
			}

			// Printed rather than asserted on. The rate is information about
			// the library, not a property of the code.
			const supported = [...byStyle.values()].reduce((total, count) => total + count, 0);
			console.warn(
				`InklingExpanded: ${supported} of ${supported + declined.length} files take the fast path ` +
					`(${[...byStyle].map(([style, count]) => `${count} ${style}`).join(', ') || 'none'}).`,
			);
			for (const line of declined) console.warn(`  declined: ${line}`);
		},
		300_000,
	);

	it(
		'appends to every book it accepts and pdf.js still reads the result',
		async () => {
			// The check the generated fixtures cannot make, against the risk
			// that matters most: a cross-reference section we got wrong.
			//
			// pdf-lib is not a witness here. It resolves the last definition of
			// each object and never consults a cross-reference section at all,
			// so it reads a broken chain as happily as a sound one — that is
			// how the object-numbering fault in this branch survived three
			// green pdf-lib assertions. pdf.js follows the chain, so it is the
			// first reader that can actually disagree.
			//
			// Nothing is written to the vault. The append is built in memory
			// and concatenated in memory; the books are opened read-only.
			// One book at a time, in its own call frame. Holding several
			// books' pdf-lib models and pdf.js parses at once exhausted a 4 GB
			// heap on the first run of this — a property of checking twenty
			// books in a loop, not of the plugin, which ever has one open.
			// Returning between books is what lets each one go.
			const checkOne = async (path: string): Promise<'appended' | 'skipped' | 'too-big'> => {
				if (statSync(path).size > maxAppendBytes) return 'too-big';

				const bytes = new Uint8Array(readFileSync(path));
				let doc: PDFDocument;
				try {
					doc = await PDFDocument.load(toArrayBuffer(bytes), { updateMetadata: false });
				} catch {
					return 'skipped';
				}
				if (!classifyIncrementalSave(bytes, doc).supported) return 'skipped';

				// Taken from pdf-lib rather than from a second pdf.js parse of
				// the original: the page count is the same answer either way,
				// and parsing every book twice is most of what ran the heap
				// out.
				const pageCount = doc.getPageCount();

				const session = beginIncrementalSession(bytes, doc);
				const outcome = await saveIncrementally(doc, session, (touch) =>
					writeInklingAnnotations(doc, 0, [probeStroke], touch),
				);
				// A decline mid-save is a legitimate answer, not a failure; it
				// just means this book contributes nothing here.
				if (outcome.mode !== 'append') return 'skipped';

				const updated = new Uint8Array(bytes.length + outcome.appendix.length);
				updated.set(bytes, 0);
				updated.set(outcome.appendix, bytes.length);

				// The original is untouched, byte for byte.
				expect(updated.subarray(0, bytes.length)).toEqual(bytes);
				// And the appendix really is the size of the edit.
				expect(outcome.appendix.length).toBeLessThan(bytes.length);

				// Opening at all is already most of the signal: a cross-reference
				// section we got wrong makes pdf.js fail here with "Invalid Root
				// reference", which is exactly how the object-numbering fault in
				// this branch was caught.
				const after = await getDocument({ data: updated }).promise;
				try {
					expect(after.numPages).toBe(pageCount);
					const page = await after.getPage(1);
					// Resolving text exercises the chain for the page's own
					// objects. The *count* is deliberately not asserted to be
					// non-zero: several books here are scans, and an image-only
					// page legitimately has no text at all — an early version of
					// this check called that a failure.
					await page.getTextContent();
					expect((await page.getAnnotations()).some((a: { subtype?: string }) => a.subtype === 'Ink')).toBe(true);
				} finally {
					await after.destroy();
				}
				return 'appended';
			};

			const { getDocument } = await import('pdfjs-dist');
			const files = pdfsUnder(library ?? '');
			let appended = 0;
			let tooBig = 0;
			for (const path of files) {
				const result = await checkOne(path);
				if (result === 'appended') appended += 1;
				else if (result === 'too-big') tooBig += 1;
			}

			console.warn(
				`InklingExpanded: appended to ${appended} real books and pdf.js read every one back intact` +
					`${tooBig > 0 ? `; ${tooBig} skipped as larger than ${maxAppendBytes / 1024 / 1024} MB (raise INKLING_PDF_MAX_MB)` : ''}.`,
			);
			expect(appended).toBeGreaterThan(0);
		},
		600_000,
	);
});
