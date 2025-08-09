"use server";

import {
  cf,
  type CfPublishResponse,
  type CfVersionsResponse,
  type CfRollbackResponse,
  type CfContentResponse,
  type FileRecord as CfFileRecord,
} from "@/app/api/cf/client";

/**
 * Server Actions for publishing and managing pages via the Cloudflare Worker.
 * These actions run on the server and sign requests using PAGES_HMAC_SECRET.
 *
 * Environment variables required by the server-only client (cf.*):
 * - PAGES_BASE_URL      (e.g., https://pages.sparkletree.io)
 * - PAGES_HMAC_SECRET   (same base64 string configured in the Worker secrets)
 */

function getBaseUrl(): string {
  const base =
    process.env.PAGES_BASE_URL ||
    process.env.PAGES_BASE_URL_INTERNAL ||
    "https://pages.sparkletree.io";
  return base.replace(/\/+$/, "");
}

function sanitizeTenant(v: string): string {
  return String(v || "")
    .trim()
    .toLowerCase();
}

function sanitizeSlug(v?: string): string {
  const s = String(v ?? "index")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\.\./g, "");
  return s || "index";
}

function computePublicUrl(tenant: string, slug: string, rel?: string): string {
  const base = getBaseUrl();
  if (rel && rel.startsWith("/")) return base + rel;
  const t = encodeURIComponent(tenant);
  const s = encodeURIComponent(slug);
  return `${base}/p/${t}${slug === "index" ? "" : `/${s}`}`;
}

/**
 * Publish a single HTML document (index.html) for a tenant/slug.
 * Accepts either `html` (utf8) or `htmlBase64` (binary-safe); do not pass both.
 */
export async function publishHtmlAction(params: {
  tenant: string;
  slug?: string;
  html?: string;
  htmlBase64?: string;
  contentType?: string; // default "text/html; charset=utf-8"
  htmlTTL?: number; // default 60
}): Promise<CfPublishResponse & { finalUrl: string }> {
  const tenant = sanitizeTenant(params.tenant);
  const slug = sanitizeSlug(params.slug);
  if (!tenant) throw new Error("tenant is required");
  if (!params.html && !params.htmlBase64) {
    throw new Error("Provide html or htmlBase64");
  }

  const res = await cf.publishHtml({
    tenant,
    slug,
    html: params.html,
    htmlBase64: params.htmlBase64,
    contentType: params.contentType ?? "text/html; charset=utf-8",
    htmlTTL: typeof params.htmlTTL === "number" ? params.htmlTTL : 60,
  });

  const finalUrl = computePublicUrl(tenant, slug, res.url);
  return Object.assign(res, { finalUrl });
}

/**
 * Publish a versioned set of files (HTML + assets) for a tenant/slug.
 * Note: Make asset paths relative (e.g., assets/app.css), not absolute (/assets/app.css).
 */
export async function publishFilesAction(params: {
  tenant: string;
  slug?: string;
  files: Array<CfFileRecord>;
  htmlTTL?: number;
}): Promise<CfPublishResponse & { finalUrl: string }> {
  const tenant = sanitizeTenant(params.tenant);
  const slug = sanitizeSlug(params.slug);
  if (!tenant) throw new Error("tenant is required");
  if (!Array.isArray(params.files) || params.files.length === 0) {
    throw new Error("files[] required (include index.html)");
  }

  const res = await cf.publishFiles({
    tenant,
    slug,
    files: params.files,
    htmlTTL: typeof params.htmlTTL === "number" ? params.htmlTTL : 60,
  });

  const finalUrl = computePublicUrl(tenant, slug, res.url);
  return Object.assign(res, { finalUrl });
}

/**
 * List available versions for a tenant/slug (descending).
 */
export async function listVersionsAction(params: {
  tenant: string;
  slug: string;
}): Promise<CfVersionsResponse> {
  const tenant = sanitizeTenant(params.tenant);
  const slug = sanitizeSlug(params.slug);
  if (!tenant || !slug) throw new Error("tenant and slug are required");

  return cf.listVersions({ tenant, slug });
}

/**
 * Roll back pointer to a previous version for a tenant/slug.
 */
export async function rollbackAction(params: {
  tenant: string;
  slug: string;
  version: number;
}): Promise<CfRollbackResponse & { finalUrl: string }> {
  const tenant = sanitizeTenant(params.tenant);
  const slug = sanitizeSlug(params.slug);
  const version = Number(params.version);
  if (!tenant || !slug || !Number.isFinite(version)) {
    throw new Error("tenant, slug and numeric version are required");
  }

  const res = await cf.rollback({ tenant, slug, version });
  const finalUrl = computePublicUrl(
    res.meta.tenant ?? tenant,
    res.meta.slug ?? slug,
  );
  return Object.assign(res, { finalUrl });
}

/**
 * Fetch stored metadata and files by pageId (tenant:slug or tenant:slug:version).
 * Note: This endpoint on the Worker does not require HMAC, but we still sign for parity.
 */
export async function getContentAction(
  pageId: string,
): Promise<CfContentResponse> {
  const id = String(pageId || "").trim();
  if (!id) throw new Error("pageId is required");
  return cf.getContent(id);
}

// Type alias for publishing files (local-only, avoids runtime reference to imported types)
export type PublishFileRecord = {
  path: string;
  content: string;
  contentType?: string;
  encoding?: "utf8" | "base64";
};
