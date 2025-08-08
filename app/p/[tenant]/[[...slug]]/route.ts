import { getCurrentMeta, getFileForRequest, listPointers } from "@/lib/store";

export const runtime = "nodejs";

// Optional catch-all route to handle both:
// - /p/{tenant}                       → slug omitted (serve "index")
// - /p/{tenant}/{slug}                → slug present
// - /p/{tenant}/{slug}/{...segments}  → nested assets
export async function GET(
  request: Request,
  context: { params: Promise<{ tenant: string; slug?: string[] }> },
) {
  const { tenant, slug = [] } = await context.params;

  // Normalize segments and derive pointer slug + request path
  const segments = slug.filter(Boolean).map((s) => s.replace(/^\/+/, ""));
  let pointerSlug: string | undefined;
  let requestPath = "";

  if (segments.length === 0) {
    // /p/{tenant}
    pointerSlug = "index";
    requestPath = "";
  } else if (segments.length >= 2) {
    // /p/{tenant}/{slug}/...asset
    pointerSlug = segments[0];
    requestPath = segments.slice(1).filter(Boolean).join("/");
  } else {
    // segments.length === 1
    const s0 = segments[0];
    const looksLikeAsset =
      s0.includes(".") ||
      ["assets", "static", "css", "js", "img", "images", "media"].includes(
        s0.toLowerCase(),
      );
    if (looksLikeAsset) {
      // /p/{tenant}/styles.css → infer slug from Referer or search across pointers
      pointerSlug = undefined;
      requestPath = s0;
    } else {
      // /p/{tenant}/{slug}
      pointerSlug = s0;
      requestPath = "";
    }
  }

  // If this is an asset request without an explicit slug in the URL
  // (e.g. /p/{tenant}/styles.css), try to infer the slug from the Referer.
  if (!pointerSlug && requestPath) {
    const referer =
      request.headers.get("referer") || request.headers.get("Referer");
    if (referer) {
      try {
        const refUrl = new URL(referer);
        const parts = refUrl.pathname.split("/").filter(Boolean);
        // Expecting /p/{tenant}/{slug}[/*] -> parts >= 3
        if (parts.length >= 3 && parts[0] === "p" && parts[1] === tenant) {
          pointerSlug = parts[2] || "index";
        }
      } catch {
        // ignore bad referer
      }
    }
  }

  // Resolve pointer for tenant/slug (or infer for asset-only requests)
  let meta = pointerSlug ? getCurrentMeta(tenant, pointerSlug) : null;

  // If we still have no meta and we have an asset path, try to find which slug owns it
  if (!meta && requestPath) {
    const pointers = listPointers(tenant);
    for (const p of pointers) {
      const m = getCurrentMeta(tenant, p.slug);
      if (!m) continue;
      const f = getFileForRequest(m, requestPath);
      if (f) {
        meta = m;
        break;
      }
    }
  }

  if (!meta) {
    return new Response("Not Found", { status: 404 });
  }

  const file = getFileForRequest(meta, requestPath);
  if (!file) {
    return new Response("Not Found", { status: 404 });
  }

  const headers = new Headers();
  headers.set("cache-control", `public, max-age=${meta.cacheTTL}`);
  headers.set("x-pages-tenant", meta.tenant);
  headers.set("x-pages-slug", meta.slug);
  headers.set("x-pages-version", String(meta.version));
  headers.set("content-type", file.contentType);

  // Serve body directly: strings as-is, Uint8Array via Response for Node/Edge compatibility
  if (typeof file.body === "string") {
    return new Response(file.body, { status: 200, headers });
  }
  return new Response(new Uint8Array(file.body), { status: 200, headers });
}
