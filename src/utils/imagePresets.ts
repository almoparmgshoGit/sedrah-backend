import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

/*
 * The exact size of every image shown in the customer app. An upload that names a preset is cropped
 * and resized to it on the server, so a wrong size from any app or the admin panel is fixed in one place.
 * The company app and the admin panel show the same sizes next to each image field; keep them in sync.
 */
export interface ImagePreset {
  width: number;
  height: number;
  // cover: crops to fill the frame (photos). contain: keeps the whole image on a transparent canvas (logos)
  fit: 'cover' | 'contain';
}

export const IMAGE_PRESETS: Record<string, ImagePreset> = {
  logo: { width: 512, height: 512, fit: 'contain' }, // company logo, square
  cover: { width: 1200, height: 800, fit: 'cover' }, // company profile cover, 260pt tall on a phone
  package: { width: 1200, height: 900, fit: 'cover' }, // package photo and album, 288pt tall gallery
  city: { width: 800, height: 800, fit: 'cover' }, // city cards and the hexagon on the home screen
  product: { width: 1000, height: 1000, fit: 'cover' }, // store products and their colors
  banner: { width: 1200, height: 500, fit: 'cover' }, // store ads banner, wide strip
};

export const getImagePreset = (name: unknown): ImagePreset | null =>
  typeof name === 'string' && Object.prototype.hasOwnProperty.call(IMAGE_PRESETS, name) ? IMAGE_PRESETS[name] : null;

export interface ResizeResult {
  filePath: string;
  filename: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  resized: boolean;
}

/**
 * Rewrites the stored image at the preset's exact size and returns its new name (the extension may change).
 * Cover crops around the most detailed part of the photo rather than blindly from the centre.
 */
export const fitImageToPreset = async (filePath: string, preset: ImagePreset): Promise<ResizeResult> => {
  const input = fs.readFileSync(filePath);
  // Phones store the rotation separately; without rotate() a portrait photo is measured sideways
  const meta = await sharp(input).rotate().metadata();
  const upright = (meta.orientation || 1) >= 5;
  const originalWidth = (upright ? meta.height : meta.width) || 0;
  const originalHeight = (upright ? meta.width : meta.height) || 0;

  const pipeline = sharp(input).rotate().resize(preset.width, preset.height, {
    fit: preset.fit,
    position: preset.fit === 'cover' ? sharp.strategy.attention : 'centre',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });

  // Logos keep their transparency; photos become a compact JPEG
  const ext = preset.fit === 'contain' ? '.png' : '.jpg';
  const output = ext === '.png' ? await pipeline.png({ compressionLevel: 9 }).toBuffer() : await pipeline.flatten({ background: '#FFFFFF' }).jpeg({ quality: 85, mozjpeg: true }).toBuffer();

  const dir = path.dirname(filePath);
  const filename = `${path.basename(filePath, path.extname(filePath))}${ext}`;
  const newPath = path.join(dir, filename);
  fs.writeFileSync(newPath, output);
  if (newPath !== filePath) fs.unlinkSync(filePath);

  return {
    filePath: newPath,
    filename,
    width: preset.width,
    height: preset.height,
    originalWidth,
    originalHeight,
    resized: originalWidth !== preset.width || originalHeight !== preset.height,
  };
};
