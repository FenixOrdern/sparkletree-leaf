"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type PointerMeta = {
  tenant: string;
  slug: string;
  version: number;
  objectKey: string;
  cacheTTL: number;
  publishedAt: string;
};

type SummaryResponse =
  | {
      ok: true;
      action: "summary";
      tenants: string[];
      pointers: PointerMeta[];
    }
  | {
      ok: true;
      action: "tenants";
      tenants: string[];
    }
  | {
      ok: true;
      action: "pointers";
      tenant?: string;
      pointers: PointerMeta[];
    }
  | { ok: false; error: string };

type VersionsResponse =
  | {
      ok: true;
      action: "versions";
      tenant: string;
      slug: string;
      versions: Array<{ version: number; objectKey: string }>;
    }
  | { ok: false; error: string };

type KeysListResponse =
  | {
      ok: true;
      action: "list";
      tenant: string;
      keys: Array<{
        id: string;
        tenant: string;
        name?: string;
        createdAt: string;
        disabledAt?: string | null;
        lastUsedAt?: string | null;
      }>;
    }
  | { ok: false; error: string };

type KeyCreateResponse =
  | {
      ok: true;
      action: "create";
      tenant: string;
      id: string;
      key: string; // raw key, show once
      record: {
        id: string;
        tenant: string;
        name?: string;
        createdAt: string;
        disabledAt?: string | null;
        lastUsedAt?: string | null;
      };
    }
  | { ok: false; error: string };

type KeyRevokeResponse =
  | { ok: true; action: "revoke"; id: string; revoked: boolean }
  | { ok: false; error: string };

type RollbackResponse =
  | {
      ok: true;
      pageId: string;
      meta: {
        tenant: string;
        slug: string;
        version: number;
        objectKey: string;
        cacheTTL: number;
        publishedAt: string;
      };
    }
  | { ok: false; error: string };

// ---- HMAC helpers (browser WebCrypto-first) ----
const te = new TextEncoder();

async function sha256Hex(input: string) {
  if ((globalThis as any).crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", te.encode(input));
    return toHex(new Uint8Array(digest));
  }
  // Very old browsers fallback: not supported
  throw new Error("WebCrypto not available for SHA-256");
}

async function hmacSha256Hex(secret: string, data: string) {
  if ((globalThis as any).crypto?.subtle) {
    const key = await crypto.subtle.importKey(
      "raw",
      te.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, te.encode(data));
    return toHex(new Uint8Array(sig));
  }
  throw new Error("WebCrypto not available for HMAC");
}

