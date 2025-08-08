# AI Pages — Local Publishing Service

A local-first “pages” publisher built with Next.js (Edge runtime). It lets you publish simple HTML pages (and supporting assets) under stable URLs, with instant versioning and a minimal API that your MCP server can call.

This project is designed for:
- Zero-deploy local development (everything runs in your dev server)
- Simple, robust functionality
- An easy path to promote the same API to an edge/CDN setup (e.g., Cloudflare Workers + R2 + KV)

Contents:
- Quick start
- Core concepts
- API Reference
- Admin dashboard
- Runtime routes
- Data model
- Examples (curl)
- Local dev notes and limitations
- Migration path to edge infra


## Quick start

1) Install dependencies and run dev:
- pnpm dev (or npm/yarn/bun)

2) Open http://localhost:3000
- Use the UI to:
  - Create: publish a single HTML page
  - Serve: publish a set of files (HTML + CSS)
  - View: open the latest published URL

3) Programmatic access (for MCP / scripts)
- POST /api/create to publish HTML only
- POST /api/serve to publish files
- GET /api/content?pageId=tenant:slug[:version] to fetch stored content

4) Admin dashboard
- Open http://localhost:3000/admin for a simple admin UI:
  - Overview: Tenants and current pointers
  - Versions: List versions per tenant/slug and rollback
  - API Keys: Create, list, revoke per-tenant keys
