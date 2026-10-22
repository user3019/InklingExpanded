import type { Annotation, DrawToolType, Point, ShapeToolType } from '../annotate';
import { isPenBrush } from '../annotate/types';

// The fenced-block language that marks an ink block in a note. Short and
// readable on purpose: it's what shows up in the raw Markdown, and someone
// reading the note outside Obsidian should be able to tell what it is.
export const INK_BLOCK_LANGUAGE = 'inkling';

// Bumped only for a change the current parser couldn't otherwise read.
// Present from the first release so a later format change has something to
// migrate *from* — the alternative (adding versioning once it's needed)
// means the oldest, least-recoverable blocks are the ones without it.
//
// 2 stores stroke coordinates as one flat array of numbers rather than a
// list of {x, y, p} objects, with pressure in a parallel array beside it.
// Reading accepts 1 and 2; writing always produces 2, so a block is
// upgraded in place the first time it is saved. A block declaring a version
// above this one is treated as malformed and never written over — which is
// what stops an older build destroying a newer block.
export const INK_BLOCK_VERSION = 2;

// The drawing surface's own coordinate space, which is what stroke
// coordinates below are in. Stored per block rather than assumed, so a
// block keeps its proportions if these defaults ever change, and so the
// rendered canvas can be scaled to whatever width the note is displayed at
// without touching the data (see inkBlock.ts).
export const DEFAULT_BLOCK_WIDTH = 800;
export const DEFAULT_BLOCK_HEIGHT = 450;

export interface InkBlockData {
	version: number;
	// A stable identity for this block, so a save can tell "this is an ink
	// block" apart from "this is *my* ink block".
	//
	// Every ink block in a note is an `inkling` fence, and Obsidian's
	// getSectionInfo can hand a block the line range of a *different* one
	// when several sit in the same note — which meant one block's drawing
	// could be written over another's, and appeared as the drawing from the
	// block above turning up duplicated in the block below.
	//
	// Optional because blocks written before this existed have none. Those
	// fall back to comparing the fence's whole body, and pick up an id the
	// first time they save.
	id?: string;
	width: number;
	height: number;
	// One line saying what the drawing is.
	//
	// A block is invisible to a reader: a page of handwritten physics is, to
	// anyone not looking at it, a JSON blob. The fence body is already
	// indexed by Obsidian's search, so this does not make a block findable
	// that was not — what it does is make the hit legible, give a screen
	// reader something to read, and give the eye something to catch when
	// scrolling past.
	//
	// Absent rather than empty when there is none, and never written in that
	// case: this landed without a format version bump, so an older build
	// reading the block simply ignores it, and writing an empty string into
	// every block in a vault to say "no caption" would be a no-op edit
	// re-uploaded through a replicating vault for nothing.
	caption?: string;
	annotations: Annotation[];
}

const DRAW_TOOLS: readonly string[] = ['pen', 'highlighter'];
const SHAPE_TOOLS: readonly string[] = ['line', 'rectangle', 'oval', 'arrow'];

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function readPoint(value: unknown): Point | null {
	if (typeof value !== 'object' || value === null) return null;
	const { x, y, p } = value as { x?: unknown; y?: unknown; p?: unknown };
	if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;

	const point: Point = { x, y };
	// Pressure was written but never read back, so a block saved a
	// tapered stroke and then redrew it flat about a second later, when
	// its own save re-rendered it. Out of range is dropped rather than
	// clamped: a value outside 0-1 did not come from a stylus, and
	// inventing a pressure is worse than having none.
	if (isFiniteNumber(p) && p >= 0 && p <= 1) point.p = p;
	return point;
}

// A single point in either format: `[x, y]` since 2, `{x, y}` before it.
//
// Which one is decided by looking at the value rather than at the block's
// declared `version`, because the version is a claim the file makes about
// itself and everything here treats the file as untrusted. A block that
// says 1 and holds flat arrays is still readable, and one that lies the
// other way does not confuse the reader into misreading coordinates.
function readFlexiblePoint(value: unknown): Point | null {
	if (!Array.isArray(value)) return readPoint(value);

	const [x, y, p] = value as unknown[];
	if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;

	const point: Point = { x, y };
	if (isFiniteNumber(p) && p >= 0 && p <= 1) point.p = p;
	return point;
}

