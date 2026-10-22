import { App, FuzzySuggestModal, TFile } from 'obsidian';
import type { PicturePixels, Point, Rect } from './annotate/types';

// Bringing PDFs and pictures into a PDF from outside it: choosing the file,
// from the vault or from the device, and getting a picture ready to place.
// The PDF view does the inserting (see pdfView.ts).

// What a picture can be imported from. Whatever the platform's own image
// decoder reads; HEIC only where that is Safari, which is where iPhone
// photos come from.
export const PICTURE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'heic'];

// The longest side a picture is kept at. A phone photo is 4000 pixels or
// more across, ten times what a page shows it at, and would make the PDF
// megabytes larger for nothing anyone can see.
export const MAX_PICTURE_SIDE = 2000;

// How much of the page a picture first takes, at most, before it is sized
// into place by hand.
const FIRST_FIT = 0.6;

// A list of the vault's files of the given kinds to choose one from, by
// typing part of its name — Obsidian's own quick switcher, as it looks for
// files everywhere else.
class VaultFileModal extends FuzzySuggestModal<TFile> {
	constructor(
		app: App,
		private readonly files: TFile[],
		placeholder: string,
		private readonly onChoose: (file: TFile) => void,
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}

export function chooseVaultFile(app: App, extensions: readonly string[], placeholder: string, onChoose: (file: TFile) => void): void {
	const files = app.vault
		.getFiles()
		.filter((file) => extensions.includes(file.extension.toLowerCase()))
		.sort((a, b) => b.stat.mtime - a.stat.mtime);
	new VaultFileModal(app, files, placeholder, onChoose).open();
}

// The device's own file chooser — on a tablet or a phone the system picker,
// with the photo library and the camera in it. Resolves with nothing when
// the chooser is closed without a choice.
export function chooseDeviceFile(doc: Document, accept: string): Promise<File | null> {
	return new Promise((resolve) => {
		const input = doc.body.createEl('input', { attr: { type: 'file', accept } });
		input.hidden = true;
		const finish = (file: File | null) => {
			input.remove();
			resolve(file);
		};
		input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
		input.addEventListener('cancel', () => finish(null), { once: true });
		input.click();
	});
}

// A picture made ready for a page: decoded, brought down to
// MAX_PICTURE_SIDE, and stored as JPEG — or as raw pixels where something in
// it is see-through, which JPEG cannot hold. Throws for a file this platform
// cannot decode.
export async function preparePicture(blob: Blob, doc: Document): Promise<PicturePixels> {
	const bitmap = await createImageBitmap(blob);
	try {
		const scale = Math.min(1, MAX_PICTURE_SIDE / Math.max(bitmap.width, bitmap.height));
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = doc.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('no 2D canvas to prepare the picture on');
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage(bitmap, 0, 0, width, height);

		const pixels = ctx.getImageData(0, 0, width, height).data;
		let seeThrough = false;
		for (let index = 3; index < pixels.length; index += 4) {
			if ((pixels[index] ?? 255) < 255) {
				seeThrough = true;
				break;
			}
		}
		if (seeThrough) return { format: 'rgba', width, height, data: new Uint8Array(pixels) };

		const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88));
		if (!jpeg) throw new Error('the picture could not be encoded');
		return { format: 'jpeg', width, height, data: new Uint8Array(await jpeg.arrayBuffer()) };
	} finally {
		bitmap.close();
	}
}

// Where a picture first lands: as large as fits in FIRST_FIT of the page
// either way, in its own proportions, centred on `centre` — the middle of
// the part of the page on screen — and pulled back inside the page where
// that would put it over an edge.
export function placePicture(page: Rect, picture: { width: number; height: number }, centre: Point): Rect {
	const pageWidth = page.maxX - page.minX;
	const pageHeight = page.maxY - page.minY;
	const scale = Math.min((pageWidth * FIRST_FIT) / picture.width, (pageHeight * FIRST_FIT) / picture.height);
	const width = picture.width * scale;
	const height = picture.height * scale;
	const minX = Math.min(Math.max(centre.x - width / 2, page.minX), page.maxX - width);
	const minY = Math.min(Math.max(centre.y - height / 2, page.minY), page.maxY - height);
	return { minX, minY, maxX: minX + width, maxY: minY + height };
}
