export function checkBearerAuthIfConfigured(request: Request): Response | null {
  const configured =
    typeof process !== "undefined" &&
    !!process.env?.ADMIN_BEARER_TOKEN &&
    process.env.ADMIN_BEARER_TOKEN.trim().length > 0;

  // Only enforce in production
  if (!configured || process.env.NODE_ENV !== "production") return null;

  const auth =
    request.headers.get("authorization") ||
    request.headers.get("Authorization");
  const expected = `Bearer ${process.env.ADMIN_BEARER_TOKEN!.trim()}`;

  if (!auth || auth.trim() !== expected) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return null;
}
