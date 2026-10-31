/**
 * UNIT TESTS — pure cryptography/validation logic, no database required.
 * Run: npx tsx scripts/test-unit.ts
 */
import { loadDotEnv } from "./load-env";
import { check, checkEqual, section, finish } from "./test-harness";

loadDotEnv(".env");

import { generateOtpCode, hashOtpCode, constantTimeEqualsHex } from "../src/lib/auth/server/otp";
import { signPreauthPayload, verifyPreauthPayload } from "../src/lib/auth/server/session";
import { hashPassword, verifyPassword, dummyVerify } from "../src/lib/auth/server/password";
import { loginSchema, otpSchema, normalizeOtpCode } from "../src/lib/auth/validation";
import { maskEmail } from "../src/lib/auth/types";
import { getServerEnv, parseEnv, EnvConfigError } from "../src/lib/config/env";
import { OTP_CHARSET, OTP_LENGTH } from "../src/lib/constants";

async function main(): Promise<void> {
  /* ==========================================================================
   * 1. OTP generation — charset, length, randomness
   * ========================================================================*/
  section("OTP generation");

  {
    const samples = new Set<string>();
    let charsetOk = true;
    for (let i = 0; i < 2000; i += 1) {
      const code = generateOtpCode();
      if (code.length !== OTP_LENGTH) charsetOk = false;
      if (!code.split("").every((ch) => OTP_CHARSET.includes(ch))) charsetOk = false;
      samples.add(code);
    }
    checkEqual(OTP_LENGTH, 8, "OTP length is 8 characters");
    check(charsetOk, "every generated char is from the uppercase+digits alphabet");
    check(
      !OTP_CHARSET.includes("I") && !OTP_CHARSET.includes("O") && !OTP_CHARSET.includes("0") && !OTP_CHARSET.includes("1"),
      "ambiguous glyphs (I, O, 0, 1) are excluded",
    );
    check(samples.size > 1900, `2000 samples produce >1900 distinct codes (got ${samples.size})`);

    const observed = new Set<string>();
    for (let i = 0; i < 5000; i += 1) {
      for (const ch of generateOtpCode()) observed.add(ch);
    }
    check(
      OTP_CHARSET.split("").every((ch) => observed.has(ch)),
      "all 32 alphabet symbols appear across 5000 samples",
    );
  }

  /* ==========================================================================
   * 2. OTP hashing — HMAC, determinism, no plaintext leakage
   * ========================================================================*/
  section("OTP hashing");

  {
    const code = generateOtpCode();
    const hash1 = hashOtpCode(code);
    const hash2 = hashOtpCode(code);
    checkEqual(hash1, hash2, "hashing is deterministic for the same code");
    check(/^[0-9a-f]{64}$/.test(hash1), "hash is 64 hex characters (HMAC-SHA256)");
    check(!hash1.includes(code), "hash never contains the plaintext code");
    check(hashOtpCode("AAAAAAAA") !== hashOtpCode("AAAAAAAB"), "different codes -> different hashes");
    check(constantTimeEqualsHex(hash1, hash2), "constantTimeEqualsHex accepts identical digests");
    check(!constantTimeEqualsHex(hash1, hashOtpCode(generateOtpCode())), "constantTimeEqualsHex rejects different digests");
    check(!constantTimeEqualsHex("short", hash1), "constantTimeEqualsHex rejects malformed input");
  }

  /* ==========================================================================
   * 3. OTP normalization + Zod schemas
   * ========================================================================*/
  section("OTP validation schemas");

  {
    checkEqual(normalizeOtpCode("abcdefgh"), "ABCDEFGH", "lowercase input is uppercased");
    checkEqual(normalizeOtpCode("ab cd-ef gh"), "ABCDEFGH", "separators are stripped");
    checkEqual(normalizeOtpCode("10OI2S9Z"), "2S9Z", "ambiguous glyphs are filtered");
    checkEqual(normalizeOtpCode("qwertyuiopasdfghjk"), "QWERTYUP", "input is filtered then truncated to 8 characters");
    check(otpSchema.safeParse("ABCDEFGH").success, "otpSchema accepts a valid 8-char code");
    check(!otpSchema.safeParse("ABC").success, "otpSchema rejects a 3-char code");
    check(!otpSchema.safeParse("ABCDEFGI").success, "otpSchema rejects codes containing 'I'");
    check(otpSchema.safeParse("abcdefgh").success, "otpSchema normalizes lowercase input before validating");

    check(loginSchema.safeParse({ username: "deepak.khurana", password: "secret" }).success, "loginSchema accepts valid input");
    check(!loginSchema.safeParse({ username: "ab", password: "x" }).success, "loginSchema rejects too-short input");
    check(!loginSchema.safeParse({ username: "", password: "" }).success, "loginSchema rejects empty input");
  }

  /* ==========================================================================
   * 4. Pre-OTP cookie signing — roundtrip, tamper, expiry
   * ========================================================================*/
  section("Pre-OTP cookie signing");

  {
    const payload = { cid: "challenge-uuid-1", aid: "admin-uuid-1" };
    const signed = signPreauthPayload(payload, 600);
    const verified = verifyPreauthPayload(signed);
    check(verified !== null && verified.cid === payload.cid && verified.aid === payload.aid, "valid cookie verifies and roundtrips");

    check(verifyPreauthPayload(null) === null, "missing cookie is rejected");
    check(verifyPreauthPayload("garbage") === null, "garbage cookie is rejected");
    check(verifyPreauthPayload(`${signed}x`) === null, "truncated cookie is rejected");

    const [body, exp, sig] = signed.split(".");
    check(verifyPreauthPayload(`${body}.${exp}.${"A".repeat(sig.length)}`) === null, "tampered signature is rejected");
    check(verifyPreauthPayload(`${body}.${Number(exp) + 1}.${sig}`) === null, "expiry extension is rejected (signature binds the exp)");
    check(verifyPreauthPayload(signPreauthPayload(payload, -1)) === null, "expired cookie is rejected");
    check(signPreauthPayload(payload, 600) !== signPreauthPayload({ cid: "other", aid: "other" }, 600), "different payloads produce different cookies");
  }

  /* ==========================================================================
   * 5. Password hashing — Argon2id roundtrip
   * ========================================================================*/
  section("Password hashing (Argon2id)");

  {
    const hash = await hashPassword("correct horse battery staple");
    check(hash.startsWith("$argon2id$"), "hash uses the Argon2id algorithm");
    check(await verifyPassword("correct horse battery staple", hash), "correct password verifies");
    check(!(await verifyPassword("wrong password", hash)), "wrong password is rejected");
    check(!(await verifyPassword("x", "not-a-valid-hash")), "malformed hash never crashes verification");
    const dummy = await dummyVerify("some-password");
    check(dummy === false, "dummy verification always returns false (timing equalization)");
  }

  /* ==========================================================================
   * 6. Email masking
   * ========================================================================*/
  section("Email masking");

  {
    checkEqual(maskEmail("deepak.khurana@niyojan.com"), "d" + "•".repeat(13) + "@niyojan.com", "local part is masked to first letter");
    checkEqual(maskEmail("a@b.co"), "a••@b.co", "short local parts mask to at least two dots");
    checkEqual(maskEmail("bad-input"), "•••@•••", "malformed email degrades safely");
  }

  /* ==========================================================================
   * 7. Environment validation — names only, never values
   * ========================================================================*/
  section("Environment validation");

  {
    const env = getServerEnv();
    check(env.OTP_SECRET.length >= 32, "OTP_SECRET parsed and meets minimum length");
    checkEqual(env.SMTP_DEV_CAPTURE === "true", true, "dev mail capture flag parsed");

    const valid = { ...process.env } as Record<string, string | undefined>;
    check(typeof parseEnv(valid).ADMIN_USERNAME === "string", "valid environment parses");

    try {
      parseEnv({ ...valid, ADMIN_USERNAME: "!!invalid!!", ADMIN_PASSWORD: "short" });
      check(false, "invalid env throws EnvConfigError");
    } catch (err) {
      const isEnvError = err instanceof EnvConfigError;
      check(isEnvError, "invalid env throws EnvConfigError");
      if (err instanceof EnvConfigError) {
        check(err.invalidVars.includes("ADMIN_USERNAME"), "error lists the offending variable NAME");
        const message = err.message;
        check(!message.includes("short") && !message.includes("!!invalid!!"), "error message never contains variable VALUES");
      }
    }

    try {
      parseEnv({ ...valid, OTP_SECRET: valid.AUTH_SESSION_SECRET });
      check(false, "OTP_SECRET equal to AUTH_SESSION_SECRET is rejected");
    } catch (err) {
      check(err instanceof EnvConfigError, "secret reuse is rejected with EnvConfigError");
    }
  }

  finish("UNIT TESTS");
}

main().catch((err) => {
  console.error("Unit test runner crashed:", err);
  process.exit(1);
});
