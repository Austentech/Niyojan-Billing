/**
 * SigV4 signing-core verification against the official AWS Signature
 * Version 4 example vectors (the classic documented example, asserted by
 * independent reference implementations).
 *
 *   Vector 1 — signing key derivation:
 *     secret wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY, 20150830/us-east-1/iam
 *     => c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9
 *
 *   Vector 2 — full GET / signature on example.amazonaws.com:
 *     AKIDEXAMPLE, 20150830T123600Z, us-east-1, service "service",
 *     signed headers host;x-amz-content-sha256;x-amz-date
 *     => 726c5c4879a6b4ccbbd3b24edbd6b8826d34f87450fbbf4e85546fc7ba9c1642
 */
import { createHash } from "node:crypto";

import {
  buildCanonicalRequest,
  deriveSigningKey,
  signRequest,
  S3_EMPTY_PAYLOAD_SHA256,
} from "../src/lib/storage/s3";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const hex = (b: Buffer) => b.toString("hex");

/* --- Vector 1: kSigning derivation ----------------------------------------- */
const kSigning = deriveSigningKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "iam");
check(
  "deriveSigningKey matches AWS vector",
  hex(kSigning) === "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
  hex(kSigning),
);

/* --- Vector 2: full request signature ---------------------------------------- */
const emptyHash = createHash("sha256").update("").digest("hex");
check("empty payload hash", emptyHash === S3_EMPTY_PAYLOAD_SHA256, emptyHash);

const { authorization } = signRequest({
  method: "GET",
  canonicalUri: "/",
  host: "example.amazonaws.com",
  headers: {},
  payload: Buffer.alloc(0),
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
  now: new Date("2015-08-30T12:36:00Z"),
});

check(
  "full signature matches AWS vector",
  authorization ===
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=726c5c4879a6b4ccbbd3b24edbd6b8826d34f87450fbbf4e85546fc7ba9c1642",
  authorization,
);

/* --- Canonical request shape (spec conformance) ------------------------------ */
const canonical = buildCanonicalRequest(
  {
    method: "GET",
    canonicalUri: "/",
    host: "example.amazonaws.com",
    headers: {},
    payload: Buffer.alloc(0),
    accessKeyId: "x",
    secretAccessKey: "y",
    region: "us-east-1",
    service: "service",
  },
  "20150830T123600Z",
  S3_EMPTY_PAYLOAD_SHA256,
);
check(
  "canonical request format",
  canonical ===
    "GET\n/\n\nhost:example.amazonaws.com\nx-amz-content-sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\nx-amz-date:20150830T123600Z\n\nhost;x-amz-content-sha256;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  canonical,
);

if (failures > 0) {
  console.error(`\n${failures} SigV4 verification failure(s).`);
  process.exit(1);
}
console.log("\nSigV4 signing core verified against AWS reference vectors.");
