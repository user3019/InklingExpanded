import { App, FuzzySuggestModal, normalizePath, Notice, TFile } from 'obsidian';
import { refreshCoreReaders } from './coreViews';
import { writeBinarySafely } from './vaultWrite';

// A copy of a PDF from just before this plugin rebuilt it — added or
// deleted a page, inserted another PDF's pages, changed a background —
// kept on this device, so that whatever goes wrong with a rebuild, the note
// as it was is one command away ("Restore an earlier version of this PDF").
//
// Ink alone is not backed up: it is saved in small steps that undo covers.
// A rebuild rewrites the whole file, and is the one step where a mistake —
// this plugin's, or a sync's landing at the same moment — could cost a
// whole note.
//
// Kept in the plugin's own folder, which no sync of the vault's notes
// carries by default, and only the last few per note. Large PDFs — books,
// more than MAX_BACKUP_BYTES — are not copied: a rebuild never touches
// what is printed in them, and a copy would cost the device that much
// storage again each time.

const KEEP_PER_FILE = 5;
const MAX_BACKUP_BYTES = 60 * 1024 * 1024;

export type BackupReason = 'add-page' | 'insert-pages' | 'background' | 'delete-page' | 'restore';

const REASON_LABELS: Record<BackupReason, string> = {
	'add-page': 'before a page was added',
	'insert-pages': 'before pages were inserted',
	background: 'before the background changed',
	'delete-page': 'before a page was deleted',
	restore: 'before an earlier version was restored',
};

function backupFolder(app: App): string {
	return normalizePath(`${app.vault.configDir}/plugins/inkling-expanded/backups`);
}

// The note's path, made into one file name.
function keyFor(file: TFile): string {
	return file.path.replace(/[\\/:*?"<>|@]/g, '_');
}

export async function backUp(app: App, file: TFile, bytes: ArrayBuffer, reason: BackupReason): Promise<void> {
	if (bytes.byteLength > MAX_BACKUP_BYTES) return;
	try {
		const adapter = app.vault.adapter;
		const folder = backupFolder(app);
		if (!(await adapter.exists(folder))) await adapter.mkdir(folder);
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		await adapter.writeBinary(`${folder}/${keyFor(file)}@${stamp}@${reason}.pdf`, bytes);

		const older = (await listBackups(app, file)).slice(KEEP_PER_FILE);
		for (const backup of older) await adapter.remove(backup.path);
	} catch (error) {
		// No copy is no reason to stop the change the user asked for.
		console.warn('Inkling: could not keep a backup of this PDF.', error);
	}
}

export interface Backup {
	path: string;
	time: Date;
	reason: BackupReason | null;
}

// This note's backups, newest first.
export async function listBackups(app: App, file: TFile): Promise<Backup[]> {
	const folder = backupFolder(app);
	const adapter = app.vault.adapter;
	if (!(await adapter.exists(folder))) return [];
	const prefix = `${keyFor(file)}@`;
	const backups: Backup[] = [];
	for (const path of (await adapter.list(folder)).files) {
		const name = path.slice(path.lastIndexOf('/') + 1);
		if (!name.startsWith(prefix) || !name.endsWith('.pdf')) continue;
		const [stamp = '', reason = ''] = name.slice(prefix.length, -'.pdf'.length).split('@');
		// Back from the file-name form of an ISO time.
		const time = new Date(stamp.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2:$3.$4Z'));
		if (Number.isNaN(time.getTime())) continue;
		backups.push({ path, time, reason: reason in REASON_LABELS ? (reason as BackupReason) : null });
	}
	return backups.sort((a, b) => b.time.getTime() - a.time.getTime());
}

export function describeBackup(backup: Backup): string {
	const when = backup.time.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	return backup.reason ? `${when} — ${REASON_LABELS[backup.reason]}` : when;
}

// Puts a backup back in place of the note, keeping the note as it is now as
// a backup of its own first — so a restore is never the step that loses
// something either.
export async function restoreBackup(app: App, file: TFile, backup: Backup): Promise<boolean> {
	try {
		const bytes = await app.vault.adapter.readBinary(backup.path);
		await backUp(app, file, await app.vault.readBinary(file), 'restore');
		await writeBinarySafely(app.vault, file, bytes);
		await refreshCoreReaders(app, file);
		new Notice(`Inkling: “${file.basename}” is back as it was ${describeBackup(backup).replace(' — ', ', ')}.`);
		return true;
	} catch (error) {
		console.error('Inkling: could not restore a backup.', error);
		new Notice('Inkling: could not restore that version.');
		return false;
	}
}

export class BackupModal extends FuzzySuggestModal<Backup> {
	constructor(
		app: App,
		private readonly file: TFile,
		private readonly backups: Backup[],
	) {
		super(app);
		this.setPlaceholder(`Restore “${file.basename}” as it was…`);
	}

	getItems(): Backup[] {
		return this.backups;
	}

	getItemText(backup: Backup): string {
		return describeBackup(backup);
	}

	onChooseItem(backup: Backup): void {
		void restoreBackup(this.app, this.file, backup);
	}
}