- Optional auth for admin APIs:
  - Set ADMIN_BEARER_TOKEN in env to require Authorization: Bearer <token> for /api/admin/*
  - Set PAGES_HMAC_SECRET to require signed requests for publish and rollback


## Core concepts

- Tenant and Slug
  - Each page is addressed by tenant and slug, e.g., tenant “alice” and slug “index”.
  - A “slug” can be a simple name (“index”, “docs”) and represents a namespace to which you publish a versioned set of files.

- Versioning
  - Every publish creates a new immutable version (timestamp-based).
  - A pointer maps {tenant, slug} → current version (used by the runtime route).
  - You can fetch historical content via GET /api/content?pageId=tenant:slug:version.
  - Admin endpoints and dashboard allow listing versions and rolling back.

- In-memory store (local dev) with persistence
  - Data is primarily kept in memory and persisted to a temp JSON file for coherence across processes.
  - Set PAGES_DB_FILE to persist under a specific path (e.g., into-the-deep/data/pages-db.json).
  - Mirrors a KV + object-store interface to enable later migration to Cloudflare KV (pointers) + R2 (files).

- Runtime selection
  - API routes (`/api/create`, `/api/serve`, `/api/content`) use `export const runtime = "nodejs"` locally so they share the same in-memory store. Running them as Edge isolates can cause `/api/content` to return 404 after publishing because the in-memory pointer store is not shared across isolates.
  - The page-serving route under `/p/{tenant}/{...slug}` can run under nodejs locally for coherence; when moving to edge/CDN, point runtime serving to your Worker.


## API Reference

All endpoints return JSON. In local dev, API routes run under the nodejs runtime so they share the in-memory store; the runtime page route serves content.

1) POST /api/create
- Purpose: publish a single HTML document for a tenant/slug
- Auth: when PAGES_HMAC_SECRET is set, requests must be signed (see HMAC below)
- Body (one of):
  - { tenant: string, slug?: string, html: string, htmlTTL?: number, contentType?: string }
  - { tenant: string, slug?: string, htmlBase64: string, htmlTTL?: number, contentType?: string }  // for binary-safe payloads; set contentType (e.g., text/html; charset=utf-8)
- Response (200): { ok: true, pageId, url, meta }
- Errors: 400 invalid body, 401 unauthorized (when HMAC enabled), 500 internal

2) POST /api/serve
- Purpose: publish a versioned set of files (HTML + assets)
- Auth: when PAGES_HMAC_SECRET is set, requests must be signed (see HMAC below)
- Body:
  - {
      tenant: string,
      slug?: string,
      files: Array<{
        path: string,
        content: string,            // text or base64 depending on encoding
        contentType?: string,
        encoding?: "utf8" | "base64" // default "utf8"
      }>,
      htmlTTL?: number
    }
- Response (200): { ok: true, pageId, url, meta }
- Notes: include an index.html (if omitted, a minimal one is added)

3) GET /api/content?pageId=tenant:slug[:version]
- Purpose: retrieve stored meta and files for a page (current or specific version)
- Response (200): { meta, files }
- Errors: 404 not found

4) GET /api/serve?tenant=...&slug=...
- Purpose: list available versions (descending) for a tenant/slug
- Auth: when PAGES_HMAC_SECRET is set, requests must be signed
- Response (200): { ok: true, tenant, slug, versions: [{ version, objectKey }] }

5) POST /api/serve?action=rollback
- Purpose: rollback pointer to a previous version
- Auth: when PAGES_HMAC_SECRET is set, requests must be signed
- Body: { tenant: string, slug: string, version: number }
- Response (200): { ok: true, pageId, meta }
- Errors: 404 when version not found for tenant/slug

HMAC signing (when PAGES_HMAC_SECRET is configured)
- Headers:
  - x-pages-timestamp: Unix epoch milliseconds as string
  - x-pages-signature: HMAC-SHA256 hex (accepted formats: v1=<hex>, sha256=<hex>, or bare <hex>)
- Canonical string to sign:
  METHOD + "\n" + PATH_WITH_QUERY + "\n" + TIMESTAMP + "\n" + SHA256_HEX(BODY)
  where METHOD is uppercased (e.g., POST), PATH_WITH_QUERY is the request pathname+search (e.g., /api/serve?action=rollback),
  TIMESTAMP is the same as x-pages-timestamp, and BODY is the request body text (empty string if none).
- Tolerance: ±5 minutes clock skew by default.
- Multiple secrets: PAGES_HMAC_SECRET may contain comma-separated keys for rotation. The server will accept any configured key.

1) POST /api/create
- Purpose: publish a single HTML document for a tenant/slug
- Body:
  - tenant (string, required)
  - slug (string, optional; default "index")
  - html (string, required; the full HTML document)
  - htmlTTL (number, optional; default 60; controls Cache-Control max-age)
- Response (200):
  - ok (true)
  - pageId (string) — format: tenant:slug:version
  - url (string) — the runtime URL to view the page
  - meta (object) — metadata of the current pointer (see Data model)
- Errors:
  - 400 for invalid body
  - 500 for internal failures

2) POST /api/serve
- Purpose: publish a versioned set of files (HTML plus assets)
- Body:
  - tenant (string, required)
  - slug (string, optional; default "index")
  - files (array, required): items like:
    - path (string, required) e.g., "index.html", "assets/app.css"
    - content (string, required) — raw text content (see limitations)
    - contentType (string, optional) — inferred if omitted
  - htmlTTL (number, optional; default 60; used as Cache-Control max-age)
- Notes:
  - Ensure one file at path "index.html" is provided. If not, the system adds a minimal one automatically.
- Response (200):
  - ok (true)
  - pageId, url, meta (as above)
- Errors:
  - 400 for invalid body
  - 500 for internal failures

3) GET /api/content?pageId=tenant:slug[:version]
- Purpose: retrieve the stored files and metadata for a page
- Query:
  - pageId (string) in one of two forms:
    - tenant:slug → current pointer
    - tenant:slug:version → specific historical version
- Response (200):
  - meta (PageMeta)
  - files (FileRecord[])
- Errors:
  - 404 when not found


## Runtime routes

1) GET /p/{tenant}
- Serves the current version of the tenant’s “index” slug.
- Equivalent to /p/{tenant}/index.

2) GET /p/{tenant}/{slug}
- Serves the current version of the tenant’s given slug (file resolution defaults to index.html).

3) GET /p/{tenant}/{slug}/{...path}
- Serves files within the current version:
  - Example: /p/alice/docs/assets/app.css
  - Pointer slug is “docs”
  - Request path is “assets/app.css”

Response headers:
- cache-control: public, max-age={meta.cacheTTL}
- x-pages-tenant: {tenant}
- x-pages-slug: {slug}
- x-pages-version: {version}
- content-type: resolved from file path or provided contentType


## Data model

Types (simplified):

- FileRecord
  - path: string — relative path (e.g., "index.html", "assets/app.css")
  - content: string — raw text (see limitations for binary assets)
  - contentType?: string

- PageMeta
  - objectKey: string — versioned prefix: "pages/{tenant}/{slug}/{version}/"
  - version: number — timestamp
  - cacheTTL: number — seconds for Cache-Control
  - headers?: Record<string, string>
  - publishedAt: string — ISO timestamp
  - tenant: string
  - slug: string

In-memory stores (lib/store.ts):
- Map<tenant:slug, PageMeta> — current pointers
- Map<objectKey, FileRecord[]> — versioned file sets

File selection:
- If the requested path is empty or directory-like, it falls back to index.html.


## Examples

Publish a single HTML page (Create):
curl -X POST http://localhost:3000/api/create \
  -H "content-type: application/json" \
  -d '{
    "tenant": "alice",
    "slug": "index",
    "html": "<!doctype html><html><head><meta charset=\"utf-8\"><title>Hello</title></head><body><h1>Hello Alice</h1></body></html>",
    "htmlTTL": 60
  }'

Publish HTML + CSS (Serve):
curl -X POST http://localhost:3000/api/serve \
  -H "content-type: application/json" \
  -d '{
    "tenant": "alice",
    "slug": "docs",
    "files": [
      {
        "path": "index.html",
        "content": "<!doctype html><html><head><meta charset=\"utf-8\"><title>Docs</title><link rel=\"stylesheet\" href=\"/assets/app.css\"></head><body><h1>Docs</h1></body></html>",
        "contentType": "text/html; charset=utf-8"
      },
      {
        "path": "assets/app.css",
        "content": "body { font-family: system-ui, sans-serif } h1 { color: tomato }",
        "contentType": "text/css"
      }
    ],
    "htmlTTL": 60
  }'

View content:
- Browser: http://localhost:3000/p/alice (or http://localhost:3000/p/alice/docs)
- API (latest pointer): http://localhost:3000/api/content?pageId=alice:index
- API (specific version): http://localhost:3000/api/content?pageId=alice:index:1700000000000

Response (Create/Serve success):
{
  "ok": true,
  "pageId": "alice:index:1700000000000",
  "url": "/p/alice",
  "meta": {
    "tenant": "alice",
    "slug": "index",
    "version": 1700000000000,
    "cacheTTL": 60,
    "objectKey": "pages/alice/index/1700000000000/",
    "publishedAt": "2025-01-01T12:00:00.000Z"
  }
}


## Local dev notes and limitations

- Storage and persistence
  - Data is stored in memory and also persisted to a temp JSON file so multiple processes share state in dev.
  - Set PAGES_DB_FILE to a path to persist across restarts (e.g., into-the-deep/data/pages-db.json).

- Assets and binary files
  - API supports both utf8 and base64 content via files[].encoding ("utf8" | "base64").
  - Base64 content is decoded and served as bytes with the appropriate content-type.
  - When referencing assets from HTML, use relative paths (e.g., assets/app.css or ./assets/app.css), not absolute paths (/assets/app.css), because pages are served under a subpath (/p/{tenant}/{slug}) and absolute URLs will 404.

- Caching
  - The runtime sets Cache-Control using the HTML TTL you provide.
  - For local dev, this is advisory only (no CDN).

- Auth
  - Optional bearer auth for admin endpoints: set ADMIN_BEARER_TOKEN to require Authorization: Bearer <token>.
  - Optional HMAC signing for publish and rollback: set PAGES_HMAC_SECRET and sign requests with x-pages-signature and x-pages-timestamp.

- Rollback
  - Exposed via POST /api/serve?action=rollback and admin dashboard (Versions tab).

- Custom domains
  - Internal helpers exist to map custom domains → tenant/rootSlug, but there is no public endpoint for it yet.
  - In production, this is typically handled at the edge (DNS + TLS + mapping).


## Promote to edge (outline)

When you are ready to go global with zero-cold-start performance:

- Control-plane UI/API stays in Next.js (or move logic to a Worker, your choice).
- Replace in-memory store with:
  - Pointers → Cloudflare KV (key: pages:{tenant}:{slug})
  - Versioned files → Cloudflare R2 (prefix pages/{tenant}/{slug}/{version}/)
- Put a Cloudflare Worker in front to:
  - Route by host/path (wildcard subdomains, custom domains)
  - Fetch files from R2
  - Read pointer from KV
  - Set appropriate caching headers
- Use short TTL for HTML (e.g., 30–120s), long TTL + content hashing for assets.
- Optional: automatic certs for custom domains with Cloudflare Custom Hostnames.

This path preserves the same API contract for /api/create and /api/serve, so your MCP integration does not need to change.


## Project structure (high level)

- app/api/create/route.ts — HTML-only publish endpoint (nodejs, HMAC optional, base64 support)
- app/api/serve/route.ts — files-based publish endpoint + versions listing + rollback (nodejs, HMAC optional)
- app/api/content/route.ts — fetch meta and files by pageId (nodejs)
- app/api/admin/route.ts — admin listing: tenants, pointers, versions (bearer optional)
- app/api/admin/api-keys/route.ts — admin API keys CRUD (bearer optional)
- app/admin/page.tsx — admin dashboard UI (overview, versions, API keys)
- app/p/[tenant]/[[...slug]]/route.ts — runtime page/file server (nodejs in dev)
- lib/store.ts — in-memory store with persistence, versioning, pointers, API keys
- lib/auth.ts — HMAC signing/verification helpers
- app/page.tsx — demo UI to exercise the APIs locally


## License

For internal development and evaluation. Add your preferred license here when publishing.