import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export type FileRecord = {
  path: string; // e.g., "index.html", "assets/app.css"
  content: string; // raw text or base64 if you extend later
  contentType?: string; // e.g., "text/html"
  encoding?: "utf8" | "base64"; // when "base64", content is base64-encoded
};

export type PageMeta = {
  objectKey: string; // versioned prefix e.g., "pages/tenant/slug/1700000000000/"
  version: number; // monotonic timestamp
  cacheTTL: number; // seconds
  headers?: Record<string, string>;
  publishedAt: string;
  tenant: string;
  slug: string;
};

export type ApiKeyRecord = {
  id: string;
  tenant: string;
  name?: string;
  createdAt: string;
  disabledAt?: string | null;
  lastUsedAt?: string | null;
  hashedKey: string; // sha256 hex of the raw key
};

type PointerKey = string; // `${tenant}:${slug}`

declare global {
  // Using 'var' to attach to globalThis in Node/Next dev for HMR-safe singletons
  // eslint-disable-next-line no-var
  var __PAGES_POINTER__: Map<PointerKey, PageMeta> | undefined;
  // eslint-disable-next-line no-var
  var __PAGES_VERSIONS__: Map<string, FileRecord[]> | undefined;
  // eslint-disable-next-line no-var
  var __CUSTOM_DOMAINS__:
    | Map<string, { tenant: string; rootSlug: string }>
    | undefined;
}

const pagesPointer =
  globalThis.__PAGES_POINTER__ ??
  (globalThis.__PAGES_POINTER__ = new Map<PointerKey, PageMeta>());

const pagesVersions =
  globalThis.__PAGES_VERSIONS__ ??
  (globalThis.__PAGES_VERSIONS__ = new Map<string, FileRecord[]>()); // key: objectKey

const customDomains =
  globalThis.__CUSTOM_DOMAINS__ ??
  (globalThis.__CUSTOM_DOMAINS__ = new Map<
    string,
    { tenant: string; rootSlug: string }
  >());

// API keys map (dev/local): persisted to disk in DBJson.apiKeys
const apiKeys = new Map<string, ApiKeyRecord>();

// -----------------------------------------------------------------------------
// Persistence layer (dev-only): store pointers and versions on disk so multiple
// workers/bundles share the same state in local development.
// -----------------------------------------------------------------------------

type DBJson = {
  pointers: Record<string, PageMeta>;
  versions: Record<string, FileRecord[]>;
  customDomains: Record<string, { tenant: string; rootSlug: string }>;
  apiKeys: Record<string, ApiKeyRecord>;
};

function getDbPath() {
  const p = process.env.PAGES_DB_FILE;
  return p && p.length
    ? p
    : path.join(os.tmpdir(), "into-the-deep-pages-db.json");
}

function ensureDir(filePath: string) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {}
}

let __initialized = false;

function initFromDisk() {
  if (__initialized) return;
  __initialized = true;
  try {
    const file = getDbPath();
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, "utf8");
      if (raw && raw.trim().length) {
        const parsed = JSON.parse(raw) as DBJson;

        pagesPointer.clear();
        Object.entries(parsed.pointers || {}).forEach(([k, v]) =>
          pagesPointer.set(k as any, v as PageMeta),
        );

        pagesVersions.clear();
        Object.entries(parsed.versions || {}).forEach(([k, v]) =>
          pagesVersions.set(k, v as FileRecord[]),
        );

        customDomains.clear();
        Object.entries(parsed.customDomains || {}).forEach(([k, v]) =>
          customDomains.set(k, v as { tenant: string; rootSlug: string }),
        );

        // Load API keys
        apiKeys.clear();
        Object.entries(parsed.apiKeys || {}).forEach(([k, v]) =>
          apiKeys.set(k, v as ApiKeyRecord),
        );
      }
    }
  } catch {}
}

