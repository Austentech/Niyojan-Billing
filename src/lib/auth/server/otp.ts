import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

import { getServerEnv } from "@/lib/config/env";
import { OTP_CHARSET, OTP_LENGTH } from "@/lib/constants";

/**
 * Verification-code (OTP) cryptography.
 *
 * Generation : 8 characters drawn with crypto.randomInt from an unambiguous
 *              uppercase-letter + digit alphabet (I, O, 0, 1 removed).
 * Storage    : ONLY HMAC-SHA256(code, OTP_SECRET) is persisted. A database
 *              leak therefore cannot be brute-forced offline without the
 *              secret. The plaintext code exists solely in the outgoing
 *              email and in volatile memory.
 * Transport  : the code is never returned in any API response, never logged,
 *              and never stored client-side.
 */

export function generateOtpCode(): string {
  let code = "";
  for (let i = 0; i < OTP_LENGTH; i += 1) {
    code += OTP_CHARSET[randomInt(OTP_CHARSET.length)];
  }
  return code;
}

export function hashOtpCode(code: string): string {
  const env = getServerEnv();
  return createHmac("sha256", env.OTP_SECRET).update(code, "utf8").digest("hex");
}

/** Timing-safe comparison of two hex digests. */
export function constantTimeEqualsHex(a: string, b: string): boolean {
  if (a.length !== 64 || b.length !== 64) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}
