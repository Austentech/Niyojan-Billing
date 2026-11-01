import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { getServerEnv } from "@/lib/config/env";
import { getSupabaseServiceClient } from "@/lib/auth/server/db";
import { FIRM_LOGO_BUCKET, FIRM_LOGO_LOCAL_DIR, FIRM_LOGO_POLICY, FIRM_LOGO_PUBLIC_PREFIX } from "@/lib/constants";
import { PublicFirmError, SystemFirmError, logFirmEvent } from "@/lib/firms/errors";

/**
 * Firm logo storage — hardening applied BEFORE any byte is persisted:
 *
 *   1. Size limit (2 MB) checked on the actual buffer.
 *   2. Content type determined by MAGIC BYTES, never by the client-supplied
 *      filename or Content-Type header (a .png-named text file is rejected).
 *   3. The image is fully re-encoded with sharp: this proves it decodes as a
 *      real image, strips EXIF/metadata, caps the dimensions (512px box, no
 *      upscaling) and removes any trailing junk after the image payload —
 *      neutralizing polyglot payloads.
 *   4. The stored filename is a server-generated UUID + whitelisted
 *      extension — no user-controlled characters ever reach a path.
 *
 * STORAGE ADAPTERS
 *   * "supabase" (default, production) — dedicated `firm-logos` bucket via
 *     the service-role client; public URLs from Supabase Storage.
 *   * "local" (development/harness) — files under .data/firm-logos, served
 *     only through the sanitized /uploads/[...path] route handler.
 */

export type LogoMime = (typeof FIRM_LOGO_POLICY.mimeTypes)[number];

const EXT_BY_MIME: Record<LogoMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Strict filename pattern for locally stored logos (UUID + extension). */
export const LOCAL_LOGO_FILENAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

/** Detect the image type from magic bytes; null when unrecognized. */
export function detectImageMime(bytes: Buffer): LogoMime | null {
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

/** Full decode + normalize + re-encode; throws PublicFirmError on failure. */
async function normalizeLogo(bytes: Buffer, mime: LogoMime): Promise<Buffer> {
  try {
    let pipeline = sharp(bytes, { failOn: "error", animated: false }).rotate(); // auto-orient via EXIF, then strip it
    const maxDim = FIRM_LOGO_POLICY.maxDimension;
    pipeline = pipeline.resize({
      width: maxDim,
      height: maxDim,
      fit: "inside",
      withoutEnlargement: true,
    });
    if (mime === "image/png") {
      return await pipeline.png({ compressionLevel: 9 }).toBuffer();
    }
    if (mime === "image/jpeg") {
      return await pipeline.jpeg({ quality: 86 }).toBuffer();
    }
    return await pipeline.webp({ quality: 86 }).toBuffer();
  } catch {
    throw new PublicFirmError("The logo file could not be read as a valid image.", "logo_invalid");
  }
}

/**
 * Validate + normalize + persist a firm logo. Returns the public URL of the
 * stored asset. Throws PublicFirmError (safe message) for rejected uploads
 * and SystemFirmError for infrastructure failures.
 */
export async function storeFirmLogo(rawBytes: Buffer): Promise<string> {
  if (rawBytes.length === 0) {
    throw new PublicFirmError("The logo file is empty.", "logo_empty");
  }
  if (rawBytes.length > FIRM_LOGO_POLICY.maxBytes) {
    throw new PublicFirmError("Firm logo must be at most 2 MB.", "logo_too_large");
  }
  const mime = detectImageMime(rawBytes);
  if (!mime) {
    throw new PublicFirmError("Firm logo must be a PNG, JPG, JPEG or WebP image.", "logo_unsupported");
  }

  const normalized = await normalizeLogo(rawBytes, mime);
  if (normalized.length > FIRM_LOGO_POLICY.maxBytes) {
    throw new PublicFirmError("Firm logo must be at most 2 MB after processing.", "logo_too_large");
  }

  const ext = EXT_BY_MIME[mime];
  const filename = `${randomUUID()}.${ext}`;
  const env = getServerEnv();

  if (env.FIRM_LOGO_STORAGE_MODE === "supabase") {
    const storage = getSupabaseServiceClient().storage.from(FIRM_LOGO_BUCKET);
    const { error } = await storage.upload(filename, normalized, {
      contentType: mime,
      upsert: false,
      cacheControl: "31536000",
    });
    if (error) {
      throw new SystemFirmError(`firm logo upload failed (${error.statusCode ?? ""})`);
    }
    const { data } = storage.getPublicUrl(filename);
    logFirmEvent("firm_logo_stored", { mode: "supabase", bytes: normalized.length, mime });
    return data.publicUrl;
  }

  // Local development adapter (verification harness / offline staging).
  const dir = path.resolve(process.cwd(), FIRM_LOGO_LOCAL_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), normalized);
  logFirmEvent("firm_logo_stored", { mode: "local", bytes: normalized.length, mime });
  return `${FIRM_LOGO_PUBLIC_PREFIX}/${filename}`;
}

/** Resolve a local-mode logo filename to an absolute path (or null when the
 *  name does not match the strict pattern — path traversal impossible). */
export function localFirmLogoPath(filename: string): string | null {
  if (!LOCAL_LOGO_FILENAME_PATTERN.test(filename)) return null;
  return path.resolve(process.cwd(), FIRM_LOGO_LOCAL_DIR, filename);
}

/** Content type for a local-mode logo extension (whitelist only). */
export function localLogoContentType(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? null;
}
