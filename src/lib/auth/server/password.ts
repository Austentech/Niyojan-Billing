import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";

/**
 * Password hashing — Argon2id (OWASP-aligned parameters).
 *
 *   memoryCost 19 MiB, timeCost 2, parallelism 1 — the OWASP Password
 *   Storage Cheat Sheet baseline for Argon2id.
 *
 * Plaintext passwords are never stored, never logged and never returned to
 * any client. The database only ever sees the encoded Argon2id string.
 */

const ARGON2_OPTIONS = {
  memoryCost: 19456, // KiB (19 MiB)
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await argon2Verify(passwordHash, password);
  } catch {
    // Malformed/unknown hash format — never crash the login flow.
    return false;
  }
}

/**
 * Constant-work dummy verification used when the username does not exist,
 * so response timing cannot reveal whether the username or the password was
 * wrong (the error message never reveals it either).
 */
let dummyHashPromise: Promise<string> | null = null;

export async function dummyVerify(password: string): Promise<boolean> {
  dummyHashPromise ??= argon2Hash("timing-equalization-placeholder", ARGON2_OPTIONS);
  const dummyHash = await dummyHashPromise;
  try {
    return await argon2Verify(dummyHash, password);
  } catch {
    return false;
  }
}
