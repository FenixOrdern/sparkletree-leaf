/**
 * Minimal Cloudflare Workers type shims to make TS happy in this monorepo context.
 * When building/deploying with Wrangler, the official types are injected automatically.
 * These shims cover only what's used in src/worker.ts. Extend if you need more APIs.
 */

interface KVNamespace {
  get(key: string, options?: { type?: "text" | "json" | "arrayBuffer" }): Promise<string | ArrayBuffer | any | null>;
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: {
      expiration?: number;
      expirationTtl?: number;
      metadata?: unknown;
    }
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list?(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

interface R2HTTPMetadata {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  contentMD5?: string;
  lastModified?: string | Date;
  [key: string]: unknown;
}

interface R2Object {
  key: string;
  size: number;
  etag: string;
  httpEtag?: string;
  customMetadata?: Record<string, unknown>;
  httpMetadata?: R2HTTPMetadata;
  uploaded?: string | Date;
  writeHttpMetadata(headers: Headers): void;
}

interface R2ObjectBody extends R2Object {
  body: ReadableStream<Uint8Array>;
  bodyUsed?: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}

interface R2BucketListResult {
  objects: R2Object[];
  cursor?: string;
  delimitedPrefixes?: string[];
}

interface R2PutOptions {
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, unknown>;
}

interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<R2Object | null>;
  put(key: string, value: ArrayBuffer | ArrayBufferView | string | ReadableStream, options?: R2PutOptions): Promise<R2Object | null>;
  delete(key: string | string[]): Promise<void>;
  list(options?: { prefix?: string; limit?: number; cursor?: string; delimiter?: string }): Promise<R2BucketListResult>;
}
