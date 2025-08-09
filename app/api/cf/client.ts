import "server-only";

import crypto from "node:crypto";

/**
 * Cloudflare Worker HMAC client (server-only)
 *
 * This module signs requests to your Cloudflare Worker using the same canonical
 * algorithm the worker verifies:
 *   METHOD + "\n" + PATH_WITH_QUERY + "\n" + TIMESTAMP + "\n" + SHA256_HEX(BODY)
 *
 * Environment variables (set in your Next server environment):
 * - PAGES_BASE_URL      (e.g., https://pages.sparkletree.io)
 * - PAGES_HMAC_SECRET   (base64 or ascii string; EXACT same string set in CF secret)
 *
 * Usage:
 *   import { cf } from "@/app/api/cf/client";
 *   await cf.publishHtml({ tenant: "alice", slug: "index", html: "<!doctype html>..." });
 *   await cf.publishFiles({ tenant: "alice", slug: "docs", files: [...] });
 *   await cf.listVersions({ tenant: "alice", slug: "docs" });
 *   await cf.rollback({ tenant: "alice", slug: "docs", version: 1700000000000 });
 *   await cf.getContent("alice:docs");
 */

const BASE_URL = process.env.PAGES_BASE_URL || process.env.PAGES_BASE_URL_INTERNAL || "";
const HMAC_SECRET = process.env.PAGES_HMAC_SECRET || "";

if (!BASE_URL) {
  throw new Error("PAGES_BASE_URL is not set in the server environment");
}
if (!HMAC_SECRET) {
  throw new Error("PAGES_HMAC_SECRET is not set in the server environment");
}

// Types mirrored from the Worker API
export type FileRecord = {
  path: string;
  content: string;                // utf8 text or base64 content depending on 'encoding'
  contentType?: string;
  encoding?: "utf8" | "base64";   // default "utf8"
};

export type PageMeta = {
  objectKey: string;              // pages/{tenant}/{slug}/{version}/
  version: number;
  cacheTTL: number;
  headers?: Record<string, string>;
  publishedAt: string;
  tenant: string;
  slug: string;
};

export type PublishResponse = {
  ok: true;
  pageId: string;                 // tenant:slug:version
  url: string;                    // runtime URL (e.g., /p/{tenant}/{slug?})
  meta: PageMeta;
};

export type VersionsResponse = {
  ok: true;
  tenant: string;
  slug: string;
  versions: Array<{ version: number; objectKey: string }>;
};

export type RollbackResponse = {
  ok: true;
  pageId: string;
  meta: PageMeta;
};

export type ContentResponse = {
  meta: PageMeta;
  files: Array<Pick<FileRecord, "path" | "contentType"> & { content?: string }>;
};

// --------------- HMAC helpers ---------------

function sha256hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function hmacHex(secret: string, data: string): string {
  // IMPORTANT: the Worker treats the secret as a raw string (UTF-8),
  // so we must use the exact same string here (no hex/base64 decoding).
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

function canonicalString(method: string, pathWithQuery: string, timestamp: string, bodySha256Hex: string): string {
  return `${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${bodySha256Hex}`;
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
}

async function signedFetch(
  method: "GET" | "POST",
  pathWithQuery: string,
  bodyObj?: unknown,
): Promise<Response> {
  const url = joinUrl(BASE_URL, pathWithQuery);
  const bodyText = method === "POST" ? JSON.stringify(bodyObj ?? {}) : "";
  const ts = String(Date.now());
  const canon = canonicalString(method, pathWithQuery, ts, sha256hex(bodyText));
  const signature = hmacHex(HMAC_SECRET, canon);

  const res = await fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      "x-pages-timestamp": ts,
      "x-pages-signature": `v1=${signature}`,
    },
    body: method === "POST" ? bodyText : undefined,
    // You can add cache: "no-store" for admin calls if desired
  });

  return res;
}

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`HTTP ${res.status} - Invalid JSON response: ${text}`);
  }
  if (!res.ok) {
    const msg = (data && typeof data === "object" && "error" in data) ? data.error : text || `HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data as T;
}

// --------------- Public API ---------------

/**
 * Publish a single HTML document (index.html) for a tenant/slug.
 * This maps to the Worker endpoint: POST /api/create
 */
async function publishHtml(params: {
  tenant: string;
  slug?: string;
  html?: string;
  htmlBase64?: string;            // alternative binary-safe payload
  contentType?: string;           // default "text/html; charset=utf-8"
  htmlTTL?: number;               // default 60
}): Promise<PublishResponse> {
  const body = {
    tenant: params.tenant,
    slug: params.slug ?? "index",
    html: params.html,
    htmlBase64: params.htmlBase64,
    contentType: params.contentType ?? "text/html; charset=utf-8",
    htmlTTL: typeof params.htmlTTL === "number" ? params.htmlTTL : 60,
  };
  const res = await signedFetch("POST", "/api/create", body);
  return parseJsonOrThrow<PublishResponse>(res);
}

/**
 * Publish a versioned set of files (HTML + assets).
 * This maps to: POST /api/serve
 */
async function publishFiles(params: {
  tenant: string;
  slug?: string;
  files: FileRecord[];            // should include index.html (utf8 or base64)
  htmlTTL?: number;               // default 60
}): Promise<PublishResponse> {
  const body = {
    tenant: params.tenant,
    slug: params.slug ?? "index",
    files: params.files,
    htmlTTL: typeof params.htmlTTL === "number" ? params.htmlTTL : 60,
  };
  const res = await signedFetch("POST", "/api/serve", body);
  return parseJsonOrThrow<PublishResponse>(res);
}

/**
 * List available versions for a tenant/slug.
 * GET /api/serve?tenant=...&slug=... (signed)
 */
async function listVersions(params: { tenant: string; slug: string }): Promise<VersionsResponse> {
  const qp = new URLSearchParams({ tenant: params.tenant, slug: params.slug }).toString();
  const path = `/api/serve?${qp}`;
  const res = await signedFetch("GET", path);
  return parseJsonOrThrow<VersionsResponse>(res);
}

/**
 * Roll back the pointer for a tenant/slug to a previous version.
 * POST /api/serve?action=rollback
 */
async function rollback(params: { tenant: string; slug: string; version: number }): Promise<RollbackResponse> {
  const res = await signedFetch("POST", "/api/serve?action=rollback", {
    tenant: params.tenant,
    slug: params.slug,
    version: params.version,
  });
  return parseJsonOrThrow<RollbackResponse>(res);
}

/**
 * Fetch stored metadata and files by pageId (tenant:slug or tenant:slug:version).
 * GET /api/content?pageId=...
 * Note: This endpoint does not require HMAC in the Worker; we still sign for parity.
 */
async function getContent(pageId: string): Promise<ContentResponse> {
  const qp = new URLSearchParams({ pageId }).toString();
  const res = await signedFetch("GET", `/api/content?${qp}`);
  return parseJsonOrThrow<ContentResponse>(res);
}

export const cf = {
  publishHtml,
  publishFiles,
  listVersions,
  rollback,
  getContent,
};

export type {
  PublishResponse as CfPublishResponse,
  VersionsResponse as CfVersionsResponse,
  RollbackResponse as CfRollbackResponse,
  ContentResponse as CfContentResponse,
};
