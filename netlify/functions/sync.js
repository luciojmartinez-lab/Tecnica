import { getStore } from "@netlify/blobs";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type,x-sync-key",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Cache-Control": "no-store",
};

function json(body, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}

async function hashKey(key) {
  const data = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const url = new URL(req.url);
  const body = req.method === "POST" ? await readBody(req) : {};
  const key = (req.headers.get("x-sync-key") || url.searchParams.get("key") || body.key || "").trim();
  if (!key || key.length < 4) return json({ error: "sync_key_required" }, 401);

  const store = getStore({ name: "tecnica-sync", consistency: "strong" });
  const blobKey = `datasets/${await hashKey(key)}.json`;

  if (req.method === "GET") {
    const saved = await store.get(blobKey, { type: "json" });
    if (!saved) return json({ data: null }, 404);
    return json(saved);
  }

  if (req.method === "POST") {
    if (!body.data || typeof body.data !== "object") return json({ error: "invalid_payload" }, 400);
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      updatedAt: body.updatedAt || body.data.updatedAt || new Date().toISOString(),
      data: body.data,
    };
    await store.setJSON(blobKey, payload, {
      metadata: { updatedAt: payload.updatedAt, app: "tecnica" },
    });
    return json({ ok: true, savedAt: payload.savedAt, updatedAt: payload.updatedAt });
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config = {
  path: "/api/sync",
  method: ["GET", "POST", "OPTIONS"],
};