// A stroke's points, from the flat coordinate array and the optional
// parallel pressure array beside it.
//
// Both arrays are checked against each other before anything is built: a
// coordinate array of odd length, or a pressure array that does not have
// exactly one entry per point, means the two have stopped agreeing about
// how many samples there are. There is no safe way to guess which of them
// is right, and a stroke rebuilt from the wrong pairing is not the stroke
// anyone drew — so the whole annotation is dropped, the same call the
// object form already makes for a single bad point.
function readFlatStroke(coordinates: readonly unknown[], pressure: unknown): Point[] | null {
	if (coordinates.length === 0 || coordinates.length % 2 !== 0) return null;

	const count = coordinates.length / 2;
	let pressures: readonly unknown[] | null = null;
	if (pressure !== undefined) {
		if (!Array.isArray(pressure) || pressure.length !== count) return null;
		pressures = pressure;
	}

	const points: Point[] = [];
	for (let index = 0; index < count; index++) {
		const x = coordinates[index * 2];
		const y = coordinates[index * 2 + 1];
		if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;

		const point: Point = { x, y };
		if (pressures) {
			const p = pressures[index];
			// null is a sample that genuinely had no pressure, which is
			// different from one whose pressure is zero. Anything else in the
			// array is a disagreement between it and the coordinates, not a
			// gap to paper over, and takes the stroke with it.
			if (p !== null) {
				if (!isFiniteNumber(p) || p < 0 || p > 1) return null;
				point.p = p;
			}
		}
		points.push(point);
	}
	return points;
}

// Everything below treats block content as untrusted input, because it is:
// notes sync between devices, get shared, and can be hand-edited, so a
// block can hold anything at all by the time it reaches here. A bad value
// yields null and the annotation is dropped, rather than throwing (which
// would take the whole note's render down with it) or being trusted into
// the renderer. Note this is a *shape* check — nothing here is ever
// interpreted as code or markup, and the renderer only ever draws to a
// canvas, so a hostile block's worst case is ink that looks wrong.
function readAnnotation(value: unknown): Annotation | null {
	if (typeof value !== 'object' || value === null) return null;
	const raw = value as Record<string, unknown>;

	const { id, color, width, kind, tool } = raw;
	if (typeof id !== 'string' || !id) return null;
	if (typeof color !== 'string' || !color) return null;
	if (!isFiniteNumber(width) || width <= 0) return null;
	if (typeof tool !== 'string') return null;

	if (kind === 'stroke') {
		if (!DRAW_TOOLS.includes(tool)) return null;
		if (!Array.isArray(raw.points)) return null;

		// Format 2 holds a flat run of numbers; format 1 holds objects. The
		// first entry says which, so a stroke is read by its own shape rather
		// than by what the block claims its version is.
		let points: Point[] | null;
		if (typeof raw.points[0] === 'number') {
			points = readFlatStroke(raw.points, raw.pressure);
		} else {
			points = [];
			for (const entry of raw.points) {
				const point = readPoint(entry);
				// One bad point invalidates the stroke rather than silently
				// bending it somewhere else on the page.
				if (!point) return null;
				points.push(point);
			}
		}
		if (!points || points.length === 0) return null;
		// A nib this build does not know — written by a newer one — draws as
		// the plain pen rather than costing the stroke.
		const brush = tool === 'pen' && isPenBrush(raw.brush) && raw.brush !== 'pen' ? raw.brush : undefined;
		return { id, color, width, kind: 'stroke', tool: tool as DrawToolType, points, ...(brush ? { brush } : {}) };
	}

	if (kind === 'shape') {
		if (!SHAPE_TOOLS.includes(tool)) return null;
		const start = readFlexiblePoint(raw.start);
		const end = readFlexiblePoint(raw.end);
		if (!start || !end) return null;
		return { id, color, width, kind: 'shape', tool: tool as ShapeToolType, start, end };
	}

	return null;
}

