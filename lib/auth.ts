/**
 * HMAC signing and verification utilities for publish endpoints.
 *
 * Header contract:
 * - x-pages-timestamp: Unix epoch milliseconds as string
 * - x-pages-signature: HMAC SHA-256 signature as hex string.
 *   Accepts formats: "v1=<hex>", "sha256=<hex>", or bare "<hex>".
 *
 * Canonical string to sign:
 *   `${METHOD}\n${PATH_WITH_QUERY}\n${TIMESTAMP}\n${SHA256_HEX(BODY)}`
 *
 * Where:
 * - METHOD is uppercased HTTP method (e.g., "POST")
 * - PATH_WITH_QUERY is URL pathname + search (e.g., "/api/serve?foo=1")
 * - TIMESTAMP is the same value as x-pages-timestamp
 * - BODY is the request text (empty string when no body)
 *
 * Secrets:
 * - Provide via options.secret or env PAGES_HMAC_SECRET.
 * - Supports key rotation: comma-separated values allowed and tried in order.
 *
 * Usage (verification in API route):
 *   import { verifyHmac } from "@/lib/auth";
 *   const vr = await verifyHmac(request, { toleranceMs: 5 * 60_000 });
 *   if (!vr.ok) return new Response(JSON.stringify({ error: vr.error }), { status: 401 });
 *
 * Usage (client signing helper):
 *   import { signRequest } from "@/lib/auth";
 *   const { headers } = await signRequest({ method: "POST", url, body, secret });
 *   await fetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body });
 */

export const SIGNATURE_HEADER = "x-pages-signature";
export const TIMESTAMP_HEADER = "x-pages-timestamp";

export type VerificationResult = { ok: true } | { ok: false; error: string };

type HmacOptions = {
  secret?: string | string[];
  toleranceMs?: number; // allowed clock skew; default 5 minutes
};

const DEFAULT_TOLERANCE_MS = 5 * 60_000;

const te = new TextEncoder();

/**
 * Compute SHA-256 hex digest from input.
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === "string" ? te.encode(input) : input;
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(hash));
}

/**
 * Compute HMAC-SHA256 hex(signature) using WebCrypto when available, else Node crypto.
 */
export async function hmacSha256Hex(
  secret: string,
  data: string | Uint8Array,
): Promise<string> {
  // Prefer WebCrypto (available in Edge/modern Node)
  if (crypto?.subtle) {
    const key = await crypto.subtle.importKey(
      "raw",
      te.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, typeof data === "string" ? te.encode(data) : data);
    return toHex(new Uint8Array(sig));
  }

  // Fallback: Node crypto (should not be used in Edge runtime)
  try {
    // Dynamic import to avoid bundling in Edge
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const nodeCrypto = await import("node:crypto");
    const h = nodeCrypto.createHmac("sha256", secret);
    h.update(typeof data === "string" ? data : Buffer.from(data));
    return h.digest("hex");
  } catch (err) {
    throw new Error("No crypto implementation available for HMAC");
  }
}

/**
 * Verify HMAC for a Request. Returns { ok: true } on success, or { ok: false, error }.
 */
export async function verifyHmac(
  request: Request,
  options: HmacOptions = {},
): Promise<VerificationResult> {
  const tolerance = options.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const provided = parseSignatureHeader(request.headers.get(SIGNATURE_HEADER));
  if (!provided) return { ok: false, error: `Missing ${SIGNATURE_HEADER}` };

  const tsHeader = request.headers.get(TIMESTAMP_HEADER);
  if (!tsHeader) return { ok: false, error: `Missing ${TIMESTAMP_HEADER}` };
  if (!/^\d{10,16}$/.test(tsHeader)) {
    return { ok: false, error: `Invalid ${TIMESTAMP_HEADER} format` };
  }
  const ts = Number(tsHeader);
  const now = Date.now();
  if (!Number.isFinite(ts)) {
    return { ok: false, error: `Invalid ${TIMESTAMP_HEADER} value` };
  }
  if (Math.abs(now - ts) > tolerance) {
    return { ok: false, error: "Timestamp outside allowed tolerance" };
  }

  const urlObj = new URL(request.url);
  const method = request.method.toUpperCase();
  const pathWithQuery = urlObj.pathname + urlObj.search;
  const bodyText = await safeReadBodyText(request);
  const bodyHash = await sha256Hex(bodyText);
  const canon = canonicalString(method, pathWithQuery, tsHeader, bodyHash);

  const secrets = getSecrets(options.secret);
  if (secrets.length === 0) {
    return { ok: false, error: "No HMAC secret configured" };
  }

  for (const secret of secrets) {
    const expected = await hmacSha256Hex(secret, canon);
    if (timingSafeEqualHex(provided, expected)) {
      return { ok: true };
    }
  }

  return { ok: false, error: "Invalid signature" };
}