function toHex(bytes: Uint8Array) {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function canonicalString(
  method: string,
  pathWithQuery: string,
  timestamp: string,
  bodySha256Hex: string,
) {
  return `${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${bodySha256Hex}`;
}

async function signRequest({
  method,
  url,
  bodyText,
  secret,
}: {
  method: string;
  url: string;
  bodyText: string;
  secret: string;
}) {
  const ts = String(Date.now());
  const u = new URL(url, window.location.origin);
  const pathWithQuery = u.pathname + u.search;
  const bodyHash = await sha256Hex(bodyText);
  const canon = canonicalString(method, pathWithQuery, ts, bodyHash);
  const signature = await hmacSha256Hex(secret, canon);
  return {
    "x-pages-timestamp": ts,
    "x-pages-signature": `v1=${signature}`,
  };
}

// ---- Admin Dashboard ----
export default function AdminPage() {
  // Optional bearer token for /api/admin endpoints
  const [bearerToken, setBearerToken] = useState("");
  const [hmacSecret, setHmacSecret] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Data
  const [tenants, setTenants] = useState<string[]>([]);
  const [pointers, setPointers] = useState<PointerMeta[]>([]);

  // Versions UI
  const [selectedTenant, setSelectedTenant] = useState<string>("");
  const [selectedSlug, setSelectedSlug] = useState<string>("");
  const [versions, setVersions] = useState<
    Array<{ version: number; objectKey: string }>
  >([]);

  // API keys UI
  const [keysTenant, setKeysTenant] = useState<string>("");
  const [keys, setKeys] = useState<
    KeysListResponse extends { ok: true; keys: infer K } ? any[] : any[]
  >([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [lastCreatedKey, setLastCreatedKey] = useState<{
    id: string;
    key: string;
  } | null>(null);

  // Persist UI secrets locally (dev convenience)
  useEffect(() => {
    const s = localStorage.getItem("ADMIN_BEARER_TOKEN") || "";
    const h = localStorage.getItem("PAGES_HMAC_SECRET") || "";
    if (s) setBearerToken(s);
    if (h) setHmacSecret(h);
  }, []);
  const saveSecrets = useCallback(() => {
    localStorage.setItem("ADMIN_BEARER_TOKEN", bearerToken);
    localStorage.setItem("PAGES_HMAC_SECRET", hmacSecret);
    setStatus("Secrets saved locally");
    setTimeout(() => setStatus(null), 1500);
  }, [bearerToken, hmacSecret]);

  const authHeaders = useMemo(() => {
    const h: Record<string, string> = {};
    if (bearerToken.trim()) {
      h["authorization"] = `Bearer ${bearerToken.trim()}`;
    }
    return h;
  }, [bearerToken]);

  // Load summary (tenants + pointers)
  const loadSummary = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin", { headers: authHeaders });
      const json: SummaryResponse = await res.json();
      if (!res.ok || !json || !("ok" in json) || json.ok !== true) {
        throw new Error((json as any)?.error || `HTTP ${res.status}`);
      }
      if ("action" in json && json.action === "summary") {
        setTenants(json.tenants || []);
        setPointers(json.pointers || []);
      } else if ("action" in json && json.action === "tenants") {
        setTenants(json.tenants || []);
      } else if ("action" in json && json.action === "pointers") {
        setPointers(json.pointers || []);
      }
      setStatus("Summary loaded");
      setTimeout(() => setStatus(null), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load summary");
    }
  }, [authHeaders]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  // Load versions for selected tenant/slug
  const loadVersions = useCallback(async () => {
    setError(null);
    setVersions([]);
    if (!selectedTenant || !selectedSlug) {
      setError("Select tenant and slug");
      return;
    }
    try {
      const url = `/api/admin?action=versions&tenant=${encodeURIComponent(
        selectedTenant,
      )}&slug=${encodeURIComponent(selectedSlug)}`;
      const res = await fetch(url, { headers: authHeaders });
      const json: VersionsResponse = await res.json();
      if (!res.ok || !json || !("ok" in json) || json.ok !== true) {
        throw new Error((json as any)?.error || `HTTP ${res.status}`);
      }
      setVersions(
        "versions" in json && Array.isArray(json.versions) ? json.versions : [],
      );
      setStatus("Versions loaded");
      setTimeout(() => setStatus(null), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load versions");
    }
  }, [authHeaders, selectedTenant, selectedSlug]);

  // Rollback to a version (optionally signed with HMAC if provided)
  const rollback = useCallback(
    async (v: number) => {
      setError(null);
      try {
        if (!selectedTenant || !selectedSlug) {
          setError("Select tenant and slug first");
          return;
        }
        const url = `/api/serve?action=rollback`;
        const body = JSON.stringify({
          tenant: selectedTenant,
          slug: selectedSlug,
          version: v,
        });
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (bearerToken.trim()) {
          headers["authorization"] = `Bearer ${bearerToken.trim()}`; // in case your app uses both
        }
        if (hmacSecret.trim()) {
          const sigHeaders = await signRequest({
            method: "POST",
            url,
            bodyText: body,
            secret: hmacSecret.trim(),
          });
          Object.assign(headers, sigHeaders);
        }
        const res = await fetch(url, { method: "POST", headers, body });
        const json: RollbackResponse = await res.json();
        if (!res.ok || !json || (json as any).ok !== true) {
          throw new Error((json as any)?.error || `HTTP ${res.status}`);
        }
        setStatus(`Rolled back to version ${v}`);
        setTimeout(() => setStatus(null), 1500);
        // Refresh pointers and versions
        loadSummary();
        loadVersions();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to rollback");
      }
    },
    [
      bearerToken,
      hmacSecret,
      loadSummary,
      loadVersions,
      selectedSlug,
      selectedTenant,
    ],
  );

  // Keys: list, create, revoke
  const loadKeys = useCallback(async () => {
    setError(null);
    setKeys([]);
    setLastCreatedKey(null);
    if (!keysTenant) {
      setError("Choose a tenant to list API keys");
      return;
    }
    try {
      const url = `/api/admin/api-keys?tenant=${encodeURIComponent(keysTenant)}`;
      const res = await fetch(url, { headers: authHeaders });
      const json: KeysListResponse = await res.json();
      if (!res.ok || !json || !("ok" in json) || json.ok !== true) {
        throw new Error((json as any)?.error || `HTTP ${res.status}`);
      }
      setKeys("keys" in json && Array.isArray(json.keys) ? json.keys : []);
      setStatus("API keys loaded");
      setTimeout(() => setStatus(null), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load keys");
    }
  }, [authHeaders, keysTenant]);

  const createKey = useCallback(async () => {
    setError(null);
    setLastCreatedKey(null);
    if (!keysTenant) {
      setError("Choose a tenant to create a key");
      return;
    }
    try {
      const res = await fetch("/api/admin/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify({
          tenant: keysTenant,
          name: newKeyName || undefined,
        }),
      });
      const json: KeyCreateResponse = await res.json();
      if (!res.ok || !json || !("ok" in json) || json.ok !== true) {
        throw new Error((json as any)?.error || `HTTP ${res.status}`);
      }
      if ("id" in json && "key" in json) {
        setLastCreatedKey({ id: json.id, key: json.key });
      }
      setNewKeyName("");
      loadKeys();
      setStatus("API key created");
      setTimeout(() => setStatus(null), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create key");
    }
  }, [authHeaders, keysTenant, newKeyName, loadKeys]);

  const revokeKey = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const url = `/api/admin/api-keys?id=${encodeURIComponent(id)}`;
        const res = await fetch(url, {
          method: "DELETE",
          headers: authHeaders,
        });
        const json: KeyRevokeResponse = await res.json();
        if (!res.ok || !json || (json as any).ok !== true) {
          throw new Error((json as any)?.error || `HTTP ${res.status}`);
        }
        setStatus(`API key revoked: ${id}`);
        setTimeout(() => setStatus(null), 1200);
        loadKeys();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to revoke key");
      }
    },
    [authHeaders, loadKeys],
  );

  // Derived options
  const slugsForSelectedTenant = useMemo(() => {
    return Array.from(
      new Set(
        pointers.filter((p) => p.tenant === selectedTenant).map((p) => p.slug),
      ),
    ).sort();
  }, [pointers, selectedTenant]);

  return (
    <div className="mx-auto max-w-6xl p-6 flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Admin Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          View tenants, published pointers, versions, and manage API keys.
          Optional: Add bearer token (for /api/admin) and HMAC secret (for
          signed rollback/publish).
        </p>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium">Bearer token (optional)</label>
          <Input
            value={bearerToken}
            onChange={(e) => setBearerToken(e.target.value)}
            placeholder="ADMIN_BEARER_TOKEN"
            spellCheck={false}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium">HMAC secret (optional)</label>
          <Input
            value={hmacSecret}
            onChange={(e) => setHmacSecret(e.target.value)}
            placeholder="PAGES_HMAC_SECRET"
            spellCheck={false}
          />
        </div>

        <div className="flex gap-2">
          <Button onClick={saveSecrets} className="w-full md:w-auto">
            Save secrets
          </Button>
          <Button
            variant="secondary"
            onClick={loadSummary}
            className="w-full md:w-auto"
          >
            Refresh summary
          </Button>
        </div>
      </section>

      {status && <div className="text-sm text-green-600">{status}</div>}
      {error && <div className="text-sm text-red-600">{error}</div>}

      <Tabs defaultValue="overview" className="w-full">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="versions">Versions</TabsTrigger>
          <TabsTrigger value="keys">API Keys</TabsTrigger>
        </TabsList>

        {/* OVERVIEW */}
        <TabsContent value="overview" className="space-y-6">
          <div>
            <h2 className="text-lg font-medium mb-2">Tenants</h2>
            {tenants.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No tenants found yet.
              </div>
            ) : (
              <div className="flex gap-2 flex-wrap">
                {tenants.map((t) => (
                  <span
                    key={t}
                    className="px-2 py-1 text-xs rounded bg-muted cursor-default"
                    title={t}
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-medium">Current Pointers</h2>
              <Button variant="secondary" onClick={loadSummary}>
                Reload
              </Button>
            </div>
            <div className="rounded border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Tenant</TableHead>
                    <TableHead>Slug</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Object Key</TableHead>
                    <TableHead>Published</TableHead>
                    <TableHead>Cache TTL</TableHead>
                    <TableHead>Open</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pointers.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="text-sm text-muted-foreground"
                      >
                        No pointers found.
                      </TableCell>
                    </TableRow>
                  ) : (
                    pointers.map((p) => (
                      <TableRow key={`${p.tenant}:${p.slug}`}>
                        <TableCell className="font-mono">{p.tenant}</TableCell>
                        <TableCell className="font-mono">{p.slug}</TableCell>
                        <TableCell className="font-mono">{p.version}</TableCell>
                        <TableCell className="font-mono">
                          {p.objectKey}
                        </TableCell>
                        <TableCell className="text-sm">
                          {new Date(p.publishedAt).toLocaleString()}
                        </TableCell>
                        <TableCell className="font-mono">
                          {p.cacheTTL}s
                        </TableCell>
                        <TableCell>
                          <a
                            className="text-blue-600 underline"
                            href={`/p/${encodeURIComponent(p.tenant)}${
                              p.slug === "index"
                                ? ""
                                : `/${encodeURIComponent(p.slug)}`
                            }`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            View
                          </a>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </TabsContent>

        {/* VERSIONS */}
        <TabsContent value="versions" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Tenant</label>
              <Input
                value={selectedTenant}
                onChange={(e) => {
                  setSelectedTenant(e.target.value);
                  setSelectedSlug(""); // reset slug on tenant change
                }}
                placeholder="tenant"
                list="tenant-options"
              />
              <datalist id="tenant-options">
                {tenants.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Slug</label>
              <Input
                value={selectedSlug}
                onChange={(e) => setSelectedSlug(e.target.value)}
                placeholder="slug"
                list="slug-options"
              />
              <datalist id="slug-options">
                {slugsForSelectedTenant.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div className="flex gap-2">
              <Button onClick={loadVersions} className="w-full md:w-auto">
                Load versions
              </Button>
              <Button
                variant="secondary"
                onClick={loadSummary}
                className="w-full md:w-auto"
              >
                Refresh pointers
              </Button>
            </div>
          </div>

          <div className="rounded border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Object Key</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="text-sm text-muted-foreground"
                    >
                      No versions loaded.
                    </TableCell>
                  </TableRow>
                ) : (
                  versions.map((v) => (
                    <TableRow key={v.objectKey}>
                      <TableCell className="font-mono">{v.version}</TableCell>
                      <TableCell className="font-mono">{v.objectKey}</TableCell>
                      <TableCell>
                        <Button size="sm" onClick={() => rollback(v.version)}>
                          Rollback to this
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        {/* API KEYS */}
        <TabsContent value="keys" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Tenant</label>
              <Input
                value={keysTenant}
                onChange={(e) => setKeysTenant(e.target.value)}
                placeholder="tenant"
                list="tenant-options-keys"
              />
              <datalist id="tenant-options-keys">
                {tenants.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>
            <div className="flex gap-2">
              <Button onClick={loadKeys} className="w-full md:w-auto">
                Load keys
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">
                New key name (optional)
              </label>
              <Input
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="My first key"
                spellCheck={false}
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={createKey} className="w-full md:w-auto">
                Create API key
              </Button>
            </div>
          </div>

          {lastCreatedKey && (
            <div className="text-sm p-3 rounded border bg-muted/50">
              <div className="font-medium">New API key created</div>
              <div className="text-muted-foreground">
                This is the only time the raw key is shown. Store it securely.
              </div>
              <div className="mt-1">
                <span className="font-mono">id:</span> {lastCreatedKey.id}
              </div>
              <div className="mt-1 break-all">
                <span className="font-mono">key:</span>{" "}
                <span className="font-mono">{lastCreatedKey.key}</span>
              </div>
            </div>
          )}

          <div className="rounded border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Id</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last Used</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!keys || keys.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="text-sm text-muted-foreground"
                    >
                      No keys listed. Choose a tenant and click Load keys.
                    </TableCell>
                  </TableRow>
                ) : (
                  keys.map((k: any) => (
                    <TableRow key={k.id}>
                      <TableCell className="font-mono">{k.id}</TableCell>
                      <TableCell>{k.name || "-"}</TableCell>
                      <TableCell className="text-sm">
                        {k.createdAt
                          ? new Date(k.createdAt).toLocaleString()
                          : "-"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {k.lastUsedAt
                          ? new Date(k.lastUsedAt).toLocaleString()
                          : "-"}
                      </TableCell>
                      <TableCell className="text-sm">
                        {k.disabledAt ? (
                          <span className="text-red-600">revoked</span>
                        ) : (
                          <span className="text-green-600">active</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!!k.disabledAt}
                          onClick={() => revokeKey(k.id)}
                        >
                          Revoke
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