// A list of stored annotations, read one at a time, with a count of those
// that could not be. Shared by the in-note block and the ink file, so the two
// formats cannot come to disagree about what a readable annotation is.
export function readAnnotations(value: unknown): { annotations: Annotation[]; dropped: number } {
	const annotations: Annotation[] = [];
	let dropped = 0;
	if (Array.isArray(value)) {
		for (const entry of value) {
			const annotation = readAnnotation(entry);
			if (annotation) annotations.push(annotation);
			else dropped += 1;
		}
	} else if (value !== undefined) {
		// Annotations that are not a list at all. Counted as one loss rather
		// than none: something was there, and it is not here.
		dropped += 1;
	}
	return { annotations, dropped };
}

export function emptyInkBlock(): InkBlockData {
	return { version: INK_BLOCK_VERSION, width: DEFAULT_BLOCK_WIDTH, height: DEFAULT_BLOCK_HEIGHT, annotations: [] };
}

// Which of the three ways a block can be damaged this one is.
//
// One boolean used to cover all of them, which was enough to refuse the save
// and not enough to offer a way out: what the user can safely be offered
// differs completely between a block that yielded nothing, a block that
// yielded most of itself, and a block a newer build wrote.
export type InkBlockDamage =
	// Read completely. Nothing to say.
	| { kind: 'none' }
	// Not JSON, or JSON that is not a block. Nothing survived the parse, so
	// there is nothing to offer keeping — only the text in the note, which is
	// left exactly as it is.
	| { kind: 'unreadable' }
	// Some annotations read and some did not. This is the one case where a
	// recovery is meaningful: what survived is real, and the user can be told
	// how much of it there is and decide to keep it.
	| { kind: 'partial'; kept: number; dropped: number }
	// Written by a newer version of the plugin. Whatever this build could not
	// read is most likely the very thing that version added, so keeping "what
	// survived" would be offering to downgrade the file. Never offered.
	| { kind: 'from-future'; version: number };

export interface ParseResult {
	data: InkBlockData;
	// True when the source held something this couldn't make sense of.
	// Callers surface it rather than quietly presenting a blank block —
	// silently discarding someone's handwriting (and then overwriting it on
	// the next edit) is the one failure here that isn't recoverable.
	//
	// Kept alongside `damage` because most callers only need the question it
	// answers: may this block be written over? `damage.kind === 'none'` says
	// the same thing, and this says it in the words the save path thinks in.
	malformed: boolean;
	damage: InkBlockDamage;
}

const UNDAMAGED: InkBlockDamage = { kind: 'none' };

