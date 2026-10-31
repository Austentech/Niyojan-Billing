/** Tiny assertion harness for the auth test suites (no external deps). */

let passed = 0;
let failed = 0;
const failures: string[] = [];

export function check(condition: boolean, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

export function checkEqual<T>(actual: T, expected: T, label: string): void {
  const ok = actual === expected;
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    failures.push(`${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    console.log(`  ✗ ${label}`);
  }
}

export async function rejects(promise: Promise<unknown>, label: string): Promise<unknown> {
  try {
    await promise;
    check(false, `${label} (expected rejection)`);
    return null;
  } catch (err) {
    check(true, `${label} (rejected as expected)`);
    return err;
  }
}

export async function resolves(promise: Promise<unknown>, label: string): Promise<unknown> {
  try {
    const value = await promise;
    check(true, `${label} (resolved)`);
    return value;
  } catch (err) {
    check(false, `${label} (rejected unexpectedly: ${String(err)})`);
    return null;
  }
}

export function section(title: string): void {
  console.log(`\n━━ ${title}`);
}

export function finish(suiteName: string): never {
  console.log(`\n${"═".repeat(64)}`);
  console.log(`${suiteName}: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}
