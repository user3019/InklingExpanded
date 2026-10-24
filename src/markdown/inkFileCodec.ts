import type { Annotation } from '../annotate/types';
import { readAnnotations, storedAnnotation } from './inkBlockFormat';

// What one block's `strokes` string holds, and the only code that looks
// inside it.
//
// The annotations are written exactly as an in-note block writes them —
// storedAnnotation, rounded and flattened — then deflated and base64-encoded.
// Everything above this module treats the result as an opaque string, and
// that is load-bearing: a block this build cannot decode is carried through a
// rewrite untouched, which is only possible if nothing else ever needs to
// understand it.

export type StrokeCodec = 'deflate' | 'none';

// Whether this platform can deflate. Asked at every use rather than once at
// load, so a test can take it away, and because the answer costs nothing.
//
// CompressionStream exists on desktop Electron and in the WebViews Obsidian
// mobile uses, but that is the one thing in this design that can only be
// confirmed on a device. Its absence must degrade to storing a block
// uncompressed, never to failing to save.
export function deflateAvailable(): boolean {
	return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

// String.fromCharCode takes its bytes as arguments, and an argument list has
// a length limit. A chunk this size is well inside it everywhere.
const BASE64_CHUNK = 0x8000;

export function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(start, start + BASE64_CHUNK));
	}
	return btoa(binary);
}

// Anchored, one character class, no alternation: linear in the input, so it
// is safe on a few hundred KB.
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
	// atob tolerates whitespace and missing padding. A payload this module
	// wrote has neither, so either one means the string is not what was
	// written.
	if (text.length % 4 !== 0 || !BASE64_TEXT.test(text)) return null;
	let binary: string;
	try {
		binary = atob(text);
	} catch {
		return null;
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

interface ByteTransform {
	readonly readable: ReadableStream<Uint8Array<ArrayBuffer>>;
	readonly writable: WritableStream<BufferSource>;
}

// Streams one buffer through a transform and collects what comes out.
//
// Written against the streams themselves rather than Blob and Response, which
// are the shorter route and are not all present in every environment this
// runs in. Both sides are awaited together, so an error on either — a corrupt
// block fails on the readable side — rejects rather than hanging.
async function transform(bytes: Uint8Array<ArrayBuffer>, stream: ByteTransform): Promise<Uint8Array<ArrayBuffer>> {
	const writer = stream.writable.getWriter();
	const reader = stream.readable.getReader();
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let total = 0;

	const writing = (async () => {
		await writer.write(bytes);
		await writer.close();
	})();
	const reading = (async () => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			chunks.push(value);
			total += value.length;
		}
	})();
	await Promise.all([writing, reading]);

	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

export async function encodeStrokes(annotations: readonly Annotation[]): Promise<{ strokes: string; codec: StrokeCodec }> {
	const json = new TextEncoder().encode(JSON.stringify(annotations.map(storedAnnotation)));
	if (deflateAvailable()) {
		try {
			// 'deflate', not 'deflate-raw': the zlib wrapper's Adler-32 trailer is
			// the whole of this format's integrity checking.
			return { strokes: toBase64(await transform(json, new CompressionStream('deflate'))), codec: 'deflate' };
		} catch (error) {
			console.error('InklingExpanded: compressing a block failed, so it is being stored uncompressed.', error);
		}
	}
	// Still base64. Everything that reads a file relies on `strokes` never
	// holding a brace or a quote, whatever produced it.
	return { strokes: toBase64(json), codec: 'none' };
}

export type DecodedStrokes =
	| { kind: 'decoded'; annotations: Annotation[] }
	// Something corrupted it.
	| { kind: 'undecodable' }
	// Nothing is wrong with it; this reader cannot open it.
	| { kind: 'unsupported'; codec: string };

const UNDECODABLE: DecodedStrokes = { kind: 'undecodable' };

export async function decodeStrokes(strokes: unknown, codec: unknown): Promise<DecodedStrokes> {
	// Absent means deflate, which is what every block written on a capable
	// device says by saying nothing.
	const name = codec === undefined ? 'deflate' : codec;
	if (typeof name !== 'string') return UNDECODABLE;
	if (name !== 'deflate' && name !== 'none') return { kind: 'unsupported', codec: name };
	if (name === 'deflate' && !deflateAvailable()) return { kind: 'unsupported', codec: name };

	if (typeof strokes !== 'string') return UNDECODABLE;
	const bytes = fromBase64(strokes);
	if (!bytes) return UNDECODABLE;

	let json = bytes;
	if (name === 'deflate') {
		try {
			json = await transform(bytes, new DecompressionStream('deflate'));
		} catch {
			return UNDECODABLE;
		}
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
	} catch {
		return UNDECODABLE;
	}
	if (!Array.isArray(parsed)) return UNDECODABLE;

	// All or nothing. A block that decodes only partly is carried through
	// untouched and shown read-only; keeping what survived would mean the next
	// save wrote the rest away.
	const { annotations, dropped } = readAnnotations(parsed);
	if (dropped > 0) return UNDECODABLE;
	return { kind: 'decoded', annotations };
}
