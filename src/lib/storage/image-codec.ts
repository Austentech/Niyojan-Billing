import sharp from "sharp";

/**
 * Shared image codec — the single hardened decode/normalize/re-encode pipeline
 * used by EVERY logo upload in the system (firm logos, corporation logo).
 *
 *   1. Content type is determined by MAGIC BYTES, never by the client-supplied
 *      filename or Content-Type header (a .png-named text file is rejected).
 *   2. The image is fully re-encoded with sharp: this proves it decodes as a
 *      real image, strips EXIF/metadata, caps the dimensions (no upscaling)
 *      and removes any trailing junk after the image payload — neutralizing
 *      polyglot payloads.
 *
 * This module is PURE (no environment access, no error taxonomy of its own):
 * callers wrap failures into their own public/system error types.
 */

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

const EXT_BY_MIME: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

const MIME_BY_EXT: Record<string, ImageMime> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Whitelisted extension for a recognized image MIME type. */
export function extensionForMime(mime: ImageMime): string {
  return EXT_BY_MIME[mime];
}

/** MIME type for a whitelisted extension (or null). */
export function mimeForExtension(ext: string): ImageMime | null {
  return MIME_BY_EXT[ext.toLowerCase()] ?? null;
}

/** Detect the image type from magic bytes; null when unrecognized. */
export function detectImageMime(bytes: Buffer): ImageMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Full decode + normalize + re-encode. Throws a plain Error when the bytes
 * are not a decodable image — callers translate that into their own safe
 * public error.
 */
export async function normalizeImage(
  bytes: Buffer,
  mime: ImageMime,
  maxDimension: number,
): Promise<Buffer> {
  let pipeline = sharp(bytes, { failOn: "error", animated: false }).rotate(); // auto-orient via EXIF, then strip it
  pipeline = pipeline.resize({
    width: maxDimension,
    height: maxDimension,
    fit: "inside",
    withoutEnlargement: true,
  });
  if (mime === "image/png") {
    return pipeline.png({ compressionLevel: 9 }).toBuffer();
  }
  if (mime === "image/jpeg") {
    return pipeline.jpeg({ quality: 86 }).toBuffer();
  }
  return pipeline.webp({ quality: 86 }).toBuffer();
}
