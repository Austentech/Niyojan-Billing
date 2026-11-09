/**
 * INTEGRATION TESTS — the complete Phase 3 Account Settings flow, run against
 * the REAL PostgreSQL + PostgREST stack (same migration SQL, same service and
 * storage layers the application uses).
 *
 * Prerequisites:
 *   1. The verification harness is running    -> node verify-harness/start.mjs
 *   2. .env points at it (LOGO_STORAGE_MODE=local, SMTP_DEV_CAPTURE=true)
 *
 * Run: npx tsx scripts/test-account.ts
 *
 * Covers the required Phase 3 test matrix:
 *   1. displaying account information       7. incorrect current password
 *   2. updating corporation name            8. password mismatch
 *   3. updating administrator name          9. weak password rejection
 *   4. administrator email change with     10. login with the new password
 *      verification                        11. login with the old password
 *   5. changing corporation logo           12. accurate last-login timestamp
 *   6. successful password update
 * plus email-change cooldown/expiry/attempts, logo hardening (magic bytes,
 * size, re-encode), corporation-profile separation from authentication,
 * RLS blocking, log hygiene, and full state restoration for repeat runs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

import { loadDotEnv } from "./load-env";
import { check, checkEqual, rejects, section, finish } from "./test-harness";

loadDotEnv(".env");

import { createClient } from "@supabase/supabase-js";
import { createSession, validateSessionToken } from "../src/lib/auth/server/session";
import { ensureAdminBootstrapped } from "../src/lib/auth/server/bootstrap";
import { getAdminByUsername, submitCredentials, verifyOtp, resetGlobalAuthStateForTests } from "../src/lib/auth/service";
import { hashPassword, verifyPassword } from "../src/lib/auth/server/password";
import { passwordChangeSchema, passwordChangeFormSchema } from "../src/lib/auth/validation";
import {
  getAccountOverview,
  getCorporationProfile,
  updateCorporationProfile,
  updateDisplayName,
  requestEmailChange,
  confirmEmailChange,
  resendEmailChangeCode,
  getPendingEmailChange,
  changeAdminPassword,
  resetAccountDataForTests,
} from "../src/lib/account/service";
import { storeCorporationLogo } from "../src/lib/account/storage";
import { PublicAccountError } from "../src/lib/account/errors";
import { getServerEnv } from "../src/lib/config/env";
import { BRAND } from "../src/lib/constants";

const env = getServerEnv();
const OUTBOX = path.resolve(process.cwd(), env.SMTP_DEV_OUTBOX);
const META = { ipAddress: "127.0.0.1", userAgent: "niyojan-test-suite/1.0" };
const NEW_EMAIL = "deepak.khurana@niyojan-verified.example";
const NEW_PASSWORD = "Rotated#Admin2026";

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
        "/tmp/account-test-body.html",
        "-w",
        "%{http_code} %{redirect_url}",
        ...Object.entries(headers).flatMap(([k, v]) => ["-H", `${k}: ${v}`]),
        url,
      ],
      { encoding: "utf8", timeout: 20_000 },
    ).trim();
    let body = "";
    try {
      body = readFileSync("/tmp/account-test-body.html", "utf8").replace(/<!--.*?-->/gs, "");
    } catch {
      body = "";
    }
    const [status, redirect] = out.split(" ");
    return { status, redirect, body };
  } catch (err) {
    return { status: `curl-failed:${String(err).slice(0, 60)}`, redirect: "", body: "" };
  }
}

/** Read the newest verification code emailed to a specific address. */
function readCodeFor(toEmail: string, subjectFragment: string): string | null {
  let files: string[] = [];
  try {
    files = readdirSync(OUTBOX).filter((f) => f.endsWith(".eml")).sort();
  } catch {
    return null;
  }
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const raw = readFileSync(path.join(OUTBOX, files[i]), "utf8");
    if (!raw.includes(`To: <${toEmail}>`)) continue;
    if (!raw.includes(subjectFragment)) continue;
    const match = raw.match(/letter-spacing:6px[^>]*>([A-HJ-NP-Z2-9]{8})</);
    return match ? match[1] : null;
  }
  return null;
}

