import { App, Notice, TFile } from 'obsidian';
import type { PlannedPage } from './pdf/pages';

// Links in notes that lead to a page of a PDF — [[Book.pdf#page=12]], or
// [Book, page 12](Book.pdf#page=12) — are by number, and the number stops
// meaning that page when pages move. So a change to a PDF's pages follows
// its links through the vault.
//
// A link to a page that was deleted has nowhere to go. It is left alone and
// counted, rather than quietly removed from someone's writing.

// The page each page is now, or null for one that is gone.
export type PageMap = (page: number) => number | null;

// A page listed twice was duplicated, and its links stay with the first.
export function pageMapOfPlan(plan: readonly PlannedPage[]): PageMap {
	const places = new Map<number, number>();
	plan.forEach(({ page }, index) => {
		if (!places.has(page)) places.set(page, index + 1);
	});
	return (page) => places.get(page) ?? null;
}

// `added` pages placed after the first `after` ones.
export const pageMapOfInsertion = (after: number, added: number): PageMap => (page) => (page <= after ? page : page + added);

export const pageMapOfDeletion = (deleted: number): PageMap => (page) => (page === deleted ? null : page > deleted ? page - 1 : page);

const WIKI_LINK = /\[\[([^\]|#\n]+)#page=(\d+)([^\]|\n]*)(\|[^\]\n]*)?\]\]/g;
const MARKDOWN_LINK = /\[([^\]\n]*)\]\(([^)#\n]+)#page=(\d+)([^)\n]*)\)/g;

function linkTarget(raw: string): string {
	const path = raw.trim().replace(/^</, '');
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

// "Book, page 12" is about page 12, so it moves with it.
function followText(text: string, from: number, to: number): string {
	return text.replace(/\b(page\s+|seite\s+)(\d+)\b/i, (match: string, word: string, number: string) => (Number(number) === from ? `${word}${to}` : match));
}

export interface LinkRewrite {
	text: string;
	changed: number;
	orphaned: number;
}

export function rewritePageLinks(text: string, isThisPdf: (path: string) => boolean, map: PageMap): LinkRewrite {
	let changed = 0;
	let orphaned = 0;
	// Which number the link now wants, or null to leave it as it is.
	const moved = (path: string, page: string): { from: number; to: number } | null => {
		if (!isThisPdf(linkTarget(path))) return null;
		const from = Number(page);
		const to = map(from);
		if (to === null) orphaned++;
		if (to === null || to === from) return null;
		changed++;
		return { from, to };
	};
	const next = text
		.replace(WIKI_LINK, (match: string, path: string, page: string, rest: string, alias: string | undefined) => {
			const change = moved(path, page);
			return change ? `[[${path}#page=${change.to}${rest}${alias ? followText(alias, change.from, change.to) : ''}]]` : match;
		})
		.replace(MARKDOWN_LINK, (match: string, label: string, path: string, page: string, rest: string) => {
			const change = moved(path, page);
			return change ? `[${followText(label, change.from, change.to)}](${path}#page=${change.to}${rest})` : match;
		});
	return { text: next, changed, orphaned };
}

// Follows a change to `file`'s pages through every note linking to it, and
// says what it did if there was anything to say. Never throws: the PDF has
// already changed by now, and a note that could not be written is no reason
// to report that it did not.
export async function followPageLinks(app: App, file: TFile, map: PageMap): Promise<void> {
	let changed = 0;
	let orphaned = 0;
	let notes = 0;
	try {
		for (const [path, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
			if (!targets[file.path]) continue;
			const note = app.vault.getAbstractFileByPath(path);
			if (!(note instanceof TFile) || note.extension !== 'md') continue;
			const isThisPdf = (link: string) => app.metadataCache.getFirstLinkpathDest(link, note.path)?.path === file.path;
			let inNote = 0;
			let lost = 0;
			await app.vault.process(note, (text) => {
				const result = rewritePageLinks(text, isThisPdf, map);
				inNote = result.changed;
				lost = result.orphaned;
				return result.text;
			});
			changed += inNote;
			orphaned += lost;
			if (inNote > 0) notes++;
		}
	} catch (error) {
		console.error('InklingExpanded: could not update the links to this PDF.', error);
		new Notice('InklingExpanded: some links to this PDF could not be updated.');
		return;
	}
	const said: string[] = [];
	if (changed > 0) said.push(`updated ${changed} ${changed === 1 ? 'link' : 'links'} in ${notes} ${notes === 1 ? 'note' : 'notes'}`);
	if (orphaned > 0) said.push(`${orphaned} ${orphaned === 1 ? 'link leads' : 'links lead'} to a deleted page`);
	if (said.length > 0) new Notice(`InklingExpanded: ${said.join('; ')}.`);
}
