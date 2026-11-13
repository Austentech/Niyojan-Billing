import { createHash, createHmac } from "node:crypto";

import { getServerEnv, type ServerEnv } from "@/lib/config/env";

/**
 * S3-compatible object storage upload — AWS Signature Version 4 over fetch.
 *
 * Works with any S3-compatible provider (AWS S3, Cloudflare R2, Backblaze
 * B2, MinIO, Wasabi, ...). Enabled ONLY when LOGO_STORAGE_MODE=s3 and the
 * S3_* environment group is configured; otherwise the application offers
 * validated logo URLs instead of pretending uploads work.
 *
 * SECURITY
 *   * Credentials are read from the validated server environment only.
 *   * Object keys are server-generated UUIDs + a whitelisted extension —
 *     no user-controlled characters ever enter the signed path.
 *   * Requests are PUT-only; responses are validated; failures never retry
 *     with modified input and never leak credentials into errors or logs.
 *
 * The signing core is exported for the unit test, which verifies it against
 * the official AWS Signature Version 4 example vectors.
 */

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 percent-encoding for the canonical URI path (S3 object key). */
function uriEncode(value: string, encodeSlash = true): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    const unreserved = /[A-Za-z0-9-_.~]/.test(ch);
    if (unreserved || (ch === "/" && !encodeSlash)) {
      out += ch;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/* ============================================================================
 * SigV4 signing core (pure functions — unit-tested against AWS vectors)
 * ==========================================================================*/

/** kSigning = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request") */
export function deriveSigningKey(secret: string, datestamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, datestamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export interface SigV4Request {
  method: "PUT" | "GET" | "DELETE";
  /** Canonical URI (object key path, starting with /). */
  canonicalUri: string;
  host: string;
  /** Additional signed headers (name already lowercase, trimmed). */
  headers: Record<string, string>;
  payload: Buffer;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** Fixed signing time (tests inject the AWS example time). */
  now?: Date;
}

/** Build the canonical request string per the SigV4 specification. */
export function buildCanonicalRequest(req: SigV4Request, amzDate: string, payloadHash: string): string {
  const headers: Record<string, string> = {
    host: req.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...req.headers,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim()}\n`).join("");
  const signedHeaders = names.join(";");
  return [req.method, req.canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
}

/** Compute the Authorization header value for a request. */
export function signRequest(req: SigV4Request): { authorization: string; amzDate: string; payloadHash: string } {
  const now = req.now ?? new Date();
  const amzDate = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
  const datestamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(req.payload);

  const canonicalRequest = buildCanonicalRequest(req, amzDate, payloadHash);
  const credentialScope = `${datestamp}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = deriveSigningKey(req.secretAccessKey, datestamp, req.region, req.service);
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const names = Object.keys({
    host: "",
    "x-amz-content-sha256": "",
    "x-amz-date": "",
    ...req.headers,
  })
    .sort()
    .join(";");

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${credentialScope}, SignedHeaders=${names}, Signature=${signature}`,
    amzDate,
    payloadHash,
  };
}

/* ============================================================================
 * Provider endpoint resolution
 * ==========================================================================*/

interface S3Config {
  endpoint: string;
  host: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
}

/**
 * Resolve the provider configuration. Virtual-host style for AWS S3
 * (https://bucket.s3.region.amazonaws.com); path style when a custom
 * S3_ENDPOINT is configured (R2, B2, MinIO and most S3-compatible stores).
 */
export function resolveS3Config(env: ServerEnv): S3Config {
  const region = env.S3_REGION!;
  const bucket = env.S3_BUCKET!;
  const accessKeyId = env.S3_ACCESS_KEY_ID!;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY!;

  let endpoint: string;
  let host: string;
  let publicBaseUrl: string;

  if (env.S3_ENDPOINT) {
    const ep = new URL(env.S3_ENDPOINT);
    const epOrigin = `${ep.protocol}//${ep.host}`;
    endpoint = `${epOrigin}/${bucket}`;
    host = ep.host;
    publicBaseUrl = env.S3_PUBLIC_BASE_URL ?? `${epOrigin}/${bucket}`;
  } else {
    host = `${bucket}.s3.${region}.amazonaws.com`;
    endpoint = `https://${host}`;
    publicBaseUrl = env.S3_PUBLIC_BASE_URL ?? `https://${host}`;
  }

  return { endpoint, host, region, bucket, accessKeyId, secretAccessKey, publicBaseUrl };
}

/* ============================================================================
 * Public upload API
 * ==========================================================================*/

/**
 * Upload one object with a server-generated key. Returns the PUBLIC URL of
 * the stored object. Throws a sanitized Error on any failure (status code
 * only — never credentials, never the response body).
 */
export async function s3PutObject(input: {
  /** Server-generated object key (UUID + whitelisted extension). */
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<string> {
  const env = getServerEnv();
  const config = resolveS3Config(env);

  const req: SigV4Request = {
    method: "PUT",
    canonicalUri: `/${uriEncode(input.key)}`,
    host: config.host,
    headers: { "content-type": input.contentType },
    payload: input.body,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: "s3",
  };
  const { authorization, amzDate, payloadHash } = signRequest(req);

  let response: Response;
  try {
    response = await fetch(`${config.endpoint}/${uriEncode(input.key)}`, {
      method: "PUT",
      headers: {
        Authorization: authorization,
        "Content-Type": input.contentType,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
      body: new Uint8Array(input.body),
    });
  } catch {
    throw new Error("object storage is unreachable (network error)");
  }

  if (!response.ok) {
    // Status code only — provider error bodies can echo signed input.
    throw new Error(`object storage rejected the upload (status ${response.status})`);
  }

  return `${config.publicBaseUrl.replace(/\/$/, "")}/${input.key}`;
}

/** The empty-payload SHA-256 constant (exported for tests). */
export const S3_EMPTY_PAYLOAD_SHA256 = EMPTY_SHA256;