/** Console capture: prove verification codes never reach the logs. */
function captureConsole<T>(fn: () => Promise<T>): Promise<{ value: T; output: string }> {
  const original = { log: console.log, info: console.info, error: console.error, warn: console.warn };
  let output = "";
  const intercept = (...args: unknown[]) => {
    output += args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n";
  };
  console.log = intercept as typeof console.log;
  console.info = intercept as typeof console.info;
  console.warn = intercept as typeof console.warn;
  console.error = intercept as typeof console.error;
  return fn().then(
    (value) => {
      Object.assign(console, original);
      return { value, output };
    },
    (err) => {
      Object.assign(console, original);
      throw err;
    },
  );
}

async function clearEmailChangeRateLimit(): Promise<void> {
  await opsClient().from("rate_limits").delete().eq("key", "account:email-change-request");
}

async function main(): Promise<void> {
  const ops = opsClient();

  /* ==========================================================================
   * Setup — reset account state; Phase 1 bootstrap must be intact.
   * ========================================================================*/
  section("Setup — clean account state, Phase 1 bootstrap intact");

  await resetGlobalAuthStateForTests();
  await resetAccountDataForTests();
  // Fully reset the administrator to the environment bootstrap credential —
  // a previously crashed run may have rotated it (cascades clear sessions,
  // challenges and email-change requests as well).
  await ops.from("admin_accounts").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await ensureAdminBootstrapped();

  const admin = await getAdminByUsername(env.ADMIN_USERNAME);
  check(admin !== null, "administrator account resolves (Phase 1 bootstrap intact)");
  const adminId = admin!.id;
  const baselineLastLogin = admin!.last_login_at;

  /* ==========================================================================
   * 1. DISPLAYING ACCOUNT INFORMATION
   * ========================================================================*/
  section("1. Displaying account information");

  const overview = await getAccountOverview(adminId);
  check(overview !== null, "account overview loads");
  checkEqual(overview!.admin.displayName, "Deepak Khurana", "administrator name comes from the account configuration");
  checkEqual(overview!.admin.email, env.ADMIN_EMAIL, "administrator email comes from the account configuration");
  checkEqual(overview!.admin.username, env.ADMIN_USERNAME, "username comes from the account configuration");
  checkEqual(overview!.admin.credentialsSource, "env_bootstrap", "credential source shown (env bootstrap)");
  checkEqual(overview!.corporation.corporationName, BRAND.name, "corporation profile seeds with the brand name");
  checkEqual(overview!.corporation.logoUrl, null, "no custom logo -> official brand asset is used");
  checkEqual(overview!.pendingEmailChange, null, "no pending email change initially");
  check(overview!.admin.lastLoginAt === baselineLastLogin, "last login mirrors the database value");

  const profileRow = await ops.from("corporation_profile").select("*").eq("id", "CORPORATION").maybeSingle();
  check(profileRow.data !== null, "corporation_profile row exists (separate table from authentication)");
  checkEqual(profileRow.data?.corporation_name, BRAND.name, "seeded corporation name stored in its own table");

  // HTTP level: the authenticated Account Settings page renders everything.
  const sessionPage = await createSession(adminId, META);
  let page = http("http://127.0.0.1:3000/settings/account", { Cookie: `niyojan_session=${sessionPage.token}` });
  check(page.status.startsWith("200"), `GET /settings/account (authenticated) renders (${page.status})`);
  check(page.body.includes("Account overview"), "account overview card is served");
  check(page.body.includes("Niyojan Corporation"), "corporation name is displayed");
  check(page.body.includes("Deepak Khurana"), "administrator name is displayed");
  check(page.body.includes(env.ADMIN_EMAIL), "administrator email is displayed");
  check(page.body.includes("Last successful login"), "last successful login field is displayed");
  check(page.body.includes(" UTC"), "timestamps carry a readable format (local swap happens client-side)");
  check(page.body.includes("Corporation profile"), "corporation profile section is displayed");
  check(page.body.includes("Change password"), "change password section is displayed");
  check(page.body.includes("/brand/logo-mark.png"), "official corporation logo is displayed (bundled asset)");

  const anonPage = http("http://127.0.0.1:3000/settings/account");
  check(anonPage.status.startsWith("307"), "GET /settings/account without a session redirects to /");

  /* ==========================================================================
   * 2. UPDATING CORPORATION NAME
   * ========================================================================*/
  section("2. Updating corporation name");

  const renamed = await updateCorporationProfile({ corporationName: "Niyojan Corporation Group" });
  checkEqual(renamed.status, "updated", "corporation name update succeeds");
  const renamedRow = await ops.from("corporation_profile").select("corporation_name").eq("id", "CORPORATION").maybeSingle();
  checkEqual(renamedRow.data?.corporation_name, "Niyojan Corporation Group", "database stores the new corporation name");
  const overviewRenamed = await getAccountOverview(adminId);
  checkEqual(overviewRenamed!.corporation.corporationName, "Niyojan Corporation Group", "overview reflects the new name immediately");

  page = http("http://127.0.0.1:3000/settings/account", { Cookie: `niyojan_session=${sessionPage.token}` });
  check(page.body.includes("Niyojan Corporation Group"), "the page renders the updated corporation name");

  for (const [badName, label] of [
    ["", "empty corporation name"],
    ["N", "1-character corporation name"],
    ["X".repeat(121), "over-length corporation name"],
  ] as const) {
    const bad = await updateCorporationProfile({ corporationName: badName });
    checkEqual(bad.status, "invalid", `${label} is rejected`);
    check(Boolean(bad.status === "invalid" && bad.fieldErrors.corporationName), `${label} carries a field error`);
  }
  const unchangedRow = await ops.from("corporation_profile").select("corporation_name").eq("id", "CORPORATION").maybeSingle();
  checkEqual(unchangedRow.data?.corporation_name, "Niyojan Corporation Group", "invalid submissions never touch the database");

  // Database CHECK constraint rejects a bad name even when the app is bypassed.
  const dbReject = await ops
    .from("corporation_profile")
    .update({ corporation_name: "X" })
    .eq("id", "CORPORATION");
  check(Boolean(dbReject.error), "database CHECK rejects a 1-character corporation name (app bypassed)");

  /* ==========================================================================
   * 3. UPDATING ADMINISTRATOR NAME
   * ========================================================================*/
  section("3. Updating administrator name");

  const renamedAdmin = await updateDisplayName({ adminId, displayName: "Deepak K. Khurana" });
  checkEqual(renamedAdmin.status, "updated", "administrator display name update succeeds");
  const adminRow = await ops.from("admin_accounts").select("display_name").eq("id", adminId).maybeSingle();
  checkEqual(adminRow.data?.display_name, "Deepak K. Khurana", "database stores the new display name");

  // Live sessions immediately carry the new display name (join re-read per request).
  const liveSession = await validateSessionToken(sessionPage.token);
  checkEqual(liveSession?.displayName, "Deepak K. Khurana", "active sessions reflect the new display name immediately");

  page = http("http://127.0.0.1:3000/dashboard", { Cookie: `niyojan_session=${sessionPage.token}` });
  check(page.body.includes("Deepak K. Khurana"), "the dashboard greeting uses the updated administrator name");

  const badName = await updateDisplayName({ adminId, displayName: "D" });
  checkEqual(badName.status, "invalid", "1-character administrator name is rejected");
  const missingAdmin = await updateDisplayName({ adminId: "00000000-0000-0000-0000-000000000000", displayName: "Nobody" });
  checkEqual(missingAdmin.status, "not_found", "unknown administrator is reported, not created");

  /* ==========================================================================
   * 4. UPDATING ADMINISTRATOR EMAIL WITH VERIFICATION
   * ========================================================================*/
  section("4. Updating administrator email with verification");

  await clearEmailChangeRateLimit();

  // Malformed / same-address requests are rejected before anything is sent.
  const malformed = await requestEmailChange({ adminId, newEmail: "not-an-email" });
  checkEqual(malformed.status, "invalid", "malformed new email is rejected");
  const sameAddress = await requestEmailChange({ adminId, newEmail: env.ADMIN_EMAIL });
  checkEqual(sameAddress.status, "invalid", "the current email cannot be re-requested");

  // Request the change — the code is emailed to the NEW address only.
  const captured = await captureConsole(() => requestEmailChange({ adminId, newEmail: NEW_EMAIL }));
  const requested = captured.value;
  checkEqual(requested.status, "requested", "email change request is issued");
  check(requested.status === "requested" && requested.pending.newEmailMasked.endsWith("@niyojan-verified.example"), "masked new email is returned for the UI");

  const changeCode = readCodeFor(NEW_EMAIL, "confirm your new administrator email");
  check(changeCode !== null, "verification code email is delivered to the NEW address (.eml in outbox)");
  check(/^[A-HJ-NP-Z2-9]{8}$/.test(changeCode ?? ""), "the code is 8 uppercase-letters+digits characters");
  check(!captured.output.includes(changeCode ?? "___NOCODE___"), "the verification code never appears in application logs");

  const requestRow = await ops
    .from("email_change_requests")
    .select("new_email, code_hash, expires_at, attempts, consumed_at")
    .eq("admin_id", adminId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  check(requestRow.data !== null, "email_change_requests row persisted");
  check(/^[0-9a-f]{64}$/.test(requestRow.data?.code_hash ?? ""), "only the HMAC hash of the code is stored");
  check((requestRow.data?.code_hash ?? "") !== changeCode, "stored hash is not the plaintext code");
  check(requestRow.data?.consumed_at === null, "request is unconsumed at issue time");
  const changeExpiryDelta = Math.abs(Date.parse(requestRow.data?.expires_at ?? "") - (Date.now() + 10 * 60_000));
  check(changeExpiryDelta < 10_000, "request expires ~10 minutes after issue");

  let emailRow = await ops.from("admin_accounts").select("email").eq("id", adminId).maybeSingle();
  checkEqual(emailRow.data?.email, env.ADMIN_EMAIL, "the CURRENT email stays active while unverified");

  const pendingBefore = await getPendingEmailChange(adminId);
  check(pendingBefore !== null, "pending email change is exposed for the UI (masked)");
  check(pendingBefore?.newEmailMasked.includes("•"), "the pending address is masked (never returned in full)");

  // Wrong code: rejected, burns an attempt, email unchanged.
  const wrongCode = await confirmEmailChange({ adminId, code: "ZZZZZZZZ" });
  checkEqual(wrongCode.status, "invalid", "wrong confirmation code is rejected");
  const attemptsRow = await ops
    .from("email_change_requests")
    .select("attempts")
    .eq("admin_id", adminId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  checkEqual(attemptsRow.data?.attempts, 1, "the wrong code burned exactly one attempt");
  emailRow = await ops.from("admin_accounts").select("email").eq("id", adminId).maybeSingle();
  checkEqual(emailRow.data?.email, env.ADMIN_EMAIL, "email unchanged after a wrong code");

  // Correct code: the new email becomes ACTIVE atomically.
  const confirmed = await confirmEmailChange({ adminId, code: changeCode! });
  checkEqual(confirmed.status, "verified", "correct confirmation code verifies");
  emailRow = await ops.from("admin_accounts").select("email").eq("id", adminId).maybeSingle();
  checkEqual(emailRow.data?.email, NEW_EMAIL, "the new email is active in the database");

  const consumedRow = await ops
    .from("email_change_requests")
    .select("consumed_at")
    .eq("admin_id", adminId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  check(consumedRow.data?.consumed_at !== null, "the request is consumed (single use)");
  const reuse = await confirmEmailChange({ adminId, code: changeCode! });
  checkEqual(reuse.status, "not_found", "the same code cannot be reused");
  checkEqual(await getPendingEmailChange(adminId), null, "no pending email change remains after confirmation");

  // Cooldown: measured from the LAST request — backdate it, issue for a
  // different address, then prove an immediate follow-up is blocked.
  await ops
    .from("email_change_requests")
    .update({ created_at: new Date(Date.now() - 75_000).toISOString() })
    .eq("admin_id", adminId);
  await clearEmailChangeRateLimit();
  const immediate = await requestEmailChange({ adminId, newEmail: "second.address@niyojan-verified.example" });
  checkEqual(immediate.status, "requested", "a request for a different address is issued after the cooldown");
  await clearEmailChangeRateLimit();
  await rejects(
    requestEmailChange({ adminId, newEmail: "third.address@niyojan-verified.example" }),
    "an immediate follow-up request is blocked by the resend cooldown",
  ).then((err) => {
    check(err instanceof PublicAccountError, "the cooldown rejection is a public-safe error");
  });

  // A new request retires the pending one; expiry and attempt exhaustion work.
  await ops
    .from("email_change_requests")
    .update({ created_at: new Date(Date.now() - 75_000).toISOString() })
    .eq("admin_id", adminId)
    .is("consumed_at", null);
  await clearEmailChangeRateLimit();
  const expiredRequest = await requestEmailChange({ adminId, newEmail: "second.address@niyojan-verified.example" });
  checkEqual(expiredRequest.status, "requested", "request re-issued after the cooldown (idempotent same address)");

  const secondCode = readCodeFor("second.address@niyojan-verified.example", "confirm your new administrator email");
  check(secondCode !== null, "the re-issued code email arrives");
  check(secondCode !== changeCode, "the re-issued code differs from the consumed one");

  // Force the request into the past -> expired.
  await ops
    .from("email_change_requests")
    .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("admin_id", adminId)
    .is("consumed_at", null);
  const expiredConfirm = await confirmEmailChange({ adminId, code: secondCode! });
  checkEqual(expiredConfirm.status, "expired", "an expired request returns 'expired'");
  emailRow = await ops.from("admin_accounts").select("email").eq("id", adminId).maybeSingle();
  checkEqual(emailRow.data?.email, NEW_EMAIL, "an expired request never changes the email");

  // Attempt exhaustion: five wrong codes kill the request.
  await ops
    .from("email_change_requests")
    .update({ expires_at: new Date(Date.now() + 10 * 60_000).toISOString(), attempts: 0 })
    .eq("admin_id", adminId)
    .is("consumed_at", null);
  await ops.from("rate_limits").delete().like("key", "account:email-change-verify");
  let burnStatus = "";
  for (let i = 0; i < 5; i += 1) {
    const attempt = await confirmEmailChange({ adminId, code: "ZZZZZZZZ" });
    burnStatus = attempt.status;
  }
  checkEqual(burnStatus, "invalid", "each of the five wrong codes burns an attempt");
  const deadConfirm = await confirmEmailChange({ adminId, code: secondCode! });
  checkEqual(deadConfirm.status, "too_many_attempts", "the request is dead after five wrong codes (correct code no longer works)");
  emailRow = await ops.from("admin_accounts").select("email").eq("id", adminId).maybeSingle();
  checkEqual(emailRow.data?.email, NEW_EMAIL, "an exhausted request never changes the email");

  // RLS: the anon key can neither read nor drive the email-change machinery.
  const anon = anonClient();
  const anonRequests = await anon.from("email_change_requests").select("id");
  check(Boolean(anonRequests.error) || (anonRequests.data?.length ?? 0) === 0, "anonymous Supabase key cannot read email_change_requests");
  const anonProfile = await anon.from("corporation_profile").select("id");
  check(Boolean(anonProfile.error) || (anonProfile.data?.length ?? 0) === 0, "anonymous Supabase key cannot read corporation_profile");
  const anonProfileInsert = await anon.from("corporation_profile").insert({ corporation_name: "Ghost Corp" });
  check(Boolean(anonProfileInsert.error), "anonymous Supabase key cannot write corporation_profile");
  const anonRpc = await anon.rpc("account_consume_email_change", {
    p_admin_id: adminId,
    p_code_hash: "0".repeat(64),
  });
  check(Boolean(anonRpc.error), "anonymous Supabase key cannot invoke account_consume_email_change");

  /* ==========================================================================
   * 5. CHANGING CORPORATION LOGO
   * ========================================================================*/
  section("5. Changing corporation logo");

  const logoSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">` +
      `<rect width="320" height="200" fill="#1b2737"/><rect x="24" y="24" width="88" height="88" fill="#a2753b"/>` +
      `<text x="24" y="160" font-family="Arial" font-size="28" fill="#ffffff">NC</text></svg>`,
  );
  const logoPng = await sharp(logoSvg).png().toBuffer();

  const logoUrl = await storeCorporationLogo(logoPng);
  check(logoUrl.startsWith("/uploads/corporation-logos/"), "the corporation logo is stored in its own area");
  check(/^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(logoUrl.split("/").pop() ?? ""), "the stored filename is a server-generated UUID + whitelisted extension");
  const storedFile = path.join(process.cwd(), ".data", "corporation-logos", logoUrl.split("/").pop()!);
  check(existsSync(storedFile), "the re-encoded file exists on disk (local adapter)");
  const storedMeta = await sharp(readFileSync(storedFile)).metadata();
  check(storedMeta.format === "png", "the stored file is a real PNG (decoded by sharp)");
  check((storedMeta.width ?? 0) <= 512 && (storedMeta.height ?? 0) <= 512, "dimensions are capped at the 512 px box");

  const withLogo = await updateCorporationProfile({ corporationName: "Niyojan Corporation Group", logoUrl });
  checkEqual(withLogo.status, "updated", "corporation profile accepts the new logo URL");
  const logoRow = await ops.from("corporation_profile").select("logo_url").eq("id", "CORPORATION").maybeSingle();
  checkEqual(logoRow.data?.logo_url, logoUrl, "database stores the corporation logo URL");

  page = http("http://127.0.0.1:3000/settings/account", { Cookie: `niyojan_session=${sessionPage.token}` });
  check(page.body.includes(logoUrl), "the page renders the custom corporation logo");

  const logoHttp = http(`http://127.0.0.1:3000${logoUrl}`);
  check(logoHttp.status.startsWith("200"), "the logo is served over HTTP");
  check(logoHttp.body.length > 0, "the logo response has content");

  const logoHeaders = execFileSync(
    "curl",
    ["-s", "-o", "/dev/null", "-D", "-", `http://127.0.0.1:3000${logoUrl}`],
    { encoding: "utf8" },
  );
  check(/content-type:\s*image\/png/i.test(logoHeaders), "the logo is served with Content-Type image/png");
  check(/x-content-type-options:\s*nosniff/i.test(logoHeaders), "the logo response carries nosniff");

  // Upload hardening — rejected before anything is persisted.
  await rejects(storeCorporationLogo(Buffer.from("This is plain text pretending to be a logo.")), "a text payload without image magic bytes is rejected");
  await rejects(storeCorporationLogo(Buffer.alloc(0)), "an empty logo payload is rejected");
  const oversized = Buffer.alloc(3 * 1024 * 1024, 0x41);
  oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  await rejects(storeCorporationLogo(oversized), "a payload over 2 MB is rejected");
  await rejects(storeCorporationLogo(logoPng.subarray(0, 24)), "a truncated PNG is rejected (decode proof)");

  // Path traversal / unrelated paths on /uploads are refused.
  const traversal = http("http://127.0.0.1:3000/uploads/corporation-logos/..%2f..%2f.env");
  check(traversal.status.startsWith("404"), "path traversal on the uploads route is refused");
  const unrelated = http("http://127.0.0.1:3000/uploads/other-area/x.png");
  check(unrelated.status.startsWith("404"), "unrelated upload areas are refused");

  // Restoring the default logo clears the custom one.
  const removed = await updateCorporationProfile({ corporationName: "Niyojan Corporation Group", logoUrl: null });
  checkEqual(removed.status, "updated", "removing the custom logo succeeds");
  const removedRow = await ops.from("corporation_profile").select("logo_url").eq("id", "CORPORATION").maybeSingle();
  checkEqual(removedRow.data?.logo_url, null, "logo_url is NULL again (official asset fallback)");
  page = http("http://127.0.0.1:3000/settings/account", { Cookie: `niyojan_session=${sessionPage.token}` });
  check(page.body.includes("/brand/logo-mark.png"), "the official brand logo is restored on the page");

  /* ==========================================================================
   * 6. SUCCESSFUL PASSWORD UPDATE
   * ========================================================================*/
  section("6. Successful password update");

  const sessionKeep = await createSession(adminId, META);
  const sessionOther = await createSession(adminId, META);

  const beforeHash = (await ops.from("admin_accounts").select("password_hash, credentials_source, password_updated_at").eq("id", adminId).maybeSingle()).data!;

  const changed = await changeAdminPassword({
    adminId,
    currentPassword: env.ADMIN_PASSWORD,
    newPassword: NEW_PASSWORD,
    keepSessionId: sessionKeep.sessionId,
  });
  checkEqual(changed.status, "changed", "password change succeeds with the correct current password");

  const afterHash = (await ops.from("admin_accounts").select("password_hash, credentials_source, password_updated_at").eq("id", adminId).maybeSingle()).data!;
  check(afterHash.password_hash !== beforeHash.password_hash, "the stored hash actually changed");
  check(afterHash.password_hash.startsWith("$argon2id$"), "the new credential is an Argon2id hash");
  check(!afterHash.password_hash.includes(NEW_PASSWORD), "plaintext password never stored");
  checkEqual(afterHash.credentials_source, "database", "credential source flips to 'database' (env bootstrap stops applying)");
  const updatedDelta = Math.abs(Date.parse(afterHash.password_updated_at) - Date.now());
  check(updatedDelta < 10_000, "password_updated_at is refreshed");

  check(await verifyPassword(NEW_PASSWORD, afterHash.password_hash), "the new password verifies against the new hash");
  check(!(await verifyPassword(env.ADMIN_PASSWORD, afterHash.password_hash)), "the old password no longer verifies");

  // Session policy: every OTHER session is revoked; the current one survives.
  checkEqual((await validateSessionToken(sessionKeep.token))?.adminId, adminId, "the session that made the change stays valid");
  checkEqual(await validateSessionToken(sessionOther.token), null, "other sessions are revoked server-side");

  // Bootstrap can never roll a database-sourced credential back.
  await ensureAdminBootstrapped();
  const afterBootstrap = (await ops.from("admin_accounts").select("password_hash").eq("id", adminId).maybeSingle()).data!;
  checkEqual(afterBootstrap.password_hash, afterHash.password_hash, "the database-sourced credential survives a bootstrap re-run");

  /* ==========================================================================
   * 7. INCORRECT CURRENT PASSWORD
   * ========================================================================*/
  section("7. Incorrect current password");

  const wrongCurrent = await changeAdminPassword({
    adminId,
    currentPassword: "WrongCurrent#Pass1",
    newPassword: "Another#Password1",
    keepSessionId: sessionKeep.sessionId,
  });
  checkEqual(wrongCurrent.status, "wrong_current", "an incorrect current password is rejected");
  const stillNew = (await ops.from("admin_accounts").select("password_hash").eq("id", adminId).maybeSingle()).data?.password_hash;
  checkEqual(stillNew, afterHash.password_hash, "the credential is untouched after a wrong current password");

  // Same-password change is refused.
  const samePassword = await changeAdminPassword({
    adminId,
    currentPassword: NEW_PASSWORD,
    newPassword: NEW_PASSWORD,
    keepSessionId: sessionKeep.sessionId,
  });
  checkEqual(samePassword.status, "invalid", "setting the same password again is rejected");

  /* ==========================================================================
   * 8. PASSWORD MISMATCH
   * ========================================================================*/
  section("8. Password mismatch (new vs confirmation)");

  const mismatch = passwordChangeFormSchema.safeParse({
    currentPassword: NEW_PASSWORD,
    newPassword: "Mismatched#Password1",
    confirmPassword: "Mismatched#Password2",
  });
  check(!mismatch.success, "a confirmation that differs from the new password is rejected");
  check(
    Boolean(mismatch.success === false && mismatch.error.issues.some((i) => i.path[0] === "confirmPassword")),
    "the mismatch error points at the confirmation field",
  );
  const matching = passwordChangeFormSchema.safeParse({
    currentPassword: NEW_PASSWORD,
    newPassword: "Matching#Password1",
    confirmPassword: "Matching#Password1",
  });
  check(matching.success, "matching confirmation passes the same check");

  /* ==========================================================================
   * 9. WEAK PASSWORD REJECTION
   * ========================================================================*/
  section("9. Weak password rejection (12+ chars, mixed case, digit, symbol)");

  const weakCases: Array<[string, string]> = [
    ["Short#1234A", "11 characters"],
    ["alllowercase123!", "missing uppercase"],
    ["ALLUPPERCASE123!", "missing lowercase"],
    ["NoDigits#HereAtAll", "missing digit"],
    ["NoSymbols12345678", "missing special character"],
  ];
  for (const [candidate, label] of weakCases) {
    const parsed = passwordChangeSchema.safeParse({ currentPassword: "irrelevant", newPassword: candidate });
    check(!parsed.success, `${label} is rejected by the strong policy`);
  }
  const strong = passwordChangeSchema.safeParse({ currentPassword: "irrelevant", newPassword: NEW_PASSWORD });
  check(strong.success, "a compliant 12+ character mixed password is accepted");

  /* ==========================================================================
   * 10. LOGIN USING THE NEWLY UPDATED PASSWORD
   * ========================================================================*/
  section("10. Login using the newly updated password");

  const lastLoginBeforeLogin = (await ops.from("admin_accounts").select("last_login_at").eq("id", adminId).maybeSingle()).data?.last_login_at ?? null;

  const step1 = await submitCredentials({ username: env.ADMIN_USERNAME, password: NEW_PASSWORD, meta: META });
  checkEqual(step1.status, "otp_required", "the NEW password passes credential verification");
  const loginCode = readCodeFor(NEW_EMAIL, "your sign-in verification code");
  check(loginCode !== null, "the sign-in code email arrives at the NEWLY VERIFIED address");
  const step2 = await verifyOtp({ challengeId: step1.status === "otp_required" ? step1.issuedOtp.challengeId : "", adminId, code: loginCode!, meta: META });
  checkEqual(step2.status, "verified", "the OTP verifies and completes the login");

  const wrongOld = await submitCredentials({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, meta: META });
  checkEqual(wrongOld.status, "invalid_credentials", "login is rejected with the old password");

  /* ==========================================================================
   * 12. ACCURATE LAST-LOGIN TIMESTAMP (checked here while the login is fresh)
   * ========================================================================*/
  section("12. Accurate last-login timestamp");

  const lastLoginAfter = (await ops.from("admin_accounts").select("last_login_at").eq("id", adminId).maybeSingle()).data?.last_login_at ?? null;
  check(lastLoginAfter !== null, "last_login_at is set after a successful OTP-authenticated login");
  check(lastLoginAfter !== lastLoginBeforeLogin, "last_login_at moved from its previous value");
  const loginDelta = Math.abs(Date.parse(lastLoginAfter ?? "") - Date.now());
  check(loginDelta < 15_000, "last_login_at matches the actual login moment (UTC, seconds-accurate)");

  // Credentials-correct but OTP-failed attempts must NOT touch last_login_at.
  const preFailedOtp = (await ops.from("admin_accounts").select("last_login_at").eq("id", adminId).maybeSingle()).data?.last_login_at ?? null;
  // Age challenges past the OTP resend cooldown (ops manipulation, as in test-auth).
  await ops
    .from("auth_otp_challenges")
    .update({ created_at: new Date(Date.now() - 75_000).toISOString() })
    .neq("id", "00000000-0000-0000-0000-000000000000");
  const failedStep1 = await submitCredentials({ username: env.ADMIN_USERNAME, password: NEW_PASSWORD, meta: META });
  checkEqual(failedStep1.status, "otp_required", "credentials pass for the failed-OTP probe");
  const failedOtp = await verifyOtp({
    challengeId: failedStep1.status === "otp_required" ? failedStep1.issuedOtp.challengeId : "",
    adminId,
    code: "ZZZZZZZZ",
    meta: META,
  });
  checkEqual(failedOtp.status, "invalid", "the wrong OTP is rejected");
  const postFailedOtp = (await ops.from("admin_accounts").select("last_login_at").eq("id", adminId).maybeSingle()).data?.last_login_at ?? null;
  checkEqual(postFailedOtp, preFailedOtp, "last_login_at is NOT updated when credentials pass but the OTP fails");

  /* ==========================================================================
   * 11. LOGIN USING THE OLD PASSWORD — already asserted above; explicit re-check
   * ========================================================================*/
  section("11. Login using the old password (re-checked)");
  const oldAgain = await submitCredentials({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, meta: META });
  checkEqual(oldAgain.status, "invalid_credentials", "the old (rotated-out) password is definitively rejected");
  const hashCheck = await verifyPassword(env.ADMIN_PASSWORD, afterHash.password_hash);
  checkEqual(hashCheck, false, "the stored hash no longer verifies the old password");

  /* ==========================================================================
   * Restore pristine state for repeatable suite runs.
   * ========================================================================*/
  section("Cleanup — restore bootstrap state");

  const restoreHash = await hashPassword(env.ADMIN_PASSWORD);
  await ops
    .from("admin_accounts")
    .update({
      display_name: env.ADMIN_NAME,
      email: env.ADMIN_EMAIL,
      password_hash: restoreHash,
      credentials_source: "env_bootstrap",
      password_updated_at: new Date().toISOString(),
    })
    .eq("id", adminId);
  await resetAccountDataForTests();
  await resetGlobalAuthStateForTests();
  await ops.from("admin_sessions").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await ops.from("auth_otp_challenges").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await ops.from("rate_limits").delete().like("key", "account:%");

  const restored = await getAdminByUsername(env.ADMIN_USERNAME);
  checkEqual(restored?.display_name, env.ADMIN_NAME, "display name restored to the bootstrap value");
  checkEqual(restored?.email, env.ADMIN_EMAIL, "email restored to the bootstrap value");
  checkEqual(restored?.credentials_source, "env_bootstrap", "credential source restored to env_bootstrap");
  check(await verifyPassword(env.ADMIN_PASSWORD, restored?.password_hash ?? ""), "the bootstrap password verifies again");

  finish("ACCOUNT SETTINGS TESTS (12 required scenarios + extras)");
}

main().catch((err) => {
  console.error("Account test runner crashed:", err);
  process.exit(1);
});
