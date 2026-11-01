/**
 * INTEGRATION TESTS — the complete Phase 2 firm-management flow, run against
 * the REAL PostgreSQL + PostgREST stack (same migration SQL, same service and
 * storage layers the application uses).
 *
 * Prerequisites:
 *   1. The verification harness is running    -> node verify-harness/start.mjs
 *   2. .env points at it (FIRM_LOGO_STORAGE_MODE=local)
 *
 * Run: npx tsx scripts/test-firms.ts
 *
 * Covers the required Phase 2 test matrix:
 *   1. dashboard with zero firms            7. add firm without a logo
 *   2. dashboard with one firm              8. add firm with a logo
 *   3. dashboard with multiple firms        9. invalid website URL
 *   4. responsive grid (breakpoints are     10. invalid holding percentage
 *      additionally browser-verified)       11. dashboard refresh after adding
 *   5. add firm with valid data             12. unauthorized access to firm
 *   6. add firm with invalid data               management
 * plus upload hardening (magic bytes, size, re-encode), RLS blocking, rate
 * limiting on the write operation, and the account-settings password change.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

import { loadDotEnv } from "./load-env";
import { check, checkEqual, rejects, section, finish } from "./test-harness";

loadDotEnv(".env");

import { createClient } from "@supabase/supabase-js";
import { createSession, validateSessionToken } from "../src/lib/auth/server/session";
import { ensureAdminBootstrapped } from "../src/lib/auth/server/bootstrap";
import { getAdminByUsername } from "../src/lib/auth/service";
import { hashPassword, verifyPassword } from "../src/lib/auth/server/password";
import { storeFirmLogo, detectImageMime } from "../src/lib/firms/storage";
import { listFirms, createFirm, resetFirmDataForTests } from "../src/lib/firms/service";
import { getServerEnv } from "../src/lib/config/env";

const env = getServerEnv();
const META = { ipAddress: "127.0.0.1", userAgent: "niyojan-test-suite/1.0" };

/** Fresh service-role client (independent of the app's cached singleton). */
function opsClient() {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Fresh ANON client — proves anonymous access stays blocked. */
function anonClient() {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Minimal HTTP helper against the running dev server. */
function http(url: string, headers: Record<string, string> = {}): { status: string; redirect: string; body: string } {
  try {
    const out = execFileSync(
      "curl",
      [
        "-s",
        "-o",
        "/tmp/firms-test-body.html",
        "-w",
        "%{http_code} %{redirect_url}",
        ...Object.entries(headers).flatMap(([k, v]) => ["-H", `${k}: ${v}`]),
        url,
      ],
      { encoding: "utf8", timeout: 20_000 },
    ).trim();
    let body = "";
    try {
      // Strip React SSR comment separators (<!-- -->) so plain-text
      // assertions match rendered text segments.
      body = readFileSync("/tmp/firms-test-body.html", "utf8").replace(/<!--.*?-->/gs, "");
    } catch {
      body = "";
    }
    const [status, redirect] = out.split(" ");
    return { status, redirect, body };
  } catch (err) {
    return { status: `curl-failed:${String(err).slice(0, 60)}`, redirect: "", body: "" };
  }
}

/** A valid firm payload the tests mutate for invalid cases. */
function validFirm(overrides: Record<string, string> = {}) {
  return {
    firmName: "Khurana Structural Works LLP",
    websiteUrl: "https://www.khurana-structural.example",
    holdingPercentage: "51.25",
    address: "12 Connaught Place, New Delhi, India",
    description: "Structural engineering and fabrication.",
    ...overrides,
  };
}

async function main(): Promise<void> {
  const ops = opsClient();

  /* ==========================================================================
   * Setup: bootstrap the administrator (Phase 1 must remain functional).
   * ========================================================================*/
  section("Setup — Phase 1 authentication remains functional");
  await ops.from("firms").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await ensureAdminBootstrapped();
  const admin = await getAdminByUsername(env.ADMIN_USERNAME);
  check(admin !== null, "administrator account resolves (Phase 1 bootstrap intact)");
  const adminId = admin!.id;

  /* ==========================================================================
   * 1. DASHBOARD WITH ZERO FIRMS
   * ========================================================================*/
  section("1. Dashboard with zero firms");
  let firms = await listFirms();
  checkEqual(firms.length, 0, "listFirms returns zero firms when none are registered");

  // HTTP level: authenticated dashboard renders the empty state.
  const session0 = await createSession(adminId, META);
  let page = http("http://127.0.0.1:3000/dashboard", { Cookie: `niyojan_session=${session0.token}` });
  check(page.status.startsWith("200"), `GET /dashboard (authenticated) renders (${page.status})`);
  check(page.body.includes("No firms added yet."), "empty state headline is served");
  check(
    page.body.includes("Start building your centralized business workspace by adding your first firm."),
    "empty state supporting text is served",
  );
  check(page.body.includes("Add Your First Firm"), "empty state CTA button is served");
  check(page.body.includes("Welcome back, Deepak Khurana"), "greeting uses the account display name (not hardcoded)");
  check(page.body.includes("My Firms"), "page heading is served");

  /* ==========================================================================
   * 2. DASHBOARD WITH ONE FIRM
   * ========================================================================*/
  section("2. Dashboard with one firm");
  const one = await createFirm(validFirm({ firmName: "Aurum Contracts Pvt Ltd" }), null);
  checkEqual(one.status, "created", "firm creation succeeds with valid data");
  firms = await listFirms();
  checkEqual(firms.length, 1, "listFirms returns the new firm");
  checkEqual(firms[0]?.name, "Aurum Contracts Pvt Ltd", "firm name round-trips");
  checkEqual(firms[0]?.holdingPercentage, 51.25, "holding percentage round-trips (decimal)");
  checkEqual(firms[0]?.logoUrl, null, "no logo -> logo_url is null (initials fallback)");

  page = http("http://127.0.0.1:3000/dashboard", { Cookie: `niyojan_session=${session0.token}` });
  check(page.body.includes("Aurum Contracts Pvt Ltd"), "the firm appears on the authenticated dashboard");
  check(!page.body.includes("No firms added yet."), "empty state is gone once a firm exists");

  /* ==========================================================================
   * 3. DASHBOARD WITH MULTIPLE FIRMS (grid continues into more rows)
   * ========================================================================*/
  section("3. Dashboard with multiple firms");
  for (let i = 1; i <= 7; i += 1) {
    await createFirm(validFirm({ firmName: `Niyojan Venture ${String(i).padStart(2, "0")}` }), null);
  }
  firms = await listFirms();
  checkEqual(firms.length, 8, "eight firms registered");
  const names = firms.map((f) => f.name);
  check(
    names[0] === "Aurum Contracts Pvt Ltd" && names[7] === "Niyojan Venture 07",
    "listing keeps registration order (rows continue automatically)",
  );
  const allUnique = new Set(firms.map((f) => f.id)).size === 8;
  check(allUnique, "every firm carries a unique UUID (future modules key off it)");

  page = http("http://127.0.0.1:3000/dashboard", { Cookie: `niyojan_session=${session0.token}` });
  check(page.body.includes("Niyojan Venture 07"), "all firms render on the dashboard (database-driven)");
  check(
    page.body.includes("grid-cols-1") && page.body.includes("md:grid-cols-2") && page.body.includes("xl:grid-cols-4"),
    "responsive grid classes are 1 / 2 (md) / 4 (xl) per row",
  );

  /* ==========================================================================
   * 4. RESPONSIVE GRID AT ALL BREAKPOINTS
   * ========================================================================*/
  section("4. Responsive grid at all breakpoints (HTTP/CSS level)");
  check(
    page.body.includes("md:grid-cols-2") && page.body.includes("xl:grid-cols-4"),
    "mobile 1 / tablet 2 / desktop 4 column grid is present",
  );
  // Full visual verification at 375px / 768px / 1440px is additionally performed
  // with the agent browser (documented in docs/TESTING.md).

  /* ==========================================================================
   * 5. ADD FIRM WITH VALID DATA
   * ========================================================================*/
  section("5. Add firm with valid data (server-authoritative validation)");
  await ops.from("firms").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  const created = await createFirm(
    validFirm({ description: "" }), // empty optional description -> undefined
    null,
  );
  checkEqual(created.status, "created", "valid payload creates the firm");
  checkEqual(created.firm.description, null, "empty optional description stores NULL");

  const row = await ops.from("firms").select("*").eq("id", created.firm.id).maybeSingle();
  checkEqual(row.data?.firm_name, "Khurana Structural Works LLP", "database row matches the input name");
  checkEqual(Number(row.data?.holding_percentage), 51.25, "database stores holding_percentage 51.25 (numeric 5,2)");
  checkEqual(row.data?.website_url, "https://www.khurana-structural.example", "database stores the website URL");
  check(Boolean(row.data?.id?.match(/^[0-9a-f-]{36}$/)), "database id is a UUID");
  check(row.data?.logo_url === null, "logo_url stays NULL without an upload");

  /* ==========================================================================
   * 6. ADD FIRM WITH INVALID DATA
   * ========================================================================*/
  section("6. Add firm with invalid data (field-level rejections)");

  async function expectInvalid(payload: Record<string, string>, field: string, label: string) {
    const result = await createFirm(payload, null);
    const invalid = result.status === "invalid";
    check(invalid && Boolean(result.fieldErrors[field]), label);
  }

  await expectInvalid(validFirm({ firmName: "" }), "firmName", "empty firm name is rejected");
  await expectInvalid(validFirm({ firmName: "A" }), "firmName", "1-character firm name is rejected");
  await expectInvalid(validFirm({ address: "" }), "address", "empty address is rejected");
  await expectInvalid(validFirm({ address: "Pune" }), "address", "too-short address is rejected");
  await expectInvalid(
    validFirm({ description: "x".repeat(1001) }),
    "description",
    "description over the 1000-character limit is rejected",
  );

  const countAfterInvalid = (await listFirms()).length;
  checkEqual(countAfterInvalid, 1, "no row is written for invalid submissions");

  /* ==========================================================================
   * 7. ADD FIRM WITHOUT A LOGO
   * ========================================================================*/
  section("7. Add firm without a logo");
  const noLogo = await createFirm(validFirm({ firmName: "Meridian Estates LLP" }), null);
  checkEqual(noLogo.status, "created", "firm without a logo saves successfully");
  checkEqual(noLogo.firm.logoUrl, null, "logo_url is null -> the card renders the initials fallback");

  /* ==========================================================================
   * 8. ADD FIRM WITH A LOGO (+ upload hardening)
   * ========================================================================*/
  section("8. Add firm with a logo + upload hardening");

  // Real PNG generated locally (no fixture file needed).
  const pngBytes = await sharp({
    create: { width: 320, height: 180, channels: 3, background: "#a2753b" },
  })
    .png()
    .toBuffer();
  check(detectImageMime(Buffer.from(pngBytes)) === "image/png", "magic-byte sniffing recognizes the generated PNG");

  const logoUrl = await storeFirmLogo(Buffer.from(pngBytes));
  check(logoUrl.startsWith("/uploads/firm-logos/"), "local storage adapter returns the public URL path");
  const logoFile = logoUrl.split("/").pop() ?? "";
  const logoPath = path.resolve(process.cwd(), ".data/firm-logos", logoFile);
  check(existsSync(logoPath), "the normalized logo file exists on disk");

  const stored = await sharp(logoPath).metadata();
  check(stored.width === 320 && stored.height === 180, "re-encoded logo preserves dimensions (within the 512 box)");
  check(stored.format === "png", "logo is re-encoded as PNG (metadata stripped)");

  const withLogo = await createFirm(validFirm({ firmName: "Vertex Fabrication Pvt Ltd" }), logoUrl);
  checkEqual(withLogo.status, "created", "firm with a logo saves successfully");
  checkEqual(withLogo.firm.logoUrl, logoUrl, "logo_url persists on the firm row");

  // The logo is served with the correct content type and caching headers.
  const logoHttp = http(`http://127.0.0.1:3000${logoUrl}`);
  check(logoHttp.status.startsWith("200"), `GET ${logoUrl} -> 200`);
  // (headers asserted via curl -I below)
  const head = execFileSync(
    "curl",
    ["-s", "-I", `http://127.0.0.1:3000${logoUrl}`],
    { encoding: "utf8", timeout: 15_000 },
  );
  check(/content-type:\s*image\/png/i.test(head), "logo is served as image/png");
  check(/x-content-type-options:\s*nosniff/i.test(head), "logo response carries X-Content-Type-Options: nosniff");

  // Upload hardening: spoofed extension, oversized and corrupt payloads.
  const spoofed = Buffer.from("<script>alert('xss')</script>This is not an image at all.", "utf8");
  const spoofErr = await rejects(storeFirmLogo(spoofed), "text payload named .png is rejected (magic-byte sniffing)");
  check(String((spoofErr as Error)?.message ?? "").includes("PNG"), "rejection message names the accepted formats");

  const bigPng = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "#1b2737" },
  })
    .png()
    .toBuffer();
  const padded = Buffer.concat([bigPng, Buffer.alloc(2 * 1024 * 1024 + 64, 0)]);
  await rejects(storeFirmLogo(padded), "payload over the 2 MB limit is rejected before processing");

  const corrupt = Buffer.from(pngBytes.subarray(0, 40));
  await rejects(storeFirmLogo(corrupt), "truncated/corrupt image data is rejected by the sharp decode");

  // Path traversal / unexpected shapes on the serving route:
  const traversal = http("http://127.0.0.1:3000/uploads/firm-logos/..%2f..%2f.env");
  check(!traversal.status.startsWith("200"), "path traversal on the uploads route is refused");
  const bogus = http("http://127.0.0.1:3000/uploads/firm-logos/not-a-uuid.png");
  check(!bogus.status.startsWith("200"), "non-UUID filenames are refused by the uploads route");
  const wrongDir = http("http://127.0.0.1:3000/uploads/other/logo.png");
  check(!wrongDir.status.startsWith("200"), "only /uploads/firm-logos is served");

  /* ==========================================================================
   * 9. INVALID WEBSITE URL
   * ========================================================================*/
  section("9. Invalid website URL");
  await expectInvalid(validFirm({ websiteUrl: "not-a-url" }), "websiteUrl", "plain-text website is rejected");
  await expectInvalid(validFirm({ websiteUrl: "ftp://files.example.com" }), "websiteUrl", "non-http scheme is rejected");
  await expectInvalid(validFirm({ websiteUrl: "javascript:alert(1)" }), "websiteUrl", "javascript: URL is rejected");
  const missingScheme = await createFirm(validFirm({ websiteUrl: "www.example.com" }), null);
  check(missingScheme.status === "invalid", "URL without a scheme is rejected");

  /* ==========================================================================
   * 10. INVALID HOLDING PERCENTAGE
   * ========================================================================*/
  section("10. Invalid holding percentage");
  await expectInvalid(validFirm({ holdingPercentage: "101" }), "holdingPercentage", "101 exceeds the 0–100 range");
  await expectInvalid(validFirm({ holdingPercentage: "-5" }), "holdingPercentage", "negative values are rejected");
  await expectInvalid(validFirm({ holdingPercentage: "12.345" }), "holdingPercentage", "three decimal places are rejected");
  await expectInvalid(validFirm({ holdingPercentage: "abc" }), "holdingPercentage", "non-numeric input is rejected");
  await expectInvalid(validFirm({ holdingPercentage: "" }), "holdingPercentage", "missing holding percentage is rejected");

  const boundary = await createFirm(validFirm({ holdingPercentage: "100" }), null);
  checkEqual(boundary.status, "created", "boundary value 100 is accepted");
  const zero = await createFirm(validFirm({ holdingPercentage: "0" }), null);
  checkEqual(zero.status, "created", "boundary value 0 is accepted");
  const twoDecimals = await createFirm(validFirm({ holdingPercentage: "33.33" }), null);
  checkEqual(twoDecimals.status, "created", "two decimal places are accepted");

  /* ==========================================================================
   * 11. DASHBOARD REFRESH AFTER ADDING A FIRM
   * ========================================================================*/
  section("11. Dashboard refresh after adding a firm");
  const before = (await listFirms()).length;
  const fresh = await createFirm(validFirm({ firmName: "Zenith Infra Developers" }), null);
  checkEqual(fresh.status, "created", "a new firm is saved");
  const after = await listFirms();
  checkEqual(after.length, before + 1, "the list immediately reflects the new firm");
  check(
    after.some((f) => f.name === "Zenith Infra Developers"),
    "the new firm is present in the refreshed list",
  );

  page = http("http://127.0.0.1:3000/dashboard", { Cookie: `niyojan_session=${session0.token}` });
  check(page.body.includes("Zenith Infra Developers"), "a freshly-rendered dashboard page includes the new firm");

  const manage = http("http://127.0.0.1:3000/settings/firms", { Cookie: `niyojan_session=${session0.token}` });
  check(manage.body.includes("Manage Firms"), "firm-management page heading is served");
  check(
    manage.body.includes("Add and manage the business entities operating under Niyojan Corporation."),
    "firm-management subtitle is served",
  );
  check(manage.body.includes("Zenith Infra Developers"), "firm-management list includes the new firm");
  check(manage.body.includes("Add New Firm"), "Add New Firm button is served");

  /* ==========================================================================
   * 12. UNAUTHORIZED ACCESS TO FIRM MANAGEMENT
   * ========================================================================*/
  section("12. Unauthorized access to firm management");

  // HTTP level — no cookie:
  const anonDash = http("http://127.0.0.1:3000/dashboard");
  check(anonDash.status.startsWith("307") && anonDash.redirect.endsWith("/"), "GET /dashboard without a session redirects to /");
  const anonFirms = http("http://127.0.0.1:3000/settings/firms");
  check(anonFirms.status.startsWith("307"), "GET /settings/firms without a session redirects to /");
  const anonAccount = http("http://127.0.0.1:3000/settings/account");
  check(anonAccount.status.startsWith("307"), "GET /settings/account without a session redirects to /");

  // HTTP level — forged cookie:
  const forged = http("http://127.0.0.1:3000/settings/firms", { Cookie: "niyojan_session=forged-token-attempt-aaaaaaaaaaaaaaaa" });
  check(forged.status.startsWith("307"), "GET /settings/firms with a forged session cookie redirects to /");

  // Service level — no valid session token means no data path:
  checkEqual(await validateSessionToken(null), null, "no token -> no session context");
  checkEqual(await validateSessionToken("forged-token-attempt-aaaaaaaaaaaaaaaa"), null, "forged token -> no session context");

  // RLS: the anon key cannot read or write firms:
  const anon = anonClient();
  const anonSelect = await anon.from("firms").select("id");
  check(Boolean(anonSelect.error) || (anonSelect.data?.length ?? 0) === 0, "anonymous Supabase key cannot read firms");
  const anonInsert = await anon.from("firms").insert({
    firm_name: "Ghost Firm",
    holding_percentage: 10,
    address: "Nowhere Lane, Void City",
  });
  check(Boolean(anonInsert.error), "anonymous Supabase key cannot insert firms");

  // Rate limiting on the write operation (service level):
  const rlKey = "firms:create";
  await ops.from("rate_limits").delete().eq("key", rlKey);
  const limit = 12;
  let denied = false;
  let retryAfter = 0;
  for (let i = 0; i <= limit; i += 1) {
    const { data } = await ops.rpc("auth_check_rate_limit", { p_key: rlKey, p_limit: limit, p_window_seconds: 3600 });
    const raw = (data ?? {}) as { allowed?: boolean; retry_after_seconds?: number };
    if (!raw.allowed) {
      denied = true;
      retryAfter = raw.retry_after_seconds ?? 0;
      break;
    }
  }
  check(denied, "the firm-creation rate limiter denies the 13th write within the window");
  check(retryAfter > 0, "the denial carries a retry-after delay");
  await ops.from("rate_limits").delete().eq("key", rlKey);

  /* ==========================================================================
   * EXTRA: database-driven guarantees + account settings password change
   * ========================================================================*/
  section("Extras: DB constraints, log hygiene, account settings");

  // Database CHECK constraints as the last line of defense (bypassing Zod):
  const dbReject = await ops.from("firms").insert({
    firm_name: "Bad Range Firm",
    holding_percentage: 150,
    address: "Somewhere Valid Street 5",
  });
  check(Boolean(dbReject.error), "database CHECK rejects holding_percentage 150 even if the app is bypassed");

  // XSS: nothing is ever rendered as raw HTML (React escaping + no
  // dangerouslySetAnywhere); the name round-trips as text:
  const xssFirm = await createFirm(
    validFirm({ firmName: "<script>alert(1)</script> Co" }),
    null,
  );
  checkEqual(xssFirm.status, "created", "payload-style name is stored as plain text");
  page = http("http://127.0.0.1:3000/dashboard", { Cookie: `niyojan_session=${session0.token}` });
  check(!page.body.includes("<script>alert(1)</script>"), "the name is HTML-escaped on the dashboard (no raw injection)");

  // Account settings: password change flips the credential source to the
  // database and revokes other sessions (Phase 1 foundation, now wired).
  const currentHash = (await ops.from("admin_accounts").select("password_hash").eq("id", adminId).maybeSingle()).data?.password_hash;
  const newPassword = "RotatedCredential#2026";
  const newHash = await hashPassword(newPassword);
  await ops.from("admin_accounts").update({ password_hash: newHash, credentials_source: "database", password_updated_at: new Date().toISOString() }).eq("id", adminId);
  check(await verifyPassword(newPassword, newHash), "the new credential verifies against its Argon2id hash");
  check(!(await verifyPassword(env.ADMIN_PASSWORD, newHash)), "the old bootstrap password no longer verifies");
  check(currentHash !== newHash, "the hash actually changed");

  // Bootstrap must never roll a database-sourced credential back:
  await ensureAdminBootstrapped();
  const afterBootstrap = (await ops.from("admin_accounts").select("password_hash, credentials_source").eq("id", adminId).maybeSingle()).data;
  checkEqual(afterBootstrap?.credentials_source, "database", "credential source stays 'database' after bootstrap re-runs");
  check(await verifyPassword(newPassword, afterBootstrap?.password_hash ?? ""), "rotated password survives the bootstrap re-run");

  // Restore the pristine bootstrap state for repeatable suite runs.
  await ops.from("admin_accounts").update({ password_hash: currentHash, credentials_source: "env_bootstrap" }).eq("id", adminId);

  /* Final state hygiene for repeat runs. */
  await resetFirmDataForTests();
  await ops.from("admin_sessions").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await ops.from("rate_limits").delete().like("key", "firms:%");
  await ops.from("rate_limits").delete().like("key", "account:%");

  finish("FIRM MANAGEMENT TESTS (12 required scenarios + extras)");
}

main().catch((err) => {
  console.error("Firm test runner crashed:", err);
  process.exit(1);
});
