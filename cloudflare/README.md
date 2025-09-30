# SparkleTree Pages — Cloudflare Worker (Data Plane)

This Worker is the global, multi-tenant “data plane” for SparkleTree Pages. It serves versioned pages and assets with instant rollback, backed by Cloudflare KV (metadata, pointers) and R2 (assets/files). All write operations are authenticated via HMAC-signed requests from the control plane (Next.js + MCP server).

- Repo root (data plane): `cloudflare/`
- Entry: `src/worker.ts`
- Config: `wrangler.toml`
- Bindings: `PAGES_KV` (KV), `PAGES_BUCKET` (R2), optional `PAGES_HMAC_SECRET`, `ADMIN_BEARER_TOKEN`


## Features

- Multi-tenant page and asset serving at global edge performance
- Versioned publishes with instant rollback
- Automatic page expiration with configurable `deleteAfterSeconds`; expired pages return 410 Gone and are excluded from version listings once cleaned up.
- KV for lightweight metadata and active version pointers
- R2 for static assets and multi-file bundles
- Strict HMAC authentication for write operations
- Operator-only admin endpoints with optional bearer token
- Designed to be called by the control plane MCP tools (Next.js + Clerk OAuth)
- Tenant slugs are UUIDs provided by the control plane; clients do not pass tenant identifiers directly.


## High-Level Responsibilities

- Read (public): Serve published content by tenant/slug (slug is a UUID from the control plane) and version pointer
- Write (private): Accept HMAC-signed publish and rollback requests
- Metadata: Store/retrieve version history and active pointers from KV
- Assets: Store and fetch content bundles (HTML, JS, CSS, images) from R2


## Storage Model

- KV (binding: `PAGES_KV`): tenant/slug metadata, version pointers, lightweight records
- R2 (binding: `PAGES_BUCKET`): bulk/multi-file content; typically keyed by tenant/slug/version paths


## Security Model

- HMAC-signed requests for any “write” endpoints (publish, rollback)
- Strict timestamp freshness checks to prevent replay
- Optional admin bearer token for operator-only APIs
- Public “read” endpoints are safe and cache-friendly


## Prerequisites

- Cloudflare account and Wrangler CLI installed:
  - npm: `npm i -g wrangler`
- Node.js 18+ (20+ recommended) installed locally for dev
- Access to configure KV and R2 in the target Cloudflare account


## Bindings and Configuration

See `wrangler.toml` (adjust names/IDs to your environment):

```toml
name = "ai-pages-worker"
main = "src/worker.ts"
compatibility_date = "2024-06-20"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "PAGES_KV"
id = "YOUR_KV_NAMESPACE_ID"

[[r2_buckets]]
binding = "PAGES_BUCKET"
bucket_name = "pages"

[vars]
# Secrets are set via `wrangler secret put` (recommended)
# PAGES_HMAC_SECRET: Base64-encoded secret for request signing
# ADMIN_BEARER_TOKEN: Optional operator-only token

routes = [
  { pattern = "pages.sparkletree.io/*", zone_name = "sparkletree.io" }
]
```

Provision resources (one-time):
- KV: `wrangler kv namespace create pages_kv`
- R2: `wrangler r2 bucket create pages`

Set secrets (recommended via Wrangler so they aren’t committed):
- `wrangler secret put PAGES_HMAC_SECRET`
- `wrangler secret put ADMIN_BEARER_TOKEN` (optional)


## Local Development

- Start the Worker:
  - `wrangler dev`
- Provide local stubs/bindings or use real KV/R2 with your account
- For write operations, calls must be HMAC-signed (see Signing section)
- For reads, hit the configured dev host/port from your browser or curl

Note: When testing end-to-end, prefer invoking the Worker via the control plane MCP tools from the Next.js app to mirror production flows and auth.


## Deployment

- Publish to Cloudflare:
  - `wrangler publish`
- Ensure `routes` in `wrangler.toml` match your domain/zone
- Confirm bindings (KV/R2) are correctly set in the target environment


## API Overview (Conceptual)

Endpoints are grouped as:
- Read (public): Serve tenant pages and assets; fetch metadata for debugging/preview as appropriate
- Write (private): Publish new versions (single HTML or multi-file bundle), flip active pointer (rollback)
- Publishing accepts optional `deleteAfterSeconds` to control automatic page expiration (min 600s, default 86400s, max 7776000s).