/**
 * Create headers for a signed request (useful for test clients or MCP).
 */
export async function signRequest(params: {
  method: string;
  url: string;
  body?: string | Uint8Array;
  secret: string;
  timestampMs?: number;
}): Promise<{ signature: string; timestamp: string; headers: Record<string, string> }> {
  const ts = String(params.timestampMs ?? Date.now());
  const urlObj = new URL(params.url);
  const method = params.method.toUpperCase();
  const pathWithQuery = urlObj.pathname + urlObj.search;

  const bodyText =
    typeof params.body === "string"
      ? params.body
      : params.body
        ? new TextDecoder().decode(params.body)
        : "";

  const bodyHash = await sha256Hex(bodyText);
  const canon = canonicalString(method, pathWithQuery, ts, bodyHash);
  const signature = await hmacSha256Hex(params.secret, canon);

  return {
    signature,
    timestamp: ts,
    headers: {
      [SIGNATURE_HEADER]: `v1=${signature}`,
      [TIMESTAMP_HEADER]: ts,
    },
  };
}

/**
 * Helper: canonical string to sign
 */
export function canonicalString(
  method: string,
  pathWithQuery: string,
  timestamp: string,
  bodySha256Hex: string,
): string {
  return `${method}\n${pathWithQuery}\n${timestamp}\n${bodySha256Hex}`;
}

/**
 * Read request body safely without consuming the original stream.
 * Returns text (empty string if no body).
 */
async function safeReadBodyText(request: Request): Promise<string> {
  try {
    const cloned = request.clone();
    // Non-GET methods may not have a body anyway
    const text = await cloned.text();
    return text ?? "";
  } catch {
    return "";
  }
}

/**
 * Extract hex signature from header value.
 * Accepts formats:
 *  - "v1=<hex>"
 *  - "sha256=<hex>"
 *  - "<hex>"
 */
export function parseSignatureHeader(h: string | null): string | null {
  if (!h) return null;
  const val = h.trim();
  if (!val) return null;
  const parts = val.split(",");
  for (const p of parts) {
    const seg = p.trim();
    const m =
      /^v1=([0-9a-fA-F]+)$/.exec(seg) ||
      /^sha256=([0-9a-fA-F]+)$/.exec(seg) ||
      /^([0-9a-fA-F]+)$/.exec(seg);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Resolve secrets from options or environment (supports rotation).
 * - options.secret can be string or array
 * - env PAGES_HMAC_SECRET can be comma-separated list
 */
export function getSecrets(overrides?: string | string[]): string[] {
  if (typeof overrides === "string") {
    return splitSecrets(overrides);
  }
  if (Array.isArray(overrides)) {
    return overrides.flatMap(splitSecrets);
  }
  const envVal =
    (typeof process !== "undefined" && process.env?.PAGES_HMAC_SECRET) || "";
  return splitSecrets(envVal);
}

function splitSecrets(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Constant-time hex comparison to avoid timing attacks.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const ah = a.toLowerCase();
  const bh = b.toLowerCase();
  if (ah.length !== bh.length) return false;
  let out = 0;
  for (let i = 0; i < ah.length; i++) {
    out |= ah.charCodeAt(i) ^ bh.charCodeAt(i);
  }
  return out === 0;
}

function toHex(buf: Uint8Array | ArrayBuffer): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16).padStart(2, "0");
    hex += h;
  }
  return hex;
}
