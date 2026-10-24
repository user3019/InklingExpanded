import type { DataAdapter } from 'obsidian';

// The single chokepoint every binary write to the vault goes through.
//
// Two guards, either of which leaves the file on disk exactly as it was:
//
// 1. **Before.** A buffer that isn't a PDF, or is implausibly short, never
//    reaches the file. writeDocument already verifies structure for the
//    annotation path (see pdf/annotationWriterCore.ts), but "Add page" does
//    its own read-modify-write and had nothing under it at all.
// 2. **After.** The file's size on disk is compared against what was
//    written. A write cut short — the app killed mid-save, which mobile
//    OSes do to backgrounded apps aggressively — leaves a shorter file, and
//    this is what notices. The caller keeps its pages dirty and retries.
//
// **What this is not, yet.** The design called for an atomic replace: write
// to a scratch path outside the sync tree, then rename over the target, so
// an interrupted write cannot damage the original at all. That needs a
// real-device spike first — three things have to hold, and none can be
// checked from here:
//
//   - that `adapter.writeBinary`/`rename` work inside a dot-folder on
//     Android as well as desktop;
//   - that a rename into the vault tree updates Obsidian's own file record
//     and fires its file events, since a write that bypasses those may
//     never reach a sync plugin at all — a silently unsynced edit would be
//     a worse failure than the one being fixed;
//   - that Self-hosted LiveSync ignores the scratch folder by default.
//
// Until those are confirmed, this is the fallback the design named: keep
// the verification, write through the Vault API so events fire normally,
// and give up only the interrupted-write protection specifically. The
// after-write size check recovers most of what that would have bought,
// because the damage becomes loud instead of silent.

// Every PDF starts with this, per the spec's own header requirement. Cheap
// to check and catches the failure that matters: handing modifyBinary a
// detached, empty, or wrong buffer, which would replace a textbook with
// nothing.
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

// A PDF with a header, a trailer and one empty page is a few hundred bytes.
// Anything under this is not a document that lost some content; it is a
// buffer that went wrong.
const MIN_PLAUSIBLE_PDF_BYTES = 200;

export function looksLikePdf(bytes: ArrayBuffer): boolean {
	if (bytes.byteLength < MIN_PLAUSIBLE_PDF_BYTES) return false;
	const head = new Uint8Array(bytes, 0, PDF_MAGIC.length);
	return PDF_MAGIC.every((byte, index) => head[index] === byte);
}

// The slice of Obsidian's API this needs, rather than the whole Vault, so
// the tests can supply a fake without standing up an app. Generic in the
// file type for the same reason: all this needs from a file is its path, and a
// real Vault satisfies this structurally with TFile.
export interface BinaryWriteTarget<F> {
	modifyBinary(file: F, data: ArrayBuffer): Promise<void>;
	adapter: Pick<DataAdapter, 'stat'>;
}

export async function writeBinarySafely<F extends { path: string }>(
	vault: BinaryWriteTarget<F>,
	file: F,
	bytes: ArrayBuffer,
): Promise<void> {
	if (!looksLikePdf(bytes)) {
		throw new Error(`InklingExpanded: refusing to write ${bytes.byteLength} bytes to ${file.path} — that is not a PDF.`);
	}

	const expected = bytes.byteLength;
	await vault.modifyBinary(file, bytes);

	// stat, not a re-read: comparing sizes costs nothing, where reading a
	// 40 MB book back after every autosave would be most of the cost of the
	// save itself. A truncated write is a short file, which this catches; a
	// write that landed the wrong *bytes* at the right length is what the
	// structural verification before it is for.
	const stat = await vault.adapter.stat(file.path);
	if (stat && stat.size !== expected) {
		throw new Error(
			`InklingExpanded: ${file.path} is ${stat.size} bytes after writing ${expected} — the write did not complete.`,
		);
	}
}

// ---- Appending ----

// The append path's own version of the two guards above, because neither
// survives unchanged.
//
// `looksLikePdf` cannot apply to an appendix: an update section does not start
// with `%PDF-`. What replaces it is the other end — an appendix that does not
// finish at `%%EOF` is not an update section, whatever else it is.
//
// And the after-write size check has to be told the base length, because for
// an append the expected size is *original + appended* rather than the number
// of bytes handed over.
//
// The check with no counterpart in the replacement path is the one *before*
// the write. **An append onto a file that changed since we read it produces a
// corrupt PDF**, where a full rewrite would merely lose the other change.
// That is the single place incremental save is more dangerous than what it
// replaces, and it is a live risk in a Self-hosted LiveSync vault. On a
// mismatch the correct action is not to retry — it is to fall back to a full
// rewrite from a fresh read, which is what the caller does.
const EOF_MARKER = [0x25, 0x25, 0x45, 0x4f, 0x46]; // "%%EOF"

// How much may follow `%%EOF` in an appendix. A line terminator, or a couple,
// and nothing more — enough slack for a trailing newline without admitting a
// buffer that merely contains the marker somewhere in the middle.
const EOF_TRAILING_SLACK = 4;

export interface BinaryAppendTarget<F> {
	appendBinary?(file: F, data: ArrayBuffer): Promise<void>;
	adapter: Pick<DataAdapter, 'stat'>;
}

// Vault.appendBinary is `@since 1.12.3` and manifest.json's minAppVersion is
// 1.4.4, so its absence is a case that has to be handled rather than assumed
// away. Not having it is not a failure: it means this vault takes the
// full-rewrite path, exactly as it does today.
export function canAppendBinary(vault: unknown): boolean {
	return typeof (vault as { appendBinary?: unknown } | null)?.appendBinary === 'function';
}

export function looksLikeUpdateSection(bytes: ArrayBuffer): boolean {
	if (bytes.byteLength < EOF_MARKER.length) return false;
	const from = Math.max(0, bytes.byteLength - EOF_MARKER.length - EOF_TRAILING_SLACK);
	const tail = new Uint8Array(bytes, from);
	for (let start = tail.length - EOF_MARKER.length; start >= 0; start--) {
		if (EOF_MARKER.every((byte, index) => tail[start + index] === byte)) return true;
	}
	return false;
}

export async function appendBinarySafely<F extends { path: string }>(
	vault: BinaryAppendTarget<F>,
	file: F,
	appendix: ArrayBuffer,
	baseLength: number,
): Promise<void> {
	if (!canAppendBinary(vault)) {
		throw new Error(`InklingExpanded: this version of Obsidian has no Vault.appendBinary, so ${file.path} cannot be updated in place.`);
	}
	if (!looksLikeUpdateSection(appendix)) {
		throw new Error(`InklingExpanded: refusing to append ${appendix.byteLength} bytes to ${file.path} — that does not end at %%EOF.`);
	}

	// Before, and this is the load-bearing one. stat rather than a re-read: a
	// length that still matches is what says the update we built is still an
	// update to *this* file.
	const before = await vault.adapter.stat(file.path);
	if (before && before.size !== baseLength) {
		throw new Error(
			`InklingExpanded: ${file.path} is ${before.size} bytes where the update was built against ${baseLength} — it changed underneath us.`,
		);
	}

	await vault.appendBinary?.(file, appendix);

	const expected = baseLength + appendix.byteLength;
	const after = await vault.adapter.stat(file.path);
	if (after && after.size !== expected) {
		throw new Error(`InklingExpanded: ${file.path} is ${after.size} bytes after appending to ${expected} — the write did not complete.`);
	}
}
