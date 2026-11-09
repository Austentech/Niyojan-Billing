import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getServerEnv } from "@/lib/config/env";
import { getSupabaseServiceClient } from "@/lib/auth/server/db";
import {
  CORPORATION_LOGO_BUCKET,
  CORPORATION_LOGO_LOCAL_DIR,
  CORPORATION_LOGO_POLICY,
  CORPORATION_LOGO_PUBLIC_PREFIX,
} from "@/lib/constants";
import {
  detectImageMime,
  extensionForMime,
  mimeForExtension,
  normalizeImage,
} from "@/lib/storage/image-codec";
import { PublicAccountError, SystemAccountError, logAccountEvent } from "@/lib/account/errors";

/**
 * Corporation logo storage — the SAME hardening pipeline as firm logos
 * (shared codec in src/lib/storage/image-codec.ts), applied BEFORE any byte
 * is persisted:
 *
 *   1. Size limit (2 MB) checked on the actual buffer.
 *   2. Content type determined by MAGIC BYTES, never by the client-supplied
 *      filename or Content-Type header.
 *   3. Full sharp re-encode: proves decodability, strips EXIF/metadata, caps
 *      dimensions (512 px box, no upscaling), removes trailing junk —
 *      neutralizing polyglot payloads.
 *   4. Server-generated UUID + whitelisted extension filenames — no
 *      user-controlled characters ever reach a path.
 *
 * STORAGE ADAPTERS (LOGO_STORAGE_MODE)
 *   * "supabase" (default, production) — dedicated `corporation-logos`
 *     bucket via the service-role client; public URLs from Supabase Storage.
 *   * "local" (development/harness) — files under .data/corporation-logos,
 *     served only through the sanitized /uploads/[...path] route handler.
 */

/** Strict filename pattern for locally stored logos (UUID + extension). */
export const LOCAL_CORPORATION_LOGO_FILENAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/;

/** Content type for a local-mode corporation logo extension (whitelist only). */
export function localCorporationLogoContentType(filename: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return mimeForExtension(ext);
}

/**
 * Validate + normalize + persist the corporation logo. Returns the public
 * URL of the stored asset. Throws PublicAccountError (safe message) for
 * rejected uploads and SystemAccountError for infrastructure failures.
 */
export async function storeCorporationLogo(rawBytes: Buffer): Promise<string> {
  if (rawBytes.length === 0) {
    throw new PublicAccountError("The logo file is empty.", "logo_empty");
  }
  if (rawBytes.length > CORPORATION_LOGO_POLICY.maxBytes) {
    throw new PublicAccountError("Corporation logo must be at most 2 MB.", "logo_too_large");
  }
  const mime = detectImageMime(rawBytes);
  if (!mime) {
    throw new PublicAccountError("Corporation logo must be a PNG, JPG, JPEG or WebP image.", "logo_unsupported");
  }

  let normalized: Buffer;
  try {
    normalized = await normalizeImage(rawBytes, mime, CORPORATION_LOGO_POLICY.maxDimension);
  } catch {
    throw new PublicAccountError("The logo file could not be read as a valid image.", "logo_invalid");
  }
  if (normalized.length > CORPORATION_LOGO_POLICY.maxBytes) {
    throw new PublicAccountError("Corporation logo must be at most 2 MB after processing.", "logo_too_large");
  }

  const ext = extensionForMime(mime);
  const filename = `${randomUUID()}.${ext}`;
  const env = getServerEnv();

  if (env.LOGO_STORAGE_MODE === "supabase") {
    const storage = getSupabaseServiceClient().storage.from(CORPORATION_LOGO_BUCKET);
    const { error } = await storage.upload(filename, normalized, {
      contentType: mime,
      upsert: false,
      cacheControl: "31536000",
    });
    if (error) {
      throw new SystemAccountError(`corporation logo upload failed (${error.statusCode ?? ""})`);
    }
    const { data } = storage.getPublicUrl(filename);
    logAccountEvent("corporation_logo_stored", { mode: "supabase", bytes: normalized.length, mime });
    return data.publicUrl;
  }

  // Local development adapter (verification harness / offline staging).
  const dir = path.resolve(process.cwd(), CORPORATION_LOGO_LOCAL_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), normalized);
  logAccountEvent("corporation_logo_stored", { mode: "local", bytes: normalized.length, mime });
  return `${CORPORATION_LOGO_PUBLIC_PREFIX}/${filename}`;
}

/** Resolve a local-mode corporation logo filename to an absolute path (or
 *  null when the name does not match the strict pattern — path traversal
 *  impossible). */
export function localCorporationLogoPath(filename: string): string | null {
  if (!LOCAL_CORPORATION_LOGO_FILENAME_PATTERN.test(filename)) return null;
  return path.resolve(process.cwd(), CORPORATION_LOGO_LOCAL_DIR, filename);
}
