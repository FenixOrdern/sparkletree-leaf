import { getPageById } from "@/lib/store";

// GET /api/content?pageId=tenant:slug[:version]
export async function GET(req: Request) {
  const pageId = new URL(req.url).searchParams.get("pageId") || "";
  const result = getPageById(pageId);
  if (!result) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const { meta, files } = result;
  return new Response(JSON.stringify({ meta, files }), {
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}