function persistToDisk() {
  try {
    const file = getDbPath();
    ensureDir(file);
    const data: DBJson = {
      pointers: Object.fromEntries(pagesPointer),
      versions: Object.fromEntries(pagesVersions),
      customDomains: Object.fromEntries(customDomains),
      apiKeys: Object.fromEntries(apiKeys),
    };
    fs.writeFileSync(file, JSON.stringify(data));
    // Update mtime tracker so readers don't immediately re-read unnecessarily
    try {
      __DB_MTIME_MS = fs.statSync(file).mtimeMs;
    } catch {}
  } catch {}
}

// Initialize from disk once per process
initFromDisk();

// Track last known DB mtime to auto-reload when another process writes updates
let __DB_MTIME_MS = 0;
try {
  const file = getDbPath();
  if (fs.existsSync(file)) {
    __DB_MTIME_MS = fs.statSync(file).mtimeMs;
  }
} catch {}

function reloadFromDisk(): void {
  try {
    const file = getDbPath();
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw) return;
    const parsed = JSON.parse(raw) as DBJson;

    pagesPointer.clear();
    Object.entries(parsed.pointers || {}).forEach(([k, v]) =>
      pagesPointer.set(k as any, v as PageMeta),
    );

    pagesVersions.clear();
    Object.entries(parsed.versions || {}).forEach(([k, v]) =>
      pagesVersions.set(k, v as FileRecord[]),
    );

    customDomains.clear();
    Object.entries(parsed.customDomains || {}).forEach(([k, v]) =>
      customDomains.set(k, v as { tenant: string; rootSlug: string }),
    );
  } catch {}
}

function maybeReloadFromDisk(): void {
  try {
    const file = getDbPath();
    if (!fs.existsSync(file)) return;
    const m = fs.statSync(file).mtimeMs;
    if (m > __DB_MTIME_MS) {
      reloadFromDisk();
      __DB_MTIME_MS = m;
    }
  } catch {}
}

function ptrKey(tenant: string, slug: string): PointerKey {
  return `${tenant}:${slug}`;
}

function sanitizeSlug(input: string): string {
  return input.replace(/^\/+/, "").replace(/\.\./g, "");
}

export function mapCustomDomain(
  domain: string,
  tenant: string,
  rootSlug = "index",
) {
  customDomains.set(domain.toLowerCase(), {
    tenant: tenant.toLowerCase(),
    rootSlug,
  });
  persistToDisk();
}

export function lookupCustomDomain(domain: string) {
  return customDomains.get(domain.toLowerCase()) || null;
}

export function publishFiles(params: {
  tenant: string;
  slug: string;
  files: FileRecord[];
  htmlTTL?: number;
}): { meta: PageMeta; url: string } {
  const tenant = params.tenant.toLowerCase();
  const slug = sanitizeSlug(params.slug || "index");
  const version = Date.now();
  const baseKey = `pages/${tenant}/${slug}/${version}/`;

  // Ensure at least an index.html exists
  const hasIndex = params.files.some((f) => f.path === "index.html");
  const files = hasIndex
    ? params.files
    : [
        {
          path: "index.html",
          content: "<!doctype html><title>Empty</title>",
          contentType: "text/html",
        },
        ...params.files,
      ];

  pagesVersions.set(baseKey, files);

  const meta: PageMeta = {
    objectKey: baseKey,
    version,
    cacheTTL: params.htmlTTL ?? 60,
    headers: { "content-type": "text/html; charset=utf-8" },
    publishedAt: new Date().toISOString(),
    tenant,
    slug,
  };
  pagesPointer.set(ptrKey(tenant, slug), meta);
  persistToDisk();

  const url = `/p/${tenant}/${slug === "index" ? "" : slug}`;
  return { meta, url };
}

export function getCurrentMeta(tenant: string, slug: string): PageMeta | null {
  // Ensure we see latest state written by other processes/route-bundles
  maybeReloadFromDisk();
  return (
    pagesPointer.get(ptrKey(tenant.toLowerCase(), sanitizeSlug(slug))) || null
  );
}

