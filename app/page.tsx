"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  publishHtmlAction,
  publishFilesAction,
  listVersionsAction,
  rollbackAction,
  getContentAction,
} from "@/app/actions/pages";

type PublishResponse = {
  ok: boolean;
  pageId: string;
  url: string;
  meta: {
    tenant: string;
    slug: string;
    version: number;
    cacheTTL: number;
    objectKey: string;
    publishedAt: string;
  };
  error?: string;
};

type VersionRow = { version: number; objectKey: string };

export default function Page() {
  // Basic form state
  const [tenant, setTenant] = useState("alice");
  const [slug, setSlug] = useState("index");

  // Authoring state
  const [html, setHtml] = useState<string>(
    '<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8" />\n  <title>Hello</title>\n  <link rel="stylesheet" href="assets/app.css" />\n</head>\n<body>\n  <h1>Hello world</h1>\n  <p>Replace this HTML or use Serve to include assets.</p>\n</body>\n</html>',
  );
  const [css, setCss] = useState<string>(
    "body{font-family:system-ui,sans-serif} h1{color:tomato}",
  );

  // Result state
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [lastPageId, setLastPageId] = useState<string | null>(null);

  // Versions and content state
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [contentJson, setContentJson] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  // UX state
  const [creating, setCreating] = useState(false);
  const [serving, setServing] = useState(false);
  const [rollingBack, setRollingBack] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pageContentApiLink = useMemo(() => {
    return lastPageId
      ? `/api/content?pageId=${encodeURIComponent(lastPageId)}`
      : null;
  }, [lastPageId]);

  const onCreate = useCallback(async () => {
    setError(null);
    setCreating(true);
    try {
      const data = await publishHtmlAction({
        tenant: tenant.trim(),
        slug: slug.trim() || "index",
        html,
        htmlTTL: 60,
      });
      setLastUrl(data.finalUrl || data.url);
      setLastPageId(data.pageId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unexpected error in Create");
    } finally {
      setCreating(false);
    }
  }, [tenant, slug, html]);

  const onServe = useCallback(async () => {
    setError(null);
    setServing(true);
    try {
      const indexHtml =
        html?.trim() ||
        "<!doctype html><html><head><meta charset='utf-8'><title>Untitled</title></head><body><h1>Untitled</h1></body></html>";

      const files: Array<{
        path: string;
        content: string;
        contentType?: string;
      }> = [
        {
          path: "index.html",
          content: indexHtml,
          contentType: "text/html; charset=utf-8",
        },
      ];
      if (css.trim().length > 0) {
        files.push({
          path: "assets/app.css",
          content: css,
          contentType: "text/css",
        });
      }

      const data = await publishFilesAction({
        tenant: tenant.trim(),
        slug: slug.trim() || "index",
        files,
        htmlTTL: 60,
      });
      setLastUrl(data.finalUrl || data.url);
      setLastPageId(data.pageId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unexpected error in Serve");
    } finally {
      setServing(false);
    }
  }, [tenant, slug, html, css]);

  const onView = useCallback(() => {
    if (lastUrl) window.open(lastUrl, "_blank", "noopener,noreferrer");
  }, [lastUrl]);

  const onLoadVersions = useCallback(async () => {
    try {
      setLoadingVersions(true);
      setError(null);
      const res = await listVersionsAction({
        tenant: tenant.trim(),
        slug: slug.trim() || "index",
      });
      setVersions(res.versions || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load versions");
    } finally {
      setLoadingVersions(false);
    }
  }, [tenant, slug]);

  const onRollback = useCallback(
    async (version: number) => {
      try {
        setRollingBack(version);
        setError(null);
        const res = await rollbackAction({
          tenant: tenant.trim(),
          slug: slug.trim() || "index",
          version,
        });
        // Update lastUrl to reflect current pointer
        setLastUrl(res.finalUrl);
        // Reload versions after rollback
        onLoadVersions();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to rollback");
      } finally {
        setRollingBack(null);
      }
    },
    [tenant, slug, onLoadVersions],
  );

  const onViewContent = useCallback(async () => {
    try {
      setLoadingContent(true);
      setError(null);
      // If we have a last pageId, use that; else compute from tenant/slug and fetch current pointer
      const pid =
        lastPageId || `${tenant.trim()}:${(slug.trim() || "index") as string}`;
      const res = await getContentAction(pid);
      setContentJson(JSON.stringify(res, null, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch content");
    } finally {
      setLoadingContent(false);
    }
  }, [tenant, slug, lastPageId]);

  // Load versions automatically when pageId changes (optional)
  useEffect(() => {
    if (lastPageId) {
      onLoadVersions();
    }
  }, [lastPageId, onLoadVersions]);

  return (
    <div className="relative flex flex-col min-h-screen items-center w-full p-6 md:p-10">
      <div className="w-full max-w-6xl flex flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            SparkleTree Pages — Admin
          </h1>
          <p className="text-sm text-muted-foreground">
            Publish and manage pages via the Cloudflare data plane (signed on
            the server).
          </p>
        </header>
        <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Tenant</label>
            <Input
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              placeholder="tenant (e.g., alice)"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Slug</label>
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="slug (e.g., index, docs)"
              spellCheck={false}
            />
          </div>
          <div className="flex items-end gap-2">
            <Button onClick={onCreate} disabled={creating} className="w-full">
              {creating ? "Creating..." : "Create (HTML only)"}
            </Button>
          </div>
        </section>

        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">index.html</label>
            <Textarea
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              rows={14}
              spellCheck={false}
              className="font-mono text-sm"
              placeholder="<!doctype html>..."
            />
            <p className="text-xs text-muted-foreground">
              Tip: When using Serve, reference assets/app.css from your HTML.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">
              assets/app.css (optional)
            </label>
            <Textarea
              value={css}
              onChange={(e) => setCss(e.target.value)}
              rows={14}
              spellCheck={false}
              className="font-mono text-sm"
              placeholder="/* CSS */"
            />
            <div className="flex items-center gap-2">
              <Button onClick={onServe} disabled={serving} className="w-full">
                {serving ? "Serving..." : "Serve (HTML + assets)"}
              </Button>
              <Button
                variant="secondary"
                onClick={onView}
                disabled={!lastUrl}
                className="whitespace-nowrap"
              >
                View
              </Button>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          {lastUrl && (
            <div className="text-sm">
              <span className="text-muted-foreground">Published at: </span>
              <a
                href={lastUrl}
                target="_blank"
                rel="noreferrer"
                className="underline break-all"
              >
                {lastUrl}
              </a>
            </div>
          )}
          {lastPageId && (
            <div className="text-sm">
              <span className="text-muted-foreground">pageId: </span>
              <code className="px-1 py-0.5 rounded bg-muted">{lastPageId}</code>
              {pageContentApiLink ? (
                <>
                  <span className="mx-2 text-muted-foreground">•</span>
                  <a
                    href={pageContentApiLink}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    View raw content JSON
                  </a>
                </>
              ) : null}
            </div>
          )}
          {error && <div className="text-sm text-red-600">{error}</div>}
        </section>

        {/* Versions & Rollback */}
        <section className="flex flex-col gap-3 rounded border p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Versions</h2>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={onLoadVersions}
                disabled={loadingVersions}
              >
                {loadingVersions ? "Loading..." : "Load versions"}
              </Button>
              <Button
                variant="secondary"
                onClick={onViewContent}
                disabled={loadingContent}
              >
                {loadingContent ? "Loading..." : "View content JSON"}
              </Button>
            </div>
          </div>
          {versions.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No versions to display. Publish something or load versions.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left border-b">
                    <th className="py-2 pr-4">Version</th>
                    <th className="py-2 pr-4">Object Key</th>
                    <th className="py-2 pr-4">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.version} className="border-b">
                      <td className="py-2 pr-4 font-mono">{v.version}</td>
                      <td className="py-2 pr-4 font-mono break-all">
                        {v.objectKey}
                      </td>
                      <td className="py-2 pr-4">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={rollingBack === v.version}
                          onClick={() => onRollback(v.version)}
                        >
                          {rollingBack === v.version
                            ? "Rolling back..."
                            : "Rollback to this"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {contentJson && (
            <div className="mt-3">
              <label className="text-sm font-medium">
                Content JSON (current pageId or tenant:slug)
              </label>
              <pre className="mt-2 max-h-64 overflow-auto text-xs bg-muted p-3 rounded">
                {contentJson}
              </pre>
            </div>
          )}
        </section>

        <footer className="pt-2 text-xs text-muted-foreground">
          All server calls are HMAC-signed on the server and published to the
          Cloudflare data plane. Enjoy instant, versioned edge pages.
        </footer>
      </div>
    </div>
  );
}
