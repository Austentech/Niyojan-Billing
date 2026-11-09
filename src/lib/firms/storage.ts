import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getServerEnv } from "@/lib/config/env";
import { getSupabaseServiceClient } from "@/lib/auth/server/db";
import { FIRM_LOGO_BUCKET, FIRM_LOGO_LOCAL_DIR, FIRM_LOGO_POLICY, FIRM_LOGO_PUBLIC_PREFIX } from "@/lib/constants";
import {
  detectImageMime as codecDetectImageMime,
  extensionForMime,
  mimeForExtension,
  normalizeImage,
  type ImageMime,
} from "@/lib/storage/image-codec";
import { PublicFirmError, SystemFirmError, logFirmEvent } from "@/lib/firms/errors";

/**
 * Firm logo storage — hardening applied BEFORE any byte is persisted:
 *
 *   1. Size limit (2 MB) checked on the actual buffer.
 *   2. Content type determined by MAGIC BYTES, never by the client-supplied
 *      filename or Content-Type header (a .png-named text file is rejected).
 *   3. The image is fully re-encoded (shared codec in
 *      src/lib/storage/image-codec.ts): proves it decodes, strips EXIF,
 *      caps dimensions (512 px box, no upscaling), removes trailing junk.
 *   4. The stored filename is a server-generated UUID + whitelisted
 *      extension — no user-controlled characters ever reach a path.
 *
 * STORAGE ADAPTERS
 *   * "supabase" (default, production) — dedicated `firm-logos` bucket via
 *     the service-role client; public URLs from Supabase Storage.
 *   * "local" (development/harness) — files under .data/firm-logos, served
 *     only through the sanitized /uploads/[...path] route handler.
 */

/** Kept for backwards compatibility with existing imports. */
export type LogoMime = ImageMime;

/** Strict filename pattern for locally stored logos (UUID + extension). */
export const LOCAL_LOGO_FILENAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;

export function detectImageMime(bytes: Buffer): ImageMime | null {
  return codecDetectImageMime(bytes);
}

/** Content type for a local-mode logo extension (whitelist only). */
export function localLogoContentType(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return mimeForExtension(ext);
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

  let normalized: Buffer;
  try {
    normalized = await normalizeImage(rawBytes, mime, FIRM_LOGO_POLICY.maxDimension);
  } catch {
    throw new PublicFirmError("The logo file could not be read as a valid image.", "logo_invalid");
  }
  if (normalized.length > FIRM_LOGO_POLICY.maxBytes) {
    throw new PublicFirmError("Firm logo must be at most 2 MB after processing.", "logo_too_large");
  }

  const ext = extensionForMime(mime);
  const filename = `${randomUUID()}.${ext}`;
  const env = getServerEnv();

  if (env.LOGO_STORAGE_MODE === "supabase") {
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
