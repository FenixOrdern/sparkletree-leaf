import { checkBearerAuthIfConfigured } from "@/app/actions/check-bearer";
import { listTenants, listPointers, listVersions } from "@/lib/store";

export const runtime = "nodejs";

type OkResponse =
  | { ok: true; action: "tenants"; tenants: string[] }
  | {
      ok: true;
      action: "pointers";
      tenant?: string;
      pointers: Array<{
        tenant: string;
        slug: string;
        version: number;
        objectKey: string;
        cacheTTL: number;
        publishedAt: string;
      }>;
    }
  | {
      ok: true;
      action: "versions";
      tenant: string;
      slug: string;
      versions: Array<{ version: number; objectKey: string }>;
    }
  | {
      ok: true;
      action: "summary";
      tenants: string[];
      pointers: Array<{
        tenant: string;
        slug: string;
        version: number;
        objectKey: string;
        cacheTTL: number;
        publishedAt: string;
      }>;
    };

type ErrResponse = { ok: false; error: string };

/**
 * Optional bearer auth:
 * - Set ADMIN_BEARER_TOKEN in the environment to require Authorization: Bearer <token>.
 * - If ADMIN_BEARER_TOKEN is unset/empty, this endpoint is open (dev-friendly).
 */

function json(data: OkResponse | ErrResponse, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * GET /api/admin
 *
 * Query params:
 * - action=tenants      => list all tenants
 * - action=pointers     => list current pointers (optionally filter by tenant)
 *   * tenant=<tenant>
 * - action=versions     => list versions for a tenant/slug (requires both)
 *   * tenant=<tenant>&slug=<slug>
 * - (default) summary   => tenants + pointers (all)
 */
export async function GET(request: Request) {
  const authErr = checkBearerAuthIfConfigured(request);
  if (authErr) return authErr;

  try {
    const url = new URL(request.url);
    const action = (url.searchParams.get("action") || "summary").toLowerCase();
    const tenant = (url.searchParams.get("tenant") || "").trim();
    const slug = (url.searchParams.get("slug") || "").trim();

    if (action === "tenants") {
      const tenants = listTenants();
      return json({ ok: true, action: "tenants", tenants });
    }

    if (action === "pointers") {
      const pointersRaw = listPointers(tenant || undefined);
      const pointers = pointersRaw.map((m) => ({
        tenant: m.tenant,
        slug: m.slug,
        version: m.version,
        objectKey: m.objectKey,
        cacheTTL: m.cacheTTL,
        publishedAt: m.publishedAt,
      }));
      return json({
        ok: true,
        action: "pointers",
        tenant: tenant || undefined,
        pointers,
      });
    }

    if (action === "versions") {
      if (!tenant || !slug) {
        return json(
          {
            ok: false,
            error: "Missing required query params: tenant and slug",
          },
          400,
        );
      }
      const versions = listVersions(tenant, slug);
      return json({ ok: true, action: "versions", tenant, slug, versions });
    }

    // Default: summary (tenants + pointers)
    const tenants = listTenants();
    const pointersRaw = listPointers();
    const pointers = pointersRaw.map((m) => ({
      tenant: m.tenant,
      slug: m.slug,
      version: m.version,
      objectKey: m.objectKey,
      cacheTTL: m.cacheTTL,
      publishedAt: m.publishedAt,
    }));
    return json({ ok: true, action: "summary", tenants, pointers });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal Server Error";
    return json({ ok: false, error: message }, 500);
  }
}
