import { publishFiles } from "@/lib/store";
import { verifyHmac } from "@/lib/auth";

export const runtime = "nodejs";

type CreateBody = {
  tenant: string;
  slug?: string;
  html?: string;
  htmlBase64?: string;
  contentType?: string;
  htmlTTL?: number;
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

// HMAC: require signature if secret configured
async function requireHmacIfConfigured(request: Request) {
  const secretConfigured =
    typeof process !== "undefined" &&
    !!process.env?.PAGES_HMAC_SECRET &&
    process.env.PAGES_HMAC_SECRET.trim().length > 0;
  if (!secretConfigured) return null;
  const vr = await verifyHmac(request);
  if (!("ok" in vr) || vr.ok !== true) {
    const msg = (vr as any)?.error || "Unauthorized";
    return new Response(JSON.stringify({ error: `Unauthorized: ${msg}` }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}

// POST /api/create
// Body: { tenant: string, slug?: string, html?: string, htmlBase64?: string, htmlTTL?: number, contentType?: string }
export async function POST(req: Request) {
  const authErr = await requireHmacIfConfigured(req);
  if (authErr) return authErr;
  let body: CreateBody | null = null;

  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const tenant = isNonEmptyString(body?.tenant) ? body!.tenant.trim() : "";
  const slug = isNonEmptyString(body?.slug) ? body!.slug!.trim() : "index";
  const hasHtml = isNonEmptyString(body?.html);
  const hasHtmlB64 = isNonEmptyString(body?.htmlBase64);
  const contentType = isNonEmptyString(body?.contentType)
    ? body!.contentType!
    : "text/html; charset=utf-8";

  if (!tenant) {
    return new Response(JSON.stringify({ error: "tenant is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (!hasHtml && !hasHtmlB64) {
    return new Response(
      JSON.stringify({ error: "html or htmlBase64 is required" }),
      {
        status: 400,
        headers: { "content-type": "application/json" },
      },
    );
  }

  try {
    const { meta, url } = publishFiles({
      tenant,
      slug,
      htmlTTL: typeof body?.htmlTTL === "number" ? body!.htmlTTL : 60,
      files: [
        {
          path: "index.html",
          content: hasHtml ? body!.html! : body!.htmlBase64!,
          contentType,
          encoding: hasHtmlB64 ? "base64" : "utf8",
        },
      ],
    });

    return new Response(
      JSON.stringify({
        ok: true,
        pageId: `${meta.tenant}:${meta.slug}:${meta.version}`,
        url,
        meta,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to publish HTML";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
