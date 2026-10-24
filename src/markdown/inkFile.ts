import type { Annotation } from '../annotate/types';
import { DEFAULT_BLOCK_HEIGHT, DEFAULT_BLOCK_WIDTH } from './inkBlockFormat';
import { decodeStrokes, encodeStrokes } from './inkFileCodec';

// A file of ink blocks, one per note by convention, holding what an in-note
// block used to hold in the note itself.
//
// The structure stays in text and only the coordinates are opaque. A damaged
// file can be inspected and partly rescued by hand, a caption can be fixed in
// a text editor, and a sync merge can operate a block at a time, while the
// coordinates, which are 99% of the bytes and none of the meaning, are
// deflated per block.
//
// Everything here is untrusted input, for the same reasons an in-note block
// is: files sync, get shared, and can be hand-edited.

// Governs the structure of the file and nothing else. Compression is per
// block, and so is the fallback when a device cannot compress, so it is
// described per block (see `codec`) rather than here.
export const INK_FILE_VERSION = 1;
export const INK_FILE_EXTENSION = 'ink';

export interface InkFileBlock {
	width: number;
	height: number;
	caption?: string;
	annotations: Annotation[];
}

export function emptyFileBlock(): InkFileBlock {
	return { width: DEFAULT_BLOCK_WIDTH, height: DEFAULT_BLOCK_HEIGHT, annotations: [] };
}

// A file as read, before any block is decoded. Blocks stay exactly as the
// JSON held them, whatever that was, so a block this build cannot read can
// still be written back.
export interface InkFileContents {
	// Top-level keys other than `version` and `blocks`, in the order read.
	extra: Array<[string, unknown]>;
	blocks: Map<string, unknown>;
}

export type InkFileRead =
	| { kind: 'readable'; contents: InkFileContents }
	// Valid, and written by a newer InklingExpanded. Never written over, never repaired.
	| { kind: 'from-future'; version: number }
	// Not JSON, or JSON that is not a block map.
	| { kind: 'damaged' };

const DAMAGED: InkFileRead = { kind: 'damaged' };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function parseInkFile(text: string): InkFileRead {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return DAMAGED;
	}
	if (!isRecord(parsed)) return DAMAGED;

	const version = parsed.version === undefined ? INK_FILE_VERSION : parsed.version;
	if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return DAMAGED;
	// Before looking at the blocks: a newer version may have changed what a
	// block map looks like, and that is not damage.
	if (version > INK_FILE_VERSION) return { kind: 'from-future', version };
	if (!isRecord(parsed.blocks)) return DAMAGED;

	const extra = Object.entries(parsed).filter(([key]) => key !== 'version' && key !== 'blocks');
	return { kind: 'readable', contents: { extra, blocks: new Map(Object.entries(parsed.blocks)) } };
}

export type BlockRead =
	| { kind: 'decoded'; block: InkFileBlock }
	| { kind: 'undecodable' }
	| { kind: 'unsupported'; codec: string };

export async function readInkFileBlock(raw: unknown): Promise<BlockRead> {
	if (!isRecord(raw)) return { kind: 'undecodable' };
	const strokes = await decodeStrokes(raw.strokes, raw.codec);
	if (strokes.kind !== 'decoded') return strokes;

	const caption = typeof raw.caption === 'string' ? raw.caption.trim() : '';
	return {
		kind: 'decoded',
		block: {
			width: positive(raw.width) ?? DEFAULT_BLOCK_WIDTH,
			height: positive(raw.height) ?? DEFAULT_BLOCK_HEIGHT,
			...(caption ? { caption } : {}),
			annotations: strokes.annotations,
		},
	};
}

const KNOWN_BLOCK_KEYS = new Set(['width', 'height', 'caption', 'strokes', 'codec']);

// A block ready to be serialized, keeping every key of `previous` this build
// does not own, so a future version's additions survive this version's saves.
//
// Built on a null prototype: a hand-edited or hostile file can hold a key
// called "__proto__", and assigning that on an ordinary object would set the
// prototype instead of carrying the key.
export async function writeInkFileBlock(previous: unknown, block: InkFileBlock): Promise<Record<string, unknown>> {
	const { strokes, codec } = await encodeStrokes(block.annotations);
	const next = Object.create(null) as Record<string, unknown>;
	next.width = block.width;
	next.height = block.height;
	const caption = block.caption?.trim();
	if (caption) next.caption = caption;
	if (isRecord(previous)) {
		for (const [key, value] of Object.entries(previous)) {
			if (!KNOWN_BLOCK_KEYS.has(key)) next[key] = value;
		}
	}
	// Absent means deflate, so a capable device writes nothing extra.
	if (codec !== 'deflate') next.codec = codec;
	// Last, so the readable part of a block comes first on its line.
	next.strokes = strokes;
	return next;
}

// One block per line. Obsidian never opens this file in an editor, so a long
// line costs nothing, and one block per line is what lets a line-based sync
// merge treat two blocks edited on two devices as two unrelated changes.
export function serializeInkFile(contents: InkFileContents): string {
	const lines = ['{', `  "version": ${INK_FILE_VERSION},`];
	for (const [key, value] of contents.extra) {
		lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
	}

	const entries = [...contents.blocks];
	if (entries.length === 0) {
		lines.push('  "blocks": {}');
	} else {
		lines.push('  "blocks": {');
		entries.forEach(([id, raw], index) => {
			const comma = index < entries.length - 1 ? ',' : '';
			lines.push(`    ${JSON.stringify(id)}: ${JSON.stringify(raw)}${comma}`);
		});
		lines.push('  }');
	}
	lines.push('}');
	return `${lines.join('\n')}\n`;
}

// What a file of this text occupies on disk. Everything written is ASCII
// except a caption, which holds whatever the user typed, so string length
// disagrees with the file the moment a caption holds an accent — and a
// size check that cried "truncated" on every such save would be worse than
// none.
export function byteLength(text: string): number {
	return new TextEncoder().encode(text).length;
}
