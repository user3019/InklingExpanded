// Getting around a long document, as pure logic.
//
// Entering annotate mode gives up Obsidian's own PDF chrome — the outline,
// the page box, the find bar — which for a 900-page textbook is most of how
// anyone gets around it. This is the part of putting those back that does
// not touch pdf.js or the DOM, so it can be tested.

export interface OutlineEntry {
	title: string;
	// Null when the destination could not be resolved. Those are dropped by
	// flattenOutline rather than shown, because an entry that does nothing
	// when clicked is worse than an entry that isn't there.
	pageNumber: number | null;
	depth: number;
	// Its place in the outline: its position among its siblings at each
	// level. What a change to the bookmarks finds it by (see outline.ts).
	path: number[];
}

// The shape pdf.js's getOutline() returns, narrowed to what is used here.
// Declared rather than imported so this module stays free of pdf.js.
export interface RawOutlineItem {
	title?: unknown;
	dest?: unknown;
	items?: readonly RawOutlineItem[];
}

// How deep an outline is walked. A malformed document can describe a cyclic
// or absurdly deep tree, and this is a list in a side panel, not a data
// structure anyone needs in full.
const MAX_OUTLINE_DEPTH = 6;

export async function flattenOutline(
	items: readonly RawOutlineItem[] | null | undefined,
	resolve: (dest: unknown) => Promise<number | null>,
	depth = 0,
	parent: readonly number[] = [],
): Promise<OutlineEntry[]> {
	if (!items || depth > MAX_OUTLINE_DEPTH) return [];

	const flattened: OutlineEntry[] = [];
	for (const [index, item] of items.entries()) {
		const path = [...parent, index];
		const title = typeof item.title === 'string' ? item.title.trim() : '';

		let pageNumber: number | null = null;
		try {
			pageNumber = await resolve(item.dest);
		} catch {
			// A dangling or malformed destination is a property of the file,
			// not a bug here — and it must not take the rest of the tree down
			// with it.
			pageNumber = null;
		}

		// An untitled entry is not worth a row, and one that goes nowhere
		// would be a dead link. Their children may still be fine, so the walk
		// continues past them rather than pruning the branch.
		if (title && pageNumber !== null) flattened.push({ title, pageNumber, depth, path });
		flattened.push(...(await flattenOutline(item.items, resolve, depth + 1, path)));
	}
	return flattened;
}

// How many times `query` occurs in `text`, case-insensitively.
//
// Deliberately counting non-overlapping occurrences, and deliberately not
// using a regular expression: the query is whatever the user typed, and
// building a regex from it would either need escaping or would let a stray
// bracket throw in the middle of a 900-page walk.
export function findMatches(text: string, query: string): number {
	const needle = query.trim().toLowerCase();
	if (!needle) return 0;

	const haystack = text.toLowerCase();
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}
