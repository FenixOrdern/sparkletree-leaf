export interface Env {
  PAGES_KV: KVNamespace;
  PAGES_BUCKET: R2Bucket;
  PAGES_HMAC_SECRET?: string;
  ADMIN_BEARER_TOKEN?: string;
}

type FileRecord = {
  path: string;
  content: string; // utf8 text or base64 depending on encoding
  contentType?: string;
  encoding?: "utf8" | "base64";
};

type PageMeta = {
  objectKey: string; // e.g., pages/tenant/slug/version/
  version: number;
  cacheTTL: number;
  headers?: Record<string, string>;
  publishedAt: string;
  tenant: string;
  slug: string;
};

// ---------- helpers ----------
const te = new TextEncoder();

function sanitizeSlug(input: string): string {
  return input.replace(/^\/+/, "").replace(/\.\./g, "");
}

async function sha256Hex(buf: string | Uint8Array) {
  const data = typeof buf === "string" ? te.encode(buf) : buf;
  // Ensure we always pass an ArrayBuffer to subtle.digest to avoid SharedArrayBuffer/ArrayBufferLike issues
  const ab = data instanceof Uint8Array ? data.buffer.slice(0) : data;
  const hash = await crypto.subtle.digest("SHA-256", ab as ArrayBuffer);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getSecrets(env: Env): string[] {
  const s = env.PAGES_HMAC_SECRET || "";
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseSig(h: string | null): string | null {
  if (!h) return null;
  const parts = h.split(",").map((s) => s.trim());
  for (const p of parts) {
    const m =
      /^v1=([0-9a-fA-F]+)$/.exec(p) ||
      /^sha256=([0-9a-fA-F]+)$/.exec(p) ||
      /^([0-9a-fA-F]+)$/.exec(p);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

function canonString(
  method: string,
  pathWithQuery: string,
  ts: string,
  bodySha256: string,
) {
  return `${method.toUpperCase()}\n${pathWithQuery}\n${ts}\n${bodySha256}`;
}

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(data));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function tscmp(a: string, b: string) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function requireHmac(env: Env, req: Request): Promise<Response | null> {
  const secrets = getSecrets(env);
  if (secrets.length === 0) return null; // not enforced
  const sig = parseSig(req.headers.get("x-pages-signature"));
  const ts = req.headers.get("x-pages-timestamp");
  if (!sig || !ts || !/^\d{10,16}$/.test(ts)) {
    return json({ error: "Unauthorized" }, 401);
  }
  const now = Date.now();
  const skew = Math.abs(now - Number(ts));
  if (!Number.isFinite(Number(ts)) || skew > 5 * 60_000) {
    // 5 min
    return json({ error: "Unauthorized (timestamp)" }, 401);
  }
  const url = new URL(req.url);
  const bodyText = await req.clone().text();
  const bodyHash = await sha256Hex(bodyText);
  const canon = canonString(
    req.method,
    url.pathname + url.search,
    ts,
    bodyHash,
  );
  for (const s of secrets) {
    const expected = await hmacHex(s, canon);
    if (tscmp(sig, expected)) return null;
  }
  return json({ error: "Unauthorized" }, 401);
}

function applySecurityHeaders(h: Headers, isHtml = false) {
  // Core security headers
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  // CSP: default to a permissive policy to allow generated content.
  // You can tighten this later or make it per-tenant configurable.
  const csp = isHtml
    ? "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline' blob:; img-src * data: blob:; font-src 'self' data:; connect-src *; frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
    : "default-src 'none'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";
  h.set("content-security-policy", csp);
}

function json(obj: any, status = 200, cacheControl?: string): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (cacheControl) headers.set("cache-control", cacheControl);
  applySecurityHeaders(headers, false);
  return new Response(JSON.stringify(obj), { status, headers });
}

function guessContentType(p: string): string {
  const lower = p.toLowerCase();
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

// KV keys: pages:{tenant}:{slug}
function kvKey(tenant: string, slug: string) {
  return `pages:${tenant}:${slug}`;
}
function r2Base(tenant: string, slug: string, version: number) {
  return `pages/${tenant}/${slug}/${version}/`;
}

// ---------- API: POST /api/create ----------
async function getClientKey(req: Request): Promise<string> {
  // Use IP if behind CF, else UA+accept as a weak fallback
  const ip =
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for") ||
    "";
  const ua = req.headers.get("user-agent") || "";
  return `${ip}|${ua}`;
}

async function rateLimit(
  env: Env,
  req: Request,
  keyPrefix: string,
  limit = 60,
  windowSec = 60,
): Promise<Response | null> {
  try {
    const client = await getClientKey(req);
    const nowWindow = Math.floor(Date.now() / 1000 / windowSec);
    const key = `rl:${keyPrefix}:${client}:${nowWindow}`;
    const currentRaw = await env.PAGES_KV.get(key);
    const current = currentRaw ? Number(currentRaw) : 0;
    if (current >= limit) {
      const headers = new Headers();
      headers.set("retry-after", String(windowSec));
      applySecurityHeaders(headers, false);
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers,
      });
    }
    // increment and set TTL slightly over window
    await env.PAGES_KV.put(key, String(current + 1), {
      expirationTtl: windowSec + 5,
    } as any);
    return null;
  } catch {
    // fail-open on RL errors
    return null;
  }
}

async function handleCreate(env: Env, req: Request) {
  const authErr = await requireHmac(env, req);
  if (authErr) return authErr;

  const rl = await rateLimit(env, req, "create", 60, 60);
  if (rl) return rl;

  const b = (await req.json().catch(() => null)) as any;
  const tenant = String(b?.tenant || "")
    .trim()
    .toLowerCase();
  const slug = sanitizeSlug(String(b?.slug || "index").trim());
  const html = typeof b?.html === "string" ? b.html : null;
  const htmlBase64 = typeof b?.htmlBase64 === "string" ? b.htmlBase64 : null;
  const contentType =
    typeof b?.contentType === "string"
      ? b.contentType
      : "text/html; charset=utf-8";
  const ttl = typeof b?.htmlTTL === "number" ? b.htmlTTL : 60;
  if (!tenant || (!html && !htmlBase64))
    return json({ error: "tenant and (html|htmlBase64) required" }, 400);

  const version = Date.now();
  const base = r2Base(tenant, slug, version);
  let htmlText =
    typeof htmlBase64 === "string"
      ? new TextDecoder().decode(
          Uint8Array.from(atob(htmlBase64), (c) => c.charCodeAt(0)),
        )
      : (html as string);

  // Normalize absolute asset paths to relative (e.g., /styles.css -> styles.css).
  // Conservatively rewrites href/src that start with a single leading slash and
  // do not include a scheme or double slash.
  if (typeof htmlText === "string" && htmlText.includes("/")) {
    htmlText = htmlText
      // href="/..."; href='/...'
      .replace(/href\s*=\s*"(\/(?!\/|[a-zA-Z]+:)[^"]*)"/g, (_m, p1: string) => {
        const rel = p1.replace(/^\/+/, "");
        return `href="${rel}"`;
      })
      .replace(/href\s*=\s*'(\/(?!\/|[a-zA-Z]+:)[^']*)'/g, (_m, p1: string) => {
        const rel = p1.replace(/^\/+/, "");
        return `href='${rel}'`;
      })
      // src="/..."; src='/...'
      .replace(/src\s*=\s*"(\/(?!\/|[a-zA-Z]+:)[^"]*)"/g, (_m, p1: string) => {
        const rel = p1.replace(/^\/+/, "");
        return `src="${rel}"`;
      })
      .replace(/src\s*=\s*'(\/(?!\/|[a-zA-Z]+:)[^']*)'/g, (_m, p1: string) => {
        const rel = p1.replace(/^\/+/, "");
        return `src='${rel}'`;
      });
  }

  const body = te.encode(htmlText);

  await env.PAGES_BUCKET.put(base + "index.html", body, {
    httpMetadata: { contentType },
  });
  const meta: PageMeta = {
    objectKey: base,
    version,
    cacheTTL: ttl,
    headers: { "content-type": contentType },
    publishedAt: new Date().toISOString(),
    tenant,
    slug,
  };
  await env.PAGES_KV.put(kvKey(tenant, slug), JSON.stringify(meta));
  return json({
    ok: true,
    pageId: `${tenant}:${slug}:${version}`,
    url: `/p/${tenant}/${slug === "index" ? "" : slug}`,
    meta,
  });
}

