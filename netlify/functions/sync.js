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

function sharedData(data = {}) {
  return {
    schemaVersion: data.schemaVersion || 1,
    sourceWorkbook: data.sourceWorkbook || "",
    importedAt: data.importedAt || null,
    sourceNotes: Array.isArray(data.sourceNotes) ? data.sourceNotes : [],
    athletes: Array.isArray(data.athletes) ? data.athletes : [],
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    settings: data.settings && typeof data.settings === "object" ? data.settings : {},
    updatedAt: data.updatedAt || new Date().toISOString(),
  };
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function dataHash(data) {
  const text = stableStringify(sharedData(data));
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function summary(data) {
  return {
    athletes: data.athletes.length,
    sessions: data.sessions.length,
    attempts: data.sessions.reduce((total, session) => total + (session.attempts || []).length, 0),
  };
}

function metadata(saved) {
  if (!saved?.data) return { exists: false };
  const data = sharedData(saved.data);
  const hash = saved.dataHash || dataHash(data);
  return {
    exists: true,
    revision: saved.revision || `legacy-${hash}`,
    savedAt: saved.savedAt || saved.updatedAt || data.updatedAt,
    updatedAt: saved.updatedAt || data.updatedAt,
    dataHash: hash,
    summary: saved.summary || summary(data),
  };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const url = new URL(req.url);
  const body = req.method === "POST" ? await readBody(req) : {};
  const key = (req.headers.get("x-sync-key") || url.searchParams.get("key") || body.key || "").trim();
  if (!key || key.length < 4) return json({ error: "sync_key_required" }, 401);

  const store = getStore({ name: "tecnica-sync", consistency: "strong" });
  const blobKey = `datasets/${await hashKey(key)}.json`;
  const saved = await store.get(blobKey, { type: "json" });
  const current = metadata(saved);

  if (req.method === "GET") {
    if (!current.exists) return json(current, 404);
    if (url.searchParams.get("meta") === "1") return json(current);
    return json({ ...current, data: sharedData(saved.data) });
  }

  if (req.method === "POST") {
    if (!body.data || typeof body.data !== "object") return json({ error: "invalid_payload" }, 400);
    const expectedRevision = body.expectedRevision ?? null;
    if (current.exists && expectedRevision !== current.revision) {
      return json({ error: "revision_conflict", ...current }, 409);
    }
    if (!current.exists && expectedRevision) {
      return json({ error: "revision_conflict", ...current }, 409);
    }

    const data = sharedData(body.data);
    data.updatedAt = body.updatedAt || data.updatedAt || new Date().toISOString();
    const payload = {
      version: 2,
      revision: crypto.randomUUID(),
      parentRevision: current.exists ? current.revision : null,
      savedAt: new Date().toISOString(),
      updatedAt: data.updatedAt,
      dataHash: dataHash(data),
      summary: summary(data),
      data,
    };
    await store.setJSON(blobKey, payload, {
      metadata: {
        revision: payload.revision,
        updatedAt: payload.updatedAt,
        savedAt: payload.savedAt,
        dataHash: payload.dataHash,
        app: "tecnica",
      },
    });
    return json({ ok: true, ...metadata(payload) });
  }

  return json({ error: "method_not_allowed" }, 405);
};

export const config = {
  path: "/api/sync",
  method: ["GET", "POST", "OPTIONS"],
};