export function parseInkBlock(source: string): ParseResult {
	const trimmed = source.trim();
	if (!trimmed) return { data: emptyInkBlock(), malformed: false, damage: UNDAMAGED };

	let parsed: unknown;
	try {
		// Plain JSON.parse, never eval or Function — see the note above on
		// treating this as untrusted.
		parsed = JSON.parse(trimmed);
	} catch {
		return { data: emptyInkBlock(), malformed: true, damage: { kind: 'unreadable' } };
	}

	// Arrays are excluded explicitly, not incidentally: `typeof [] === 'object'`
	// and it isn't null, so a bare array otherwise fell through this check and
	// came back as a *valid* empty block — at which point the next edit
	// overwrote whatever the block really held. Silently discarding someone's
	// handwriting is the one failure here that isn't recoverable.
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return { data: emptyInkBlock(), malformed: true, damage: { kind: 'unreadable' } };
	}
	const raw = parsed as Record<string, unknown>;

	const width = isFiniteNumber(raw.width) && raw.width > 0 ? raw.width : DEFAULT_BLOCK_WIDTH;
	const height = isFiniteNumber(raw.height) && raw.height > 0 ? raw.height : DEFAULT_BLOCK_HEIGHT;
	const version = isFiniteNumber(raw.version) ? raw.version : INK_BLOCK_VERSION;
	// Not a reason to refuse the block. A caption is a convenience rather
	// than something the drawing is made of, so one that arrives as a number
	// is dropped where a stroke that arrived as a number would not be.
	const rawCaption = typeof raw.caption === 'string' ? raw.caption.trim() : '';
	const caption = rawCaption ? rawCaption : undefined;

	const { annotations, dropped } = readAnnotations(raw.annotations);

	// A block written by a *newer* version of the plugin may legitimately
	// hold things this build can't represent, so flag it rather than
	// pretending the result is complete — the caller refuses to overwrite
	// on that basis.
	const fromFuture = version > INK_BLOCK_VERSION;

	// From the future first, and the order is the decision: a newer block that
	// also dropped entries is not a block to offer recovering, because the
	// entries it dropped are most likely what the newer version added.
	const damage: InkBlockDamage = fromFuture
		? { kind: 'from-future', version }
		: dropped > 0
			? { kind: 'partial', kept: annotations.length, dropped }
			: UNDAMAGED;

	// Read through readInkBlockId rather than off the parsed object, so that
	// the id a block reports is by construction the id a save will search for.
	//
	// The two are the same for every block this module has ever written. They
	// can differ for a hand-edited one carrying two top-level ids, where JSON
	// says the last wins and the front-reading shortcut finds the first — and
	// a block whose two answers disagree cannot be located at all, so it
	// cannot be saved. Taking both from one function is what stops an
	// optimisation to that shortcut costing a block the ability to be found.
	const id = readInkBlockId(trimmed) ?? undefined;

	return {
		data: { version, id, width, height, ...(caption ? { caption } : {}), annotations },
		malformed: damage.kind !== 'none',
		damage,
	};
}

// The exact opening this module writes: a version, then an id holding
// nothing that needs an escape, then the width. Matching all three is what
// makes the shortcut below safe — it identifies a block written by
// serializeInkBlock rather than one that merely happens to start with an id.
//
// Whitespace is tolerated throughout because the stored JSON is wrapped and
// a wrap point can fall between any two of these tokens.
const WRITTEN_BLOCK_ID = /^\s*\{\s*"version"\s*:\s*-?\d+(?:\.\d+)?\s*,\s*"id"\s*:\s*"([^"\\]+)"\s*,\s*"width"\s*:/;

// The block's identity, read without parsing the rest of it — used when a
// save has to confirm the fence it is about to overwrite is its own and not
// a neighbour's. Returns null for anything unreadable, which the caller
// treats as "can't confirm", never as "matches".
//
// "Without parsing the rest of it" was the intent from the start and not what
// this did: it ran a full JSON.parse to read one short string sitting at the
// front of the body. A save calls this once per block in the note, so on the
// largest note in the vault it cost 4.92 ms per save to look at a megabyte of
// stroke data none of it needed.
//
// The front is now read directly for a block shaped the way this module
// writes them; anything else falls back to the parse. The fallback is what
// keeps this correct rather than merely fast — the pattern is an optimisation
// for a known shape, never an assumption that a block has it.
//
// One case is deliberately out of contract: a hand-edited block carrying a
// second top-level "id" later in the body. JSON says the last one wins and
// the pattern reads the first. Detecting that would mean scanning the whole
// body, which is the cost being removed. It is safe because of how the
// answer is used — a save looks for a fence whose id equals its own, this
// block's own id came from a full parse, so a disagreement makes the save
// find nothing and refuse, which keeps the ink. It cannot make a save
// overwrite the wrong fence.
function writtenBlockId(source: string): string | null {
	const written = WRITTEN_BLOCK_ID.exec(source);
	return written ? written[1] ?? null : null;
}

// How many of a block's lines have to be in hand before its id can be read.
//
// The id sits in the first fifty characters of the body and lines wrap at
// 120, so one is almost always enough; a few more cost nothing and cover a
// wrap falling somewhere awkward. This is what lets findInkBlockById skip
// building the rest of the body at all.
const ID_HEAD_LINES = 4;