// ---------- API: POST /api/serve (+rollback), GET /api/serve (list versions) ----------
async function handleServe(env: Env, req: Request) {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const tenant = String(url.searchParams.get("tenant") || "")
      .trim()
      .toLowerCase();
    const slug = sanitizeSlug(
      String(url.searchParams.get("slug") || "").trim(),
    );
    if (!tenant || !slug)
      return json({ error: "tenant and slug are required" }, 400);
    const authErr = await requireHmac(env, req);
    if (authErr) return authErr;
    // List versions by scanning R2 with prefix
    const prefix = `pages/${tenant}/${slug}/`;
    const vers: Array<{ version: number; objectKey: string }> = [];
    let cursor: string | undefined = undefined;
    do {
      const list = await env.PAGES_BUCKET.list({ prefix, cursor });
      for (const obj of list.objects) {
        // Expect keys like pages/tenant/slug/version/file...
        const parts = obj.key.split("/");
        if (parts.length >= 5) {
          const v = Number(parts[3]);
          if (!Number.isNaN(v))
            vers.push({
              version: v,
              objectKey: `pages/${tenant}/${slug}/${v}/`,
            });
        }
      }
      cursor = list.cursor;
    } while (cursor);
    // unique and sort desc
    const seen = new Set<string>();
    const out: Array<{ version: number; objectKey: string }> = [];
    for (const v of vers) {
      const k = `${v.version}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(v);
      }
    }
    out.sort((a, b) => b.version - a.version);
    return json({ ok: true, tenant, slug, versions: out });
  }

  const action = url.searchParams.get("action");
  const authErr = await requireHmac(env, req);
  if (authErr) return authErr;

  if (!action) {
    const rl = await rateLimit(env, req, "serve", 60, 60);
    if (rl) return rl;
  }

  if (action === "rollback") {
    const b = (await req.json().catch(() => null)) as any;
    const tenant = String(b?.tenant || "")
      .trim()
      .toLowerCase();
    const slug = sanitizeSlug(String(b?.slug || "").trim());
    const version = Number(b?.version);
    if (!tenant || !slug || !Number.isFinite(version))
      return json({ error: "tenant, slug, version required" }, 400);
    const objectKey = r2Base(tenant, slug, version);
    // Verify the version exists
    const exists = await env.PAGES_BUCKET.head(objectKey + "index.html");
    if (!exists) return json({ error: "Version not found" }, 404);
    const currMeta: PageMeta = JSON.parse(
      (await env.PAGES_KV.get(kvKey(tenant, slug))) || "{}",
    );
    const meta: PageMeta = {
      ...(currMeta || {
        cacheTTL: 60,
        headers: { "content-type": "text/html; charset=utf-8" },
        tenant,
        slug,
      }),
      objectKey,
      version,
      publishedAt: new Date().toISOString(),
    };
    await env.PAGES_KV.put(kvKey(tenant, slug), JSON.stringify(meta));
    return json({ ok: true, pageId: `${tenant}:${slug}:${version}`, meta });
  }

  // Default: publish files
  const b = (await req.json().catch(() => null)) as any;
  const tenant = String(b?.tenant || "")
    .trim()
    .toLowerCase();
  const slug = sanitizeSlug(String(b?.slug || "index").trim());
  const files = Array.isArray(b?.files) ? (b.files as FileRecord[]) : [];
  const ttl = typeof b?.htmlTTL === "number" ? b.htmlTTL : 60;
  if (!tenant || files.length === 0)
    return json({ error: "tenant and files required" }, 400);

  const version = Date.now();
  const base = r2Base(tenant, slug, version);
  for (const f of files) {
    const p = sanitizeSlug(f.path);
    if (!p) continue;

    // If this is index.html and encoding is utf8 (or unspecified), normalize absolute asset paths.
    if (
      p === "index.html" &&
      (!f.encoding || f.encoding === "utf8") &&
      typeof f.content === "string" &&
      f.content.includes("/")
    ) {
      let txt = f.content as string;
      txt = txt
        // href="/..."; href='/...'
        .replace(
          /href\s*=\s*"(\/(?!\/|[a-zA-Z]+:)[^"]*)"/g,
          (_m, p1: string) => {
            const rel = p1.replace(/^\/+/, "");
            return `href="${rel}"`;
          },
        )
        .replace(
          /href\s*=\s*'(\/(?!\/|[a-zA-Z]+:)[^']*)'/g,
          (_m, p1: string) => {
            const rel = p1.replace(/^\/+/, "");
            return `href='${rel}'`;
          },
        )
        // src="/..."; src='/...'
        .replace(
          /src\s*=\s*"(\/(?!\/|[a-zA-Z]+:)[^"]*)"/g,
          (_m, p1: string) => {
            const rel = p1.replace(/^\/+/, "");
            return `src="${rel}"`;
          },
        )
        .replace(
          /src\s*=\s*'(\/(?!\/|[a-zA-Z]+:)[^']*)'/g,
          (_m, p1: string) => {
            const rel = p1.replace(/^\/+/, "");
            return `src='${rel}'`;
          },
        );
      f.content = txt;
    }

    const content =
      f.encoding === "base64"
        ? Uint8Array.from(atob(f.content), (c) => c.charCodeAt(0))
        : te.encode(f.content);
    await env.PAGES_BUCKET.put(base + p, content, {
      httpMetadata: { contentType: f.contentType },
    });
  }
  const meta: PageMeta = {
    objectKey: base,
    version,
    cacheTTL: ttl,
    headers: { "content-type": "text/html; charset=utf-8" },
    publishedAt: new Date().toISOString(),
    tenant,
    slug,
  };
  await env.PAGES_KV.put(kvKey(tenant, slug), JSON.stringify(meta));
  return json({
    ok: true,
    pageId: `${tenant}:${slug}:${version}`,
    url: `/p/${tenant}/${slug === "index" ? "" : slug}`,
    meta,
  });
}

// ---------- API: GET /api/content?pageId=tenant:slug[:version] ----------
async function handleContent(env: Env, req: Request) {
  const url = new URL(req.url);
  const pageId = String(url.searchParams.get("pageId") || "");
  const [tenant, slug, version] = pageId.split(":");
  if (!tenant || !slug) return json({ error: "Bad pageId" }, 400);
  const t = tenant.toLowerCase();
  const s = sanitizeSlug(slug);
  const currRaw = await env.PAGES_KV.get(kvKey(t, s));
  if (!currRaw) return json({ error: "Not found" }, 404);
  const currMeta: PageMeta = JSON.parse(currRaw);
  const meta = version
    ? {
        ...currMeta,
        objectKey: r2Base(t, s, Number(version)),
        version: Number(version),
      }
    : currMeta;

  // List objects under meta.objectKey
  const files: FileRecord[] = [];
  let cursor: string | undefined = undefined;
  do {
    const list = await env.PAGES_BUCKET.list({
      prefix: meta.objectKey,
      cursor,
    });
    for (const obj of list.objects) {
      const path = obj.key.substring(meta.objectKey.length);
      if (!path) continue;
      const head = await env.PAGES_BUCKET.head(obj.key);
      files.push({
        path,
        content: "",
        contentType: head?.httpMetadata?.contentType || undefined,
      });
    }
    cursor = list.cursor;
  } while (cursor);
  return json({ meta, files }, 200, "public, max-age=30");
}

// ---------- Runtime: GET /p/{tenant}/[[...slug]] ----------
async function handleRuntime(
  env: Env,
  req: Request,
  tenant: string,
  slugSegments: string[],
) {
  const segments = slugSegments
    .filter(Boolean)
    .map((s) => s.replace(/^\/+/, ""));
  let pointerSlug: string | undefined;
  let requestPath = "";

  if (segments.length === 0) {
    pointerSlug = "index";
  } else if (segments.length >= 2) {
    pointerSlug = segments[0];
    requestPath = segments.slice(1).filter(Boolean).join("/");
  } else {
    // length === 1
    const s0 = segments[0];
    const looksLikeAsset =
      s0.includes(".") ||
      ["assets", "static", "css", "js", "img", "images", "media"].includes(
        s0.toLowerCase(),
      );
    if (looksLikeAsset) {
      requestPath = s0;
    } else {
      pointerSlug = s0;
    }
  }

  // Resolve meta
  async function getMeta(t: string, s: string): Promise<PageMeta | null> {
    const raw = await env.PAGES_KV.get(kvKey(t, s));
    return raw ? (JSON.parse(raw) as PageMeta) : null;
  }

  const t = tenant.toLowerCase();
  let meta = pointerSlug ? await getMeta(t, pointerSlug) : null;

  // Asset-only path: try Referer to infer slug
  if (!meta && requestPath) {
    const ref = req.headers.get("referer") || req.headers.get("Referer");
    if (ref) {
      try {
        const u = new URL(ref);
        const parts = u.pathname.split("/").filter(Boolean);
        if (parts.length >= 3 && parts[0] === "p" && parts[1] === t) {
          meta = await getMeta(t, parts[2] || "index");
        }
      } catch {}
    }
  }

  // Last resort: scan known pointers for asset match: try index.html exists and then the asset
  if (!meta && requestPath) {
    // list candidate slugs by scanning KV keys (not super cheap, but acceptable MVP)
    // Instead of listing KV, try a few common slugs or rely on Referer. If needed, attach a small index later.
  }

  if (!meta) return new Response("Not Found", { status: 404 });

  async function r2GetCandidate(objectKey: string, path: string) {
    const key1 = objectKey + path;
    const key2 = objectKey + path.replace(/\/?$/, "/") + "index.html";
    let obj = await env.PAGES_BUCKET.get(key1);
    if (!obj) obj = await env.PAGES_BUCKET.get(key2);
    return obj;
  }

  // Default path is index.html if none
  const pathReq = requestPath || "index.html";
  let obj = await r2GetCandidate(meta.objectKey, pathReq);

  // Basename fallback: styles.css -> any file ending with /styles.css or styles.css
  if (!obj && requestPath) {
    const base = requestPath.split("/").pop() || "";
    if (base) {
      // Try direct (objectKey + base)
      obj = await env.PAGES_BUCKET.get(meta.objectKey + base);
      if (!obj) {
        // List prefix and search fallback (not ideal at scale; can be optimized later)
        const list = await env.PAGES_BUCKET.list({ prefix: meta.objectKey });
        const cand = list.objects.find(
          (o) => o.key.endsWith("/" + base) || o.key.endsWith(base),
        );
        if (cand) obj = await env.PAGES_BUCKET.get(cand.key);
      }
    }
  }

  if (!obj) return json({ error: "Not Found" }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set(
    "content-type",
    headers.get("content-type") || guessContentType(pathReq),
  );
  // HTML gets short TTL; assets respect meta.cacheTTL
  const isHtml =
    (headers.get("content-type") || "").includes("text/html") ||
    pathReq.endsWith("index.html");
  headers.set(
    "cache-control",
    isHtml ? "public, max-age=60" : `public, max-age=${meta.cacheTTL}`,
  );
  headers.set("x-pages-tenant", meta.tenant);
  headers.set("x-pages-slug", meta.slug);
  headers.set("x-pages-version", String(meta.version));
  applySecurityHeaders(headers, isHtml);
  return new Response(obj.body, { status: 200, headers });
}

// ---------- Router ----------
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // APIs
    if (url.pathname === "/api/create" && req.method === "POST")
      return handleCreate(env, req);
    if (url.pathname.startsWith("/api/serve")) return handleServe(env, req);
    if (url.pathname.startsWith("/api/content")) return handleContent(env, req);

    // Runtime: /p/{tenant}/[[...slug]]
    const m = url.pathname.match(/^\/p\/([^/]+)(?:\/(.*))?$/);
    if (m) {
      const tenant = m[1];
      const rest = m[2] ? m[2].split("/") : [];
      return handleRuntime(env, req, tenant, rest);
    }

    // Default
    return new Response("Not Found", { status: 404 });
  },
};
