import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";

import { localFirmLogoPath, localLogoContentType } from "@/lib/firms/storage";

/**
 * Local-development firm-logo serving (FIRM_LOGO_STORAGE_MODE=local only).
 *
 * Production serves logos straight from public Supabase Storage URLs; this
 * route exists so the verification harness (which has no Storage API) can
 * exercise the exact same upload/display flow locally.
 *
 * SECURITY
 *   * The path is validated against a strict UUID+extension pattern — no
 *     user-controlled characters, path traversal is impossible.
 *   * Content-Type is derived from the whitelisted extension only.
 *   * Only filenames that already passed the magic-byte + sharp hardening in
 *     src/lib/firms/storage.ts can exist in the directory.
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const segments = (await params).path ?? [];

  // Exactly /uploads/firm-logos/<filename> — nothing else is served.
  if (segments.length !== 2 || segments[0] !== "firm-logos") {
    return new NextResponse("Not Found", { status: 404 });
  }

  const filename = segments[1];
  const filePath = localFirmLogoPath(filename);
  if (!filePath) {
    return new NextResponse("Not Found", { status: 404 });
  }
  const contentType = localLogoContentType(filename);
  if (!contentType) {
    return new NextResponse("Not Found", { status: 404 });
  }

  try {
    const bytes = await readFile(filePath);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new NextResponse("Not Found", { status: 404 });
  }
}
