import type { PicturePixels, Rect } from './types';

// Cutting a picture down to part of itself — its pixels, not a mask over
// them: what is cropped away is gone from the file too, the way a crop in a
// photo app is once saved, rather than still there for anyone who opens
// the PDF to find. Undo brings the whole picture back, from the history.

// The pixels of `picture` that fall in `crop`, where the picture is shown
// as `shown` — both in page space. Rounded outwards to whole pixels, and at
// least one of them.
export function cropRegion(picture: PicturePixels, shown: Rect, crop: Rect): { x: number; y: number; width: number; height: number } {
	const scaleX = picture.width / Math.max(shown.maxX - shown.minX, 1e-6);
	const scaleY = picture.height / Math.max(shown.maxY - shown.minY, 1e-6);
	const clampX = (value: number) => Math.min(Math.max(value, 0), picture.width);
	const clampY = (value: number) => Math.min(Math.max(value, 0), picture.height);
	const left = clampX(Math.floor((crop.minX - shown.minX) * scaleX + 1e-6));
	const top = clampY(Math.floor((crop.minY - shown.minY) * scaleY + 1e-6));
	const right = clampX(Math.ceil((crop.maxX - shown.minX) * scaleX - 1e-6));
	const bottom = clampY(Math.ceil((crop.maxY - shown.minY) * scaleY - 1e-6));
	const x = Math.min(left, picture.width - 1);
	const y = Math.min(top, picture.height - 1);
	return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

// Raw pixels are copied row by row; a JPEG is decoded, cut and encoded
// again — at a high quality, since it was compressed once already.
export async function cropPicture(picture: PicturePixels, region: { x: number; y: number; width: number; height: number }, doc: Document): Promise<PicturePixels> {
	if (picture.format === 'rgba') {
		const data = new Uint8Array(region.width * region.height * 4);
		for (let row = 0; row < region.height; row++) {
			const from = ((region.y + row) * picture.width + region.x) * 4;
			data.set(picture.data.subarray(from, from + region.width * 4), row * region.width * 4);
		}
		return { format: 'rgba', width: region.width, height: region.height, data };
	}

	const bitmap = await createImageBitmap(new Blob([new Uint8Array(picture.data)], { type: 'image/jpeg' }));
	try {
		const canvas = doc.createElement('canvas');
		canvas.width = region.width;
		canvas.height = region.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('no 2D canvas to crop the picture on');
		ctx.drawImage(bitmap, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
		const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
		if (!jpeg) throw new Error('the cropped picture could not be encoded');
		return { format: 'jpeg', width: region.width, height: region.height, data: new Uint8Array(await jpeg.arrayBuffer()) };
	} finally {
		bitmap.close();
	}
}