export function readInkBlockId(source: string): string | null {
	const written = writtenBlockId(source);
	if (written !== null) return written;

	try {
		const parsed: unknown = JSON.parse(source.trim());
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
		const id = (parsed as { id?: unknown }).id;
		return typeof id === 'string' && id ? id : null;
	} catch {
		return null;
	}
}

// How precisely stroke coordinates are written into the note.
//
// A tenth of a unit is far finer than a pen tip: a block is stored 800
// units wide and shown around 700 CSS pixels, so 0.1 units is under a
// tenth of a pixel. JSON.stringify writes full float precision by
// default — "123.45678901234567" for a coordinate whose last twelve
// digits nobody can see — and with every stylus sample now captured
// (see annotate/pointer.ts) that is the bulk of the note.
//
// Measured on a five-second handwriting stroke at 120Hz: 42,302 bytes
// as written before, 18,082 after. That is parsing cost on every
// render, sync traffic on every save, and a wall of digits in the
// middle of the file.
const COORDINATE_DECIMALS = 1;
const PRESSURE_DECIMALS = 2;

function round(value: number, decimals: number): number {
	// Most of what this is asked to round is already rounded: a save
	// re-serializes the whole block, and everything in it that came from the
	// file was written at this precision in the first place. Multiplying out
	// and back is exact for those and skips the string formatting, which was
	// 40% of the time spent serializing the largest block in the vault.
	//
	// Only a value that is *not* already at this precision goes the slow way,
	// and it must, because the two disagree on halfway cases — 0.15 rounds to
	// 0.1 through toFixed and 0.2 through multiplication, and 10 coordinates
	// in the vault land on such a case. This keeps toFixed's answer
	// everywhere and merely stops asking for it when the answer cannot differ.
	const factor = decimals === 1 ? 10 : 100;
	const scaled = Math.round(value * factor) / factor;
	if (scaled === value) return value;

	// The unary + drops a trailing ".0", which toFixed would otherwise
	// keep and JSON.stringify would faithfully write out.
	return +value.toFixed(decimals);
}

// A lone point — a shape's start or end — as `[x, y]`, or `[x, y, p]` when
// it carries pressure.
//
// Pressure on a shape endpoint means nothing to the renderer, which draws
// shapes as geometry and never tapers them. It is kept anyway because it is
// there: the pointer samples that placed the corners recorded it, real
// notes hold it, and dropping a value on the grounds that today's renderer
// ignores it is how a format loses information it will not get back.
function flatPoint(point: Point): number[] {
	const flat = [round(point.x, COORDINATE_DECIMALS), round(point.y, COORDINATE_DECIMALS)];
	if (point.p !== undefined) flat.push(round(point.p, PRESSURE_DECIMALS));
	return flat;
}

// A stroke's points as format 2 stores them: coordinates in one flat array,
// and pressure in a parallel array beside it — the same shape the PDF side
// already uses, where /InkList holds flat coordinates and the private
// /Inkling /P a parallel byte array.
//
// A point with no pressure writes `null` rather than being left out, so the
// two arrays always agree on how many samples there are and a gap stays a
// gap. This started as all-or-nothing — a stroke missing pressure anywhere
// stored none at all — on the assumption that mixed strokes were a
// theoretical case. They are not: real notes in daily use hold six-point
// pen strokes with pressure on some samples and not others, and that rule
// quietly flattened them. Four bytes for an absent sample is a much better
// trade than losing the taper on strokes somebody already drew.
//
// The array is omitted altogether only when no point has pressure at all,
// which is the common case for anything drawn with a mouse.
function flatStroke(points: readonly Point[]): { points: number[]; pressure?: (number | null)[] } {
	const coordinates: number[] = [];
	let anyPointHasPressure = false;

	for (const point of points) {
		coordinates.push(round(point.x, COORDINATE_DECIMALS), round(point.y, COORDINATE_DECIMALS));
		if (point.p !== undefined) anyPointHasPressure = true;
	}
	if (!anyPointHasPressure) return { points: coordinates };

	const pressure: (number | null)[] = points.map((point) =>
		point.p === undefined ? null : round(point.p, PRESSURE_DECIMALS),
	);
	return { points: coordinates, pressure };
}

