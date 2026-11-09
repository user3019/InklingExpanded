import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import { riskyFeatures } from './compatibility';

// A PDF's bookmarks — its outline, the table of contents a reader shows in
// its sidebar — and changing them. Written into the file, so they are there
// in every other PDF reader too.
//
// An entry is addressed by its path: its position among its siblings at each
// level, which is the same position pdf.js reports it at when the panel lists
// them. The title is checked as well before anything is changed, so that a
// file that moved under a stale list cannot have the wrong entry renamed.

export type BookmarkPath = readonly number[];

export type BookmarkChange =
	| { kind: 'add'; title: string; pageNumber: number; inside: BookmarkPath | null }
	| { kind: 'rename'; path: BookmarkPath; expected: string; title: string }
	| { kind: 'remove'; path: BookmarkPath; expected: string };

export type BookmarkResult = { kind: 'changed'; bytes: Uint8Array } | { kind: 'refused'; reason: string };

const key = (name: string) => PDFName.of(name);
// A cycle in a malformed file must not be followed for ever.
const MAX_SIBLINGS = 20000;

function siblingsOf(doc: PDFDocument, parent: PDFDict): PDFRef[] {
	const refs: PDFRef[] = [];
	const seen = new Set<PDFRef>();
	let next = parent.get(key('First'));
	while (next instanceof PDFRef && !seen.has(next) && refs.length < MAX_SIBLINGS) {
		seen.add(next);
		refs.push(next);
		next = doc.context.lookupMaybe(next, PDFDict)?.get(key('Next'));
	}
	return refs;
}

function titleOf(item: PDFDict): string {
	return item.lookupMaybe(key('Title'), PDFString, PDFHexString)?.decodeText() ?? '';
}

// A title as pdf.js and pdf-lib will both have it: they differ over control
// characters and the spaces around it.
function comparable(title: string): string {
	return [...title].filter((character) => character >= ' ').join('').trim();
}

// What an entry points at directly, if it is a page. An entry may also say
// so through a named destination or an action; those read as "no page".
function targetOf(doc: PDFDocument, item: PDFDict): PDFRef | null {
	let dest = item.lookupMaybe(key('Dest'), PDFArray);
	if (!dest) dest = item.lookupMaybe(key('A'), PDFDict)?.lookupMaybe(key('D'), PDFArray);
	const first = dest?.get(0);
	return first instanceof PDFRef && doc.context.lookupMaybe(first, PDFDict) ? first : null;
}

// Writes a list of entries back as the children of `parent`, each linked to
// its neighbours.
function linkSiblings(doc: PDFDocument, parent: PDFDict, parentRef: PDFRef, refs: readonly PDFRef[]): void {
	refs.forEach((ref, index) => {
		const item = doc.context.lookup(ref, PDFDict);
		item.set(key('Parent'), parentRef);
		const previous = refs[index - 1];
		const next = refs[index + 1];
		if (previous) item.set(key('Prev'), previous);
		else item.delete(key('Prev'));
		if (next) item.set(key('Next'), next);
		else item.delete(key('Next'));
	});
	const [first] = refs;
	const last = refs[refs.length - 1];
	if (first && last) {
		parent.set(key('First'), first);
		parent.set(key('Last'), last);
	} else {
		parent.delete(key('First'));
		parent.delete(key('Last'));
		parent.delete(key('Count'));
	}
}

// How many entries show under each, from `parent` down: the /Count the
// specification asks for. What it returns is how many that adds to the
// entry above.
function recount(doc: PDFDocument, parent: PDFDict, depth = 0): number {
	if (depth > 32) return 0;
	const refs = siblingsOf(doc, parent);
	if (refs.length === 0) return 0;
	let visible = refs.length;
	for (const ref of refs) {
		const item = doc.context.lookupMaybe(ref, PDFDict);
		if (item) visible += recount(doc, item, depth + 1);
	}
	// A negative count is an entry shown folded, which stays as it was.
	const folded = depth > 0 && (parent.lookupMaybe(key('Count'), PDFNumber)?.asNumber() ?? 0) < 0;
	parent.set(key('Count'), doc.context.obj(folded ? -visible : visible));
	return folded ? 0 : visible;
}

function outlineRoot(doc: PDFDocument, create: boolean): { root: PDFDict; rootRef: PDFRef } | null {
	const existing = doc.catalog.get(key('Outlines'));
	if (existing instanceof PDFRef) {
		const root = doc.context.lookupMaybe(existing, PDFDict);
		if (root) return { root, rootRef: existing };
	}
	if (!create) return null;
	const root = doc.context.obj({ Type: 'Outlines' });
	const rootRef = doc.context.register(root);
	doc.catalog.set(key('Outlines'), rootRef);
	return { root, rootRef };
}