export function getFileForRequest(
  meta: PageMeta,
  requestPath: string,
): { body: Uint8Array | string; contentType: string } | null {
  // Ensure we see latest state written by other processes/route-bundles
  maybeReloadFromDisk();
  const files = pagesVersions.get(meta.objectKey);
  if (!files) return null;

  const normalized = sanitizeSlug(requestPath);
  const candidates = normalized
    ? [normalized, normalized.replace(/\/?$/, "/") + "index.html"]
    : ["index.html"];

  const decodeBase64ToUint8 = (b64: string): Uint8Array => {
    // Prefer Node's Buffer when available
    if (typeof (globalThis as any).Buffer !== "undefined") {
      return Uint8Array.from((globalThis as any).Buffer.from(b64, "base64"));
    }
    // Fallback for environments without Buffer
    const binaryString = atob(b64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes;
  };

  for (const c of candidates) {
    const f = files.find((x) => x.path === c);
    if (f) {
      const ct = f.contentType || guessContentType(c);
      if (f.encoding === "base64") {
        return { body: decodeBase64ToUint8(f.content), contentType: ct };
      }
      return { body: f.content, contentType: ct };
    }
  }

  // Fallback: try basename match to accommodate asset paths like "/styles.css"
  // requested without the slug directory segment. If any file in this version
  // ends with the same basename, serve it.
  const baseName = normalized.split("/").pop()!;
  if (baseName) {
    const alt = files.find(
      (x) => x.path === baseName || x.path.endsWith("/" + baseName),
    );
    if (alt) {
      const ct2 = alt.contentType || guessContentType(alt.path);
      if (alt.encoding === "base64") {
        return { body: decodeBase64ToUint8(alt.content), contentType: ct2 };
      }
      return { body: alt.content, contentType: ct2 };
    }
  }

  return null;
}

export function getPageById(
  pageId: string,
): { meta: PageMeta; files: FileRecord[] } | null {
  // Ensure we see latest state written by other processes/route-bundles
  maybeReloadFromDisk();
  // pageId could be "tenant:slug:version" or just "tenant:slug" (current)
  const [tenant, slug, version] = pageId.split(":");
  if (!tenant || !slug) return null;

  const current = getCurrentMeta(tenant, slug);
  if (!current) return null;

  const meta = version
    ? {
        ...current,
        objectKey: `pages/${tenant}/${slug}/${version}/`,
        version: Number(version),
      }
    : current;
  const files = pagesVersions.get(meta.objectKey);
  if (!files) return null;

  return { meta, files };
}

export function listVersions(
  tenant: string,
  slug: string,
): Array<{ version: number; objectKey: string }> {
  maybeReloadFromDisk();
  const t = tenant.toLowerCase();
  const s = sanitizeSlug(slug);
  const prefix = `pages/${t}/${s}/`;
  const versions: Array<{ version: number; objectKey: string }> = [];
  for (const key of pagesVersions.keys()) {
    if (key.startsWith(prefix)) {
      // key format: pages/{tenant}/{slug}/{version}/
      const parts = key.split("/");
      if (parts.length >= 4) {
        const v = Number(parts[3]);
        if (!Number.isNaN(v)) {
          versions.push({ version: v, objectKey: `pages/${t}/${s}/${v}/` });
        }
      }
    }
  }
  versions.sort((a, b) => b.version - a.version);
  return versions;
}

export function setCurrentVersion(
  tenant: string,
  slug: string,
  version: number,
): PageMeta | null {
  maybeReloadFromDisk();
  const t = tenant.toLowerCase();
  const s = sanitizeSlug(slug);
  const objectKey = `pages/${t}/${s}/${version}/`;
  if (!pagesVersions.has(objectKey)) return null;

  const current = getCurrentMeta(t, s);
  const base: PageMeta =
    current ||
    ({
      objectKey,
      version,
      cacheTTL: 60,
      headers: { "content-type": "text/html; charset=utf-8" },
      publishedAt: new Date().toISOString(),
      tenant: t,
      slug: s,
    } as PageMeta);

  const next: PageMeta = {
    ...base,
    objectKey,
    version,
    publishedAt: new Date().toISOString(),
  };
  pagesPointer.set(ptrKey(t, s), next);
  persistToDisk();
  return next;
}

// -------------------------
// Tenants/pointers listing
// -------------------------
export function listTenants(): string[] {
  maybeReloadFromDisk();
  const tenants = new Set<string>();
  for (const meta of pagesPointer.values()) tenants.add(meta.tenant);
  // Fallback: derive from versions if pointers is empty
  if (tenants.size === 0) {
    for (const key of pagesVersions.keys()) {
      const parts = key.split("/");
      if (parts.length >= 3) tenants.add(parts[1]);
    }
  }
  return Array.from(tenants).sort();
}

export function listPointers(targetTenant?: string): PageMeta[] {
  maybeReloadFromDisk();
  const out: PageMeta[] = [];
  for (const meta of pagesPointer.values()) {
    if (!targetTenant || meta.tenant === targetTenant.toLowerCase()) {
      out.push(meta);
    }
  }
  // Sort by tenant, then slug
  out.sort((a, b) =>
    a.tenant === b.tenant
      ? a.slug.localeCompare(b.slug)
      : a.tenant.localeCompare(b.tenant),
  );
  return out;
}

// -------------------------
// Admin API keys management
// -------------------------
function randomId(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("hex");
}

async function sha256HexNode(input: string): Promise<string> {
  const h = crypto.createHash("sha256");
  h.update(input);
  return h.digest("hex");
}

// Create and persist an API key for a tenant. Returns the raw key once.
export async function createApiKey(
  tenant: string,
  name?: string,
): Promise<{ id: string; key: string; record: ApiKeyRecord }> {
  maybeReloadFromDisk();
  const t = tenant.toLowerCase();
  const id = `key_${randomId(8)}`;
  const rawKey = `stk_${randomId(24)}`;
  const hashedKey = await sha256HexNode(rawKey);
  const record: ApiKeyRecord = {
    id,
    tenant: t,
    name,
    createdAt: new Date().toISOString(),
    disabledAt: null,
    lastUsedAt: null,
    hashedKey,
  };
  apiKeys.set(id, record);
  persistToDisk();
  return { id, key: rawKey, record };
}

export function listApiKeys(tenant: string): ApiKeyRecord[] {
  maybeReloadFromDisk();
  const t = tenant.toLowerCase();
  const list: ApiKeyRecord[] = [];
  for (const rec of apiKeys.values()) {
    if (rec.tenant === t) list.push(rec);
  }
  // Hide hashedKey in admin UI if needed; we return full record here for control-plane use.
  list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return list;
}

export function revokeApiKey(id: string): boolean {
  maybeReloadFromDisk();
  const rec = apiKeys.get(id);
  if (!rec) return false;
  if (!rec.disabledAt) {
    rec.disabledAt = new Date().toISOString();
    apiKeys.set(id, rec);
    persistToDisk();
  }
  return true;
}

export async function verifyApiKey(
  tenant: string,
  rawKey: string,
): Promise<boolean> {
  maybeReloadFromDisk();
  const t = tenant.toLowerCase();
  const hashed = await sha256HexNode(rawKey);
  for (const rec of apiKeys.values()) {
    if (rec.tenant === t && !rec.disabledAt && rec.hashedKey === hashed) {
      rec.lastUsedAt = new Date().toISOString();
      apiKeys.set(rec.id, rec);
      persistToDisk();
      return true;
    }
  }
  return false;
}

function guessContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".js")) return "application/javascript";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}