// Rounds coordinates and flattens them for storage, without touching the
// annotations the surface is still drawing from — rounding those in place
// would move live ink under the pen, by a fraction of a pixel, on every
// save.
//
// Every other field is carried through untouched, so a quote or a note
// captured with the annotation survives a format it says nothing about.
// Exported so a merge can ask whether two annotations would be *written*
// the same way, which is the only notion of equality that matters once
// coordinates are rounded on the way out. See markdown/mergeInkBlocks.
export function storedAnnotation(annotation: Annotation): Record<string, unknown> {
	if (annotation.kind === 'stroke') {
		const { points, ...rest } = annotation;
		return { ...rest, ...flatStroke(points) };
	}
	if (annotation.kind === 'shape') {
		return { ...annotation, start: flatPoint(annotation.start), end: flatPoint(annotation.end) };
	}
	return { ...annotation };
}

// How long a line of stored JSON is allowed to get.
//
// A block used to be written as a single line, on the reasoning that a few
// hundred lines of formatted JSON per drawing would swamp the writing around
// it. The cost of that was not measured until it turned up in use: a page of
// handwriting is a line of 164,799 characters, and Obsidian's Live Preview
// cannot edit a document shaped like that. Typing anywhere in the note
// lagged, including nowhere near a block.
//
// Established by experiment rather than reasoned about. A copy of the note
// with the fence language changed — so this plugin never ran at all — lagged
// exactly the same, which ruled out anything Inkling executes. The same copy
// with the JSON wrapped was smooth. Source mode was smooth throughout, which
// is what pointed at the rendering pass rather than at CodeMirror's handling
// of long lines.
//
// This is still one JSON document: whitespace between tokens means nothing
// to a parser, every path that reads a block already joins the fence's lines
// before parsing, and no version bump is needed. Blocks rewrap as they save.
export const MAX_STORED_LINE_LENGTH = 120;

// Splits compact JSON into lines no longer than MAX_STORED_LINE_LENGTH,
// breaking only after a comma that is not inside a string.
//
// Inside a string is the case that matters: a newline in a JSON string is a
// parse error, so wrapping on any comma would corrupt every block holding
// text with a comma in it. A single value longer than the limit — a very long
// note, say — has no break point and stays on its own line, which is correct
// and is why the limit is a target rather than a guarantee.
function wrapStoredJson(json: string): string {
	const segments: string[] = [];
	let start = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString && char === '\\') {
			escaped = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			continue;
		}
		if (!inString && char === ',') {
			segments.push(json.slice(start, index + 1));
			start = index + 1;
		}
	}
	segments.push(json.slice(start));

	const lines: string[] = [];
	let current = '';
	for (const segment of segments) {
		if (current && current.length + segment.length > MAX_STORED_LINE_LENGTH) {
			lines.push(current);
			current = segment;
		} else {
			current += segment;
		}
	}
	if (current) lines.push(current);

	return lines.join('\n');
}

export function serializeInkBlock(data: InkBlockData): string {
	// Compact rather than pretty-printed — this sits inside the user's own
	// note — but wrapped, for the reason recorded above
	// MAX_STORED_LINE_LENGTH.
	return wrapStoredJson(JSON.stringify({
		version: INK_BLOCK_VERSION,
		// First, so a block's identity is readable without parsing past the
		// stroke data — which for a densely drawn block is most of the line.
		...(data.id ? { id: data.id } : {}),
		width: data.width,
		height: data.height,
		// After the width, which is where the id shortcut stops looking, and
		// before the annotations, which are most of the bytes — so a caption
		// stays readable at a glance in the note's own source.
		...(data.caption?.trim() ? { caption: data.caption.trim() } : {}),
		annotations: data.annotations.map(storedAnnotation),
	}));
}