function find(doc: PDFDocument, root: PDFDict, rootRef: PDFRef, path: BookmarkPath) {
	let parent = root;
	let parentRef = rootRef;
	for (let level = 0; level < path.length - 1; level++) {
		const ref = siblingsOf(doc, parent)[path[level] as number];
		if (!ref) return null;
		parent = doc.context.lookup(ref, PDFDict);
		parentRef = ref;
	}
	const siblings = siblingsOf(doc, parent);
	const index = path[path.length - 1] as number;
	const ref = siblings[index];
	return ref ? { parent, parentRef, siblings, index, ref, item: doc.context.lookup(ref, PDFDict) } : null;
}

// An entry and everything under it, out of the file.
function deleteEntry(doc: PDFDocument, ref: PDFRef, depth = 0): void {
	const item = doc.context.lookupMaybe(ref, PDFDict);
	if (item && depth < 32) for (const child of siblingsOf(doc, item)) deleteEntry(doc, child, depth + 1);
	doc.context.delete(ref);
}

const STALE = 'the list of bookmarks was out of date — open it again and retry';

export function applyBookmarkChange(doc: PDFDocument, change: BookmarkChange): string | null {
	const hold = outlineRoot(doc, change.kind === 'add');
	if (!hold) return STALE;
	const { root, rootRef } = hold;

	if (change.kind === 'rename' || change.kind === 'remove') {
		const found = find(doc, root, rootRef, change.path);
		if (!found || comparable(titleOf(found.item)) !== comparable(change.expected)) return STALE;
		if (change.kind === 'rename') {
			found.item.set(key('Title'), PDFHexString.fromText(change.title));
			return null;
		}
		const left = found.siblings.filter((ref) => ref !== found.ref);
		linkSiblings(doc, found.parent, found.parentRef, left);
		deleteEntry(doc, found.ref);
		recount(doc, root);
		return null;
	}

	const page = doc.getPages()[change.pageNumber - 1];
	if (!page) return 'that page is not in this PDF';
	let parent = root;
	let parentRef = rootRef;
	if (change.inside) {
		const found = find(doc, root, rootRef, change.inside);
		if (!found) return STALE;
		parent = found.item;
		parentRef = found.ref;
	}
	const item = doc.context.register(
		doc.context.obj({ Title: PDFHexString.fromText(change.title), Parent: parentRef, Dest: [page.ref, key('Fit')] }),
	);
	// Among its siblings in page order, after any on the same page; entries
	// that do not say which page they go to are stepped over.
	const order = new Map(doc.getPages().map((each, index) => [each.ref, index]));
	const siblings = siblingsOf(doc, parent);
	let position = 0;
	siblings.forEach((ref, index) => {
		const target = targetOf(doc, doc.context.lookup(ref, PDFDict));
		const at = target ? order.get(target) : undefined;
		if (at === undefined || at <= change.pageNumber - 1) position = index + 1;
	});
	linkSiblings(doc, parent, parentRef, [...siblings.slice(0, position), item, ...siblings.slice(position)]);
	recount(doc, root);
	return null;
}

export async function changeBookmarks(bytes: ArrayBuffer | Uint8Array, change: BookmarkChange): Promise<BookmarkResult> {
	const doc = await PDFDocument.load(bytes);
	const risky = riskyFeatures(doc);
	if (risky.length > 0) return { kind: 'refused', reason: `the PDF contains ${risky.join(' and ')}, which rewriting it would break` };
	const problem = applyBookmarkChange(doc, change);
	return problem ? { kind: 'refused', reason: problem } : { kind: 'changed', bytes: await doc.save() };
}

// Bookmarks that lead to these pages, gone with them. Entries beneath one go
// too: they were its subsections.
export function removeBookmarksTo(doc: PDFDocument, pages: ReadonlySet<PDFRef>): void {
	const hold = outlineRoot(doc, false);
	if (!hold) return;
	const prune = (parent: PDFDict, parentRef: PDFRef, depth: number) => {
		if (depth > 32) return;
		const siblings = siblingsOf(doc, parent);
		const kept = siblings.filter((ref) => {
			const target = targetOf(doc, doc.context.lookup(ref, PDFDict));
			if (target && pages.has(target)) {
				deleteEntry(doc, ref);
				return false;
			}
			return true;
		});
		if (kept.length !== siblings.length) linkSiblings(doc, parent, parentRef, kept);
		for (const ref of kept) prune(doc.context.lookup(ref, PDFDict), ref, depth + 1);
	};
	prune(hold.root, hold.rootRef, 0);
	recount(doc, hold.root);
}

// A short description of the document's page turns and outline, for telling
// whether another device changed either: neither shows in the page list.
export function layoutStampOf(doc: PDFDocument): string {
	const turns = doc.getPages().map((page) => page.getRotation().angle).join(',');
	const hold = outlineRoot(doc, false);
	const titles: string[] = [];
	const walk = (parent: PDFDict, depth: number) => {
		if (depth > 32) return;
		for (const ref of siblingsOf(doc, parent)) {
			const item = doc.context.lookup(ref, PDFDict);
			titles.push(`${depth}:${titleOf(item)}:${targetOf(doc, item)?.toString() ?? ''}`);
			walk(item, depth + 1);
		}
	};
	if (hold) walk(hold.root, 0);
	return `${turns}|${titles.join('\n')}`;
}