Usage notes:
- Write operations require a valid HMAC signature and fresh timestamp
- Read operations are public and cache-friendly
- Exact paths and request/response shapes are intentionally driven from the control plane and may evolve; use the MCP tools and control plane server actions as your integration surface for writes
- Tenant is resolved implicitly by the control plane; the tenant path segment is a UUID derived from the caller’s default tenant.


## Versioning

- Each publish creates a new immutable version
- The Worker maintains an “active” pointer per tenant/slug (slug is a UUID) in KV
- Rollback re-points the active version to any prior publish
- Assets are stored in R2 keyed by version; the active pointer selects which version to serve

### Expiration & Auto-delete
- New publications can include an optional `deleteAfterSeconds` parameter (min 600s, default 86400s, max 7776000s). This TTL applies to the most recent published version.
- While the most recent version remains within its allowed TTL, all previous versions are retained and available (including rollback).
- When the most recent version expires, the page is lazily cleaned up and all endpoints return 410 Gone for that page.
- Version listing (`GET /api/serve?tenant=...&slug=...`) excludes expired pages; after cleanup, it returns an empty list for that page.


## HMAC Request Signing (For Write Calls)

Write calls to this Worker must be signed by the control plane using a shared secret. Best practices:
- Store the secret as Base64 in both control plane and Worker
- Sign a canonical string that includes:
  - HTTP method
  - Request path (and canonical query if applicable)
  - Content hash (e.g., SHA-256 of the body)
  - Timestamp (UNIX seconds or ISO; must be within a short window)
- Provide signature metadata in headers (e.g., `X-Timestamp`, `X-Signature`, and optionally a `X-Key-Id` or similar identifier if you rotate keys)
- The Worker verifies:
  - Signature matches expected HMAC of the canonical string
  - Timestamp is fresh/in-window
  - Optional keyId is recognized/valid if used
  - Constant-time comparison to prevent timing attacks

Example (Node.js, illustrative only):

```ts
import crypto from "crypto";

// secretB64 must match the Worker’s secret (Base64)
const secretB64 = process.env.PAGES_HMAC_SECRET!;
const secret = Buffer.from(secretB64, "base64");

function sha256Hex(buf: Buffer | string) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function hmacHex(key: Buffer, data: string) {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

// Canonical string: adjust fields to match your control plane + worker agreement
function canonicalString(method: string, path: string, bodyHex: string, timestamp: string) {
  return [method.toUpperCase(), path, bodyHex, timestamp].join("\n");
}

export function signRequest(method: string, path: string, body: Buffer | string, timestamp: string, keyId?: string) {
  const bodyHex = sha256Hex(body);
  const canon = canonicalString(method, path, bodyHex, timestamp);
  const sigHex = hmacHex(secret, canon);
  // Include keyId if you support multiple secrets
  const signatureHeader = keyId ? `${keyId}:${sigHex}` : sigHex;
  return {
    headers: {
      "X-Timestamp": timestamp,
      "X-Signature": signatureHeader,
      "Content-SHA256": bodyHex,
      "Content-Type": "application/json",
    },
    body,
  };
}
```

In production, calls should originate from the control plane (Next.js MCP tools, server actions) that encapsulate this signing logic. Direct user calls to write endpoints are not supported.


## Integration With Control Plane

- The Next.js tenant app exposes MCP tools that call this Worker
- Clerk OAuth secures MCP calls on the control plane; HMAC secures writes to this Worker
- Use the control plane for:
  - Publish single HTML or multi-file bundles
  - List versions
  - Rollback
  - Content retrieval for verification
- The control plane maps tenant identities and resolves API keys
- Tenant selection is implicit; the control plane passes a UUID tenant slug derived from user memberships. MCP tools do not accept tenant parameters.


## Directory Structure

- `src/worker.ts`: Worker implementation
- `wrangler.toml`: Cloudflare configuration, bindings, routes
- `.wrangler/`: Wrangler metadata (auto-generated)
- `test.js`: Local utility/testing script (if used)


## Troubleshooting

- 403 on write operations:
  - Check signature/timestamp freshness and Base64 secret consistency
  - Confirm headers are present and correctly spelled
- 404/Not Found when serving:
  - Verify the tenant/slug and that a version is active
  - Ensure R2 objects and KV metadata exist for the requested content
- Local dev issues:
  - Confirm `wrangler dev` is binding KV/R2 correctly
  - Review console logs from the Worker for validation failures


## Notes

- For stability and security, treat this Worker’s write endpoints as private—access them only via the control plane.
- If you rotate secrets, ensure lockstep updates on both control plane and Worker, and optionally leverage a key ID strategy.
- Expand observability via Cloudflare analytics or logs streaming as needed.