export function inkBlockMarkdown(data: InkBlockData = emptyInkBlock()): string {
	return `\`\`\`${INK_BLOCK_LANGUAGE}\n${serializeInkBlock(data)}\n\`\`\``;
}

export interface InkBlockRange {
	// The fence lines themselves: the opening ```inkling and the closing ```.
	lineStart: number;
	lineEnd: number;
}

function isOpeningFence(line: string | undefined): boolean {
	const trimmed = line?.trimStart() ?? '';
	return trimmed.startsWith('```') && trimmed.includes(INK_BLOCK_LANGUAGE);
}

function isClosingFence(line: string | undefined): boolean {
	return (line?.trimStart() ?? '').startsWith('```');
}

// Finds a specific ink block in a note, by its own id.
//
// This exists because Obsidian's `getSectionInfo` cannot be trusted to say
// where a block is when a note holds several of them — it hands one block
// the line range of another, which is how a drawing ended up duplicated
// into its neighbour, and how refusing that write then lost the drawing
// instead. Searching the note for the block that actually carries our id
// answers the question directly rather than trusting a report of it.
//
// Returns null when there is no such block: it may not have been written
// yet, or the note may have been edited out from under us. The caller must
// treat that as "do not write anywhere", never as "write wherever you were
// told".
export function findInkBlockById(lines: readonly string[], blockId: string): InkBlockRange | null {
	if (!blockId) return null;

	for (let index = 0; index < lines.length; index++) {
		if (!isOpeningFence(lines[index])) continue;

		let close = index + 1;
		while (close < lines.length && !isClosingFence(lines[close])) close++;
		if (close >= lines.length) return null;

		// The id is read off the first few lines rather than by assembling the
		// whole block. Joining every body in the note to look at the front of
		// each was most of what this cost: on the largest note in the vault
		// that built the better part of a megabyte of strings per save, all
		// of it discarded immediately.
		//
		// A block this module did not write falls back to the full body, and
		// so keeps its previous behaviour exactly.
		const head = lines.slice(index + 1, Math.min(close, index + 1 + ID_HEAD_LINES)).join('\n');
		const fromHead = writtenBlockId(head);
		const id = fromHead ?? readInkBlockId(lines.slice(index + 1, close).join('\n'));
		if (id === blockId) return { lineStart: index, lineEnd: close };

		// Resume past this block's closing fence, so its contents can't be
		// mistaken for the start of another one.
		index = close;
	}

	return null;
}

// Finds the ink block whose body is exactly `body`, but only when the note
// holds precisely one of them.
//
// This is how a block with no id of its own gets located, and the
// uniqueness requirement is the whole point. Two ink blocks nobody has
// drawn in yet are byte-identical — the same fifty-five characters of empty
// JSON — so their text is not an identity, it is a description that fits
// both.
//
// Trusting it anyway is how a note lost work. Obsidian's getSectionInfo
// can hand a block the line range of a *different* block, the range was
// checked by comparing text, two empty blocks compared equal, and the save
// went through: one block's drawing written into another block's fence,
// which from the outside looks exactly like the work in the first block
// vanishing the moment the second one was touched.
//
// Returning null when the answer is ambiguous makes the save fail instead,
// and a failed save keeps the ink (see unsavedInk in markdown/inkBlock.ts)
// rather than putting it somewhere it does not belong.
export function findUniqueInkBlockByBody(lines: readonly string[], body: string): InkBlockRange | null {
	const wanted = body.trim();
	if (!wanted) return null;

	let found: InkBlockRange | null = null;
	for (let index = 0; index < lines.length; index++) {
		if (!isOpeningFence(lines[index])) continue;

		let close = index + 1;
		while (close < lines.length && !isClosingFence(lines[close])) close++;
		if (close >= lines.length) return null;

		if (lines.slice(index + 1, close).join('\n').trim() === wanted) {
			// A second match means the text identifies nothing.
			if (found) return null;
			found = { lineStart: index, lineEnd: close };
		}

		index = close;
	}

	return found;
}
