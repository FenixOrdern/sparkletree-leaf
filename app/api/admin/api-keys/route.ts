import { checkBearerAuthIfConfigured } from "@/app/actions/check-bearer";
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyRecord,
} from "@/lib/store";

export const runtime = "nodejs";

type ListOk = {
  ok: true;
  action: "list";
  tenant: string;
  keys: Array<
    Pick<
      ApiKeyRecord,
      "id" | "tenant" | "name" | "createdAt" | "disabledAt" | "lastUsedAt"
    >
  >;
};

type CreateOk = {
  ok: true;
  action: "create";
  tenant: string;
  id: string;
  key: string; // raw key returned once
  record: Omit<ApiKeyRecord, "hashedKey">;
};

type RevokeOk = {
  ok: true;
  action: "revoke";
  id: string;
  revoked: boolean;
};

type Err = { ok: false; error: string };

// Optional bearer auth:
// - Set ADMIN_BEARER_TOKEN in the environment to require Authorization: Bearer <token>.
// - If ADMIN_BEARER_TOKEN is unset/empty, this endpoint is open (dev-friendly).

function json(
  data: ListOk | CreateOk | RevokeOk | Err,
  status = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// GET /api/admin/api-keys?tenant=...
// Lists API keys for a tenant (no raw secrets, only metadata).
export async function GET(request: Request) {
  const authErr = checkBearerAuthIfConfigured(request);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const tenant = (url.searchParams.get("tenant") || "").trim();
  if (!tenant) {
    return json(
      { ok: false, error: "Missing required query param: tenant" },
      400,
    );
  }

  try {
    const records = listApiKeys(tenant);
    const keys = records.map((r) => ({
      id: r.id,
      tenant: r.tenant,
      name: r.name,
      createdAt: r.createdAt,
      disabledAt: r.disabledAt ?? null,
      lastUsedAt: r.lastUsedAt ?? null,
    }));
    return json({ ok: true, action: "list", tenant, keys });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal Server Error";
    return json({ ok: false, error: msg }, 500);
  }
}

// POST /api/admin/api-keys
// Body: { tenant: string, name?: string }
// Creates a new API key for the tenant and returns the raw key once.
export async function POST(request: Request) {
  const authErr = checkBearerAuthIfConfigured(request);
  if (authErr) return authErr;

  let body: { tenant?: string; name?: string } = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const tenant = (body.tenant || "").trim();
  const name = (body.name || "").trim() || undefined;

  if (!tenant) {
    return json({ ok: false, error: "tenant is required" }, 400);
  }

  try {
    const { id, key, record } = await createApiKey(tenant, name);
    const { hashedKey, ...exposed } = record;
    return new Response(
      JSON.stringify({
        ok: true,
        action: "create",
        tenant: record.tenant,
        id,
        key, // show raw once
        record: exposed,
      } satisfies CreateOk),
      {
        status: 201,
        headers: { "content-type": "application/json" },
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal Server Error";
    return json({ ok: false, error: msg }, 500);
  }
}

// DELETE /api/admin/api-keys?id=...   (or JSON body { id: string })
// Revokes (disables) an API key by id.
export async function DELETE(request: Request) {
  const authErr = checkBearerAuthIfConfigured(request);
  if (authErr) return authErr;

  const url = new URL(request.url);
  let id = (url.searchParams.get("id") || "").trim();

  if (!id) {
    // Try body
    try {
      const b = await request.json();
      if (b && typeof b.id === "string") id = b.id.trim();
    } catch {
      // ignore
    }
  }

  if (!id) {
    return json(
      { ok: false, error: "id is required (query or JSON body)" },
      400,
    );
  }

  try {
    const ok = revokeApiKey(id);
    if (!ok) {
      return json({ ok: false, error: "Key not found" }, 404);
    }
    return json({ ok: true, action: "revoke", id, revoked: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal Server Error";
    return json({ ok: false, error: msg }, 500);
  }
}
