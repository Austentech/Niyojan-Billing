import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";

import { localFirmLogoPath, localLogoContentType } from "@/lib/firms/storage";
import { localCorporationLogoPath, localCorporationLogoContentType } from "@/lib/account/storage";

/**
 * Local-development logo serving (LOGO_STORAGE_MODE=local only).
 *
 * Production serves logos straight from public Supabase Storage URLs; this
 * route exists so the verification harness (which has no Storage API) can
 * exercise the exact same upload/display flow locally for BOTH firm logos
 * and the corporation logo.
 *
 * SECURITY
 *   * The path is validated against strict UUID+extension patterns — no
 *     user-controlled characters, path traversal is impossible.
 *   * Content-Type is derived from the whitelisted extension only.
 *   * Only filenames that already passed the magic-byte + sharp hardening
 *     in the storage modules can exist in the directories.
 */

interface LocalLogoArea {
  prefix: string;
  resolve: (filename: string) => string | null;
  contentType: (filename: string) => string | null;
}

const LOCAL_LOGO_AREAS: LocalLogoArea[] = [
  {
    prefix: "firm-logos",
    resolve: localFirmLogoPath,
    contentType: localLogoContentType,
  },
  {
    prefix: "corporation-logos",
    resolve: localCorporationLogoPath,
    contentType: localCorporationLogoContentType,
  },
];

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const segments = (await params).path ?? [];

  // Exactly /uploads/<area>/<filename> — nothing else is served.
  if (segments.length !== 2) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const area = LOCAL_LOGO_AREAS.find((candidate) => candidate.prefix === segments[0]);
  if (!area) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const filename = segments[1];
  const filePath = area.resolve(filename);
  if (!filePath) {
    return new NextResponse("Not Found", { status: 404 });
  }
  const contentType = area.contentType(filename);
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
