import { App, TFile } from 'obsidian';
import { PDFDocument } from 'pdf-lib';
import { openInCoreReader, refreshCoreReaders, wasJustRefreshed } from './coreViews';
import { pageIdsOf } from './pdf/annotationWriterCore';
import { layoutStampOf } from './pdf/outline';

// Keeps Obsidian's own PDF reader right about a file changed elsewhere. It
// reloads the pages by itself, but not its page count or thumbnails — so
// pages added, deleted or moved on another device, and brought over by a
// sync, left the sidebar showing the old ones.
//
// A file changes far more often than its pages do: every save of another
// device's ink is one. Rebuilding a reader each time would have it flashing
// under whoever is reading, so the pages are compared first, and only a
// change to them rebuilds it. That means parsing the file, here on the main
// thread, so a file past MAX_WATCHED_BYTES is left alone.

const MAX_WATCHED_BYTES = 25 * 1024 * 1024;
// A burst of a sync's writes counts once, after it has settled.
const SETTLE_MS = 2000;
// Long enough after a reader opens not to compete with its first pages.
const FIRST_LOOK_MS = 1500;

export class ReaderPageWatch {
	// Each watched file's pages, in order, as last seen.
	private readonly known = new Map<string, string>();
	private readonly timers = new Map<string, number>();

	constructor(private readonly app: App) {}

	readerOpened(file: TFile): void {
		if (this.known.has(file.path) || file.stat.size > MAX_WATCHED_BYTES) return;
		this.after(file, FIRST_LOOK_MS);
	}

	fileChanged(file: TFile): void {
		if (file.extension !== 'pdf' || file.stat.size > MAX_WATCHED_BYTES || !openInCoreReader(this.app, file)) return;
		this.after(file, SETTLE_MS);
	}

	stop(): void {
		for (const timer of this.timers.values()) window.clearTimeout(timer);
		this.timers.clear();
	}

	private after(file: TFile, delay: number): void {
		const waiting = this.timers.get(file.path);
		if (waiting !== undefined) window.clearTimeout(waiting);
		this.timers.set(
			file.path,
			window.setTimeout(() => {
				this.timers.delete(file.path);
				void this.look(file);
			}, delay),
		);
	}

	private async look(file: TFile): Promise<void> {
		let pages: string;
		try {
			const doc = await PDFDocument.load(await this.app.vault.readBinary(file), { updateMetadata: false });
			pages = `${pageIdsOf(doc).join(' ')}|${layoutStampOf(doc)}`;
		} catch {
			// Most likely a sync still writing it. Its next change looks again.
			return;
		}
		const before = this.known.get(file.path);
		this.known.set(file.path, pages);
		// This device's own page changes refresh the reader themselves.
		if (before !== undefined && before !== pages && !wasJustRefreshed(file)) await refreshCoreReaders(this.app, file);
	}
}
