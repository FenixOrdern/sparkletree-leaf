import {
  publishFiles,
  type FileRecord,
  listVersions,
  setCurrentVersion,
} from "@/lib/store";
import { verifyHmac } from "@/lib/auth";

export const runtime = "nodejs";

type ServeBody = {
  tenant: string;
  slug?: string;
  files: Array<
    Pick<FileRecord, "path" | "content" | "contentType" | "encoding">
  >;
  htmlTTL?: number;
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isFilesArray(v: unknown): v is ServeBody["files"] {
  return (
    Array.isArray(v) &&
    v.every((f) => {
      if (!f || typeof f !== "object") return false;
      const pathOk = isNonEmptyString((f as any).path);
      const contentOk = typeof (f as any).content === "string";
      const enc = (f as any).encoding;
      const encOk = enc === undefined || enc === "utf8" || enc === "base64";
      return pathOk && contentOk && encOk;
    })
  );
}

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

// GET /api/serve?tenant=...&slug=... -> list versions (desc)
export async function GET(request: Request) {
  const url = new URL(request.url);
  const tenant = url.searchParams.get("tenant")?.trim() || "";
  const slug = url.searchParams.get("slug")?.trim() || "";

  if (!tenant || !slug) {
    return new Response(
      JSON.stringify({ error: "tenant and slug are required" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  // Optional: protect listing when HMAC is configured (comment out to expose publicly)
  const authErr = await requireHmacIfConfigured(request);
  if (authErr) return authErr;

  const versions = listVersions(tenant, slug);
  return new Response(JSON.stringify({ ok: true, tenant, slug, versions }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// POST /api/serve
// - Default: publish files (HTML + assets)
// - With ?action=rollback: rollback to a previous version, body: { tenant, slug, version }
export async function POST(request: Request) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");

  // Enforce HMAC when configured
  const authErr = await requireHmacIfConfigured(request);
  if (authErr) return authErr;

  if (action === "rollback") {
    type RollbackBody = { tenant: string; slug: string; version: number };
    let body: RollbackBody | null = null;

    try {
      body = (await request.json()) as RollbackBody;
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const tenant = isNonEmptyString(body?.tenant) ? body!.tenant.trim() : "";
    const slug = isNonEmptyString(body?.slug) ? body!.slug!.trim() : "";
    const version =
      typeof (body as any)?.version === "number"
        ? (body as any).version
        : Number((body as any)?.version);

    if (!tenant || !slug || !Number.isFinite(version)) {
      return new Response(
        JSON.stringify({
          error: "tenant, slug, and numeric version are required",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }

    const meta = setCurrentVersion(tenant, slug, version);
    if (!meta) {
      return new Response(
        JSON.stringify({ error: "Version not found for given tenant/slug" }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        pageId: `${meta.tenant}:${meta.slug}:${meta.version}`,
        meta,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  // Default: publish files
  let body: ServeBody | null = null;

  try {
    body = (await request.json()) as ServeBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const tenant = isNonEmptyString(body?.tenant) ? body!.tenant.trim() : "";
  const slug = isNonEmptyString(body?.slug) ? body!.slug!.trim() : "index";
  const files = isFilesArray(body?.files) ? (body!.files as FileRecord[]) : [];

  if (!tenant) {
    return new Response(JSON.stringify({ error: "tenant is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (files.length === 0) {
    return new Response(JSON.stringify({ error: "files array is required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const { meta, url: pageUrl } = publishFiles({
      tenant,
      slug,
      files,
      htmlTTL: typeof body?.htmlTTL === "number" ? body!.htmlTTL : 60,
    });

    return new Response(
      JSON.stringify({
        ok: true,
        pageId: `${meta.tenant}:${meta.slug}:${meta.version}`,
        url: pageUrl,
        meta,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to publish files";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
