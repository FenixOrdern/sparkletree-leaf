"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

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

  // UX state
  const [creating, setCreating] = useState(false);
  const [serving, setServing] = useState(false);
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
      const res = await fetch("/api/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenant: tenant.trim(),
          slug: slug.trim() || "index",
          html,
          htmlTTL: 60,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Create failed: ${res.status} ${text}`);
      }
      const data: PublishResponse = await res.json();
      if (!data.ok) {
        throw new Error(data.error || "Create failed");
      }
      setLastUrl(data.url);
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

      const res = await fetch("/api/serve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenant: tenant.trim(),
          slug: slug.trim() || "index",
          files,
          htmlTTL: 60,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Serve failed: ${res.status} ${text}`);
      }
      const data: PublishResponse = await res.json();
      if (!data.ok) {
        throw new Error(data.error || "Serve failed");
      }
      setLastUrl(data.url);
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

  return (
    <div className="relative flex flex-col min-h-screen items-center w-full p-6 md:p-10">
      <div className="w-full max-w-4xl flex flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            AI Pages — Local Publisher
          </h1>
          <p className="text-sm text-muted-foreground">
            Publish simple pages locally. Use Create to publish just HTML, or
            Serve to include multiple files (HTML + CSS).
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
              Tip: When using Serve, you can reference assets/app.css from your
              HTML.
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

        <footer className="pt-4 text-xs text-muted-foreground">
          This is a local-first implementation. Promote the same API to your
          edge runtime later without changing the client.
        </footer>
      </div>
    </div>
  );
}
