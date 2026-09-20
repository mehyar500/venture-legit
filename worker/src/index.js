// legit-api — Cloudflare Worker serving api.legit.mehyar.us
// Routes: sessions, chat (Durable Object), ID upload/extract, checkout,
// payment-status (server-side paid detection ONLY), vault, free state lookup,
// nightly ETL + weekly nudges via cron.

import { LegitSession } from "./session-do.js";
import { createCheckout, fetchPaidStatus } from "./pay.js";
import { generateDocsForSession, vaultDownloadList } from "./docs.js";
import { runNightlyEtl, runWeeklyNudges, sweepPii } from "./etl.js";
import { signUrl, verifyUrl } from "./sign.js";

export { LegitSession };

const ALLOWED_ORIGINS = new Set(["https://legit.mehyar.us", "https://www.legit.mehyar.us"]);
const JH = { "Content-Type": "application/json" };
const j = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: JH });

function corsHeaders(req) {
  const origin = req.headers.get("Origin");
  const h = {};
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Vary"] = "Origin";
  }
  return h;
}

async function getSession(env, session_id, token) {
  if (!session_id || !token) return null;
  const row = await env.LEGIT_DB.prepare(
    "SELECT session_id, token, stage, paid FROM sessions WHERE session_id = ?"
  ).bind(session_id).first();
  if (!row || row.token !== token) return null;
  return row;
}

function doStub(env, session_id) {
  const id = env.LEGIT_SESSION.idFromName(session_id);
  return env.LEGIT_SESSION.get(id);
}

// ---------- handlers ----------

async function handleSession(req, env) {
  const session_id = crypto.randomUUID();
  const token = crypto.randomUUID();
  await env.LEGIT_DB.prepare(
    `INSERT INTO sessions (session_id, token, stage, fields_json) VALUES (?, ?, 'discovery', '{}')`
  ).bind(session_id, token).run();
  return j({ session_id, token });
}

async function handleChat(req, env, url) {
  const body = await req.json().catch(() => ({}));
  const { session_id, token, message } = body;
  const sess = await getSession(env, session_id, token);
  if (!sess) return j({ error: "forbidden" }, 403);
  const stub = doStub(env, session_id);
  const r = await stub.fetch("https://do/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id, token, message, host: url.origin }),
  });
  const data = await r.json();
  return j(data, r.status);
}

async function handleUploadUrl(req, env, url) {
  const body = await req.json().catch(() => ({}));
  const { session_id, token, content_type } = body;
  const sess = await getSession(env, session_id, token);
  if (!sess) return j({ error: "forbidden" }, 403);
  const ct = String(content_type || "image/jpeg").toLowerCase();
  if (!ct.startsWith("image/")) return j({ error: "content_type must be an image" }, 400);
  const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
  const key = `id-captures/${session_id}/${crypto.randomUUID()}.${ext}`;
  // 10-minute expiry, worker-signed (HMAC). Semantics of a presigned PUT URL.
  const signed = await signUrl(env, `${url.origin}/api/id-put`, key, 600);
  return j({ url: signed.url, key });
}

async function handleIdPut(req, env, url) {
  const key = url.searchParams.get("key");
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  if (!key || !key.startsWith("id-captures/")) return j({ error: "bad key" }, 400);
  if (!(await verifyUrl(env, key, exp, sig))) return j({ error: "expired or invalid upload URL" }, 403);
  const buf = await req.arrayBuffer();
  if (buf.byteLength > 8 * 1024 * 1024) return j({ error: "image too large (8MB max)" }, 413);
  if (buf.byteLength === 0) return j({ error: "empty upload" }, 400);
  const contentType = req.headers.get("Content-Type") || "image/jpeg";
  await env.LEGIT_DATA.put(key, buf, { httpMetadata: { contentType } });
  return j({ ok: true, key });
}

async function handleIdExtract(req, env) {
  const body = await req.json().catch(() => ({}));
  const { session_id, token, key } = body;
  const sess = await getSession(env, session_id, token);
  if (!sess) return j({ error: "forbidden" }, 403);
  const stub = doStub(env, session_id);
  const r = await stub.fetch("https://do/id-extract", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id, token, key }),
  });
  const data = await r.json();
  return j(data, r.status);
}

async function handleCheckout(req, env) {
  const body = await req.json().catch(() => ({}));
  const { session_id, token, email } = body;
  const sess = await getSession(env, session_id, token);
  if (!sess) return j({ error: "forbidden" }, 403);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return j({ error: "valid email required" }, 400);
  }
  const co = await createCheckout(env, { session_id, email });
  return j({ checkout_url: co.checkout_url, access_token: co.access_token, payment_id: co.payment_id });
}

async function handlePaymentStatus(req, env, ctx, url) {
  const body = await req.json().catch(() => ({}));
  const { session_id, token, access_token } = body;
  const sess = await getSession(env, session_id, token);
  if (!sess) return j({ error: "forbidden" }, 403);
  if (!access_token) return j({ error: "access_token required" }, 400);

  const db = env.LEGIT_DB;
  const row = await db.prepare(
    "SELECT id, status FROM payments WHERE session_id = ? AND access_token = ? ORDER BY id DESC LIMIT 1"
  ).bind(session_id, access_token).first();
  if (!row) return j({ error: "payment not found" }, 404);

  // Server-side truth ONLY. Never trust a client ?paid=1 flag.
  let paid = row.status === "paid";
  if (!paid) {
    const st = await fetchPaidStatus(env, access_token);
    if (st && st.paid === true) {
      paid = true;
      await db.prepare("UPDATE payments SET status = 'paid', paid_at = datetime('now') WHERE id = ?")
        .bind(row.id).run();
      await db.prepare("UPDATE sessions SET paid = 1, stage = 'payment', updated_at = datetime('now') WHERE session_id = ?")
        .bind(session_id).run();
      // Create the filing record (Phase 2 picks it up from here).
      const srow = await db.prepare("SELECT fields_json FROM sessions WHERE session_id = ?")
        .bind(session_id).first();
      const fields = JSON.parse((srow && srow.fields_json) || "{}");
      const fexists = await db.prepare("SELECT id FROM filings WHERE session_id = ?").bind(session_id).first();
      if (!fexists) {
        await db.prepare(
          `INSERT INTO filings (session_id, state_code, business_name, fields_json, status)
           VALUES (?, ?, ?, ?, 'docs_pending')`
        ).bind(session_id, fields.state_code || null, fields.business_name || null, JSON.stringify(fields)).run();
      }
    }
  }

  if (!paid) return j({ paid: false, docs_ready: false, cards: [] });

  const docs = await db.prepare("SELECT id FROM documents WHERE session_id = ?").bind(session_id).all();
  const docCount = (docs.results || []).length;
  if (docCount === 0) {
    // Paid but docs not generated yet (user closed the tab, webhook raced, etc.)
    // — generate now in the background; the frontend polls /api/vault.
    ctx.waitUntil(generateDocsForSession(env, session_id).catch((e) =>
      console.log(`[docs] generation failed for ${session_id}: ${String(e && e.message || e).slice(0, 200)}`)
    ));
    return j({
      paid: true, docs_ready: false,
      cards: [{ type: "progress", stage: "docs", steps: [
        { label: "Payment confirmed", done: true },
        { label: "Generating your 4 documents", done: false },
        { label: "Vault ready", done: false },
      ] }],
    });
  }

  await db.prepare("UPDATE filings SET status = 'docs_generated' WHERE session_id = ? AND status != 'docs_generated'")
    .bind(session_id).run();
  await db.prepare("UPDATE sessions SET stage = 'advisor', updated_at = datetime('now') WHERE session_id = ?")
    .bind(session_id).run();
  const dl = await vaultDownloadList(env, db, session_id, url.origin);
  return j({ paid: true, docs_ready: true, cards: [{ type: "download", docs: dl }] });
}

async function handleVault(req, env, url) {
  const token = url.searchParams.get("token");
  if (!token) return j({ error: "token required" }, 400);
  const row = await env.LEGIT_DB.prepare(
    "SELECT session_id FROM sessions WHERE token = ?"
  ).bind(token).first();
  if (!row) return j({ error: "forbidden" }, 403);
  const docs = await vaultDownloadList(env, env.LEGIT_DB, row.session_id, url.origin);
  return j({ docs });
}

async function handleDl(req, env, url) {
  const key = url.searchParams.get("key");
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  if (!key || !(key.startsWith("vault/") || key.startsWith("id-captures/"))) {
    return j({ error: "bad key" }, 400);
  }
  if (!(await verifyUrl(env, key, exp, sig))) return j({ error: "expired or invalid link" }, 403);
  const obj = await env.LEGIT_DATA.get(key);
  if (!obj) return j({ error: "not found" }, 404);
  const headers = { "Content-Type": obj.httpMetadata?.contentType || "application/pdf" };
  const name = key.split("/").pop();
  headers["Content-Disposition"] = `attachment; filename="${name}"`;
  return new Response(obj.body, { headers });
}

// Free tier: fee/turnaround/annual data, no auth.
async function handleState(env, path) {
  const code = decodeURIComponent(path.slice("/api/state/".length)).toUpperCase().slice(0, 2);
  const row = await env.LEGIT_DB.prepare(
    `SELECT state_code, fee_cents, form_name, turnaround, portal_url, annual_report_fee_cents, franchise_tax
     FROM states WHERE state_code = ?`
  ).bind(code).first();
  if (!row) return j({ error: "state not covered in Phase 1" }, 404);
  return j(row);
}

// ---------- entrypoint ----------

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    const cors = corsHeaders(req);

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const withCors = async (fn) => {
      const r = await fn();
      const h = new Headers(r.headers);
      for (const [k, v] of Object.entries(cors)) h.set(k, v);
      return new Response(r.body, { status: r.status, headers: h });
    };

    try {
      if (path === "/api/health") return withCors(() => j({ ok: true, service: "legit-api" }));
      if (path === "/api/session" && req.method === "POST") return withCors(() => handleSession(req, env));
      if (path === "/api/chat" && req.method === "POST") return withCors(() => handleChat(req, env, url));
      if (path === "/api/upload-url" && req.method === "POST") return withCors(() => handleUploadUrl(req, env, url));
      if (path === "/api/id-put" && req.method === "PUT") return handleIdPut(req, env, url);
      if (path === "/api/id-extract" && req.method === "POST") return withCors(() => handleIdExtract(req, env));
      if (path === "/api/checkout" && req.method === "POST") return withCors(() => handleCheckout(req, env));
      if (path === "/api/payment-status" && req.method === "POST") return withCors(() => handlePaymentStatus(req, env, ctx, url));
      if (path === "/api/vault" && req.method === "GET") return withCors(() => handleVault(req, env, url));
      if (path === "/api/dl") return handleDl(req, env, url);
      if (path.startsWith("/api/state/") && req.method === "GET") return withCors(() => handleState(env, path));
      return withCors(() => j({ error: "not_found" }, 404));
    } catch (e) {
      console.log(`[api] ${path} error: ${String(e && e.message || e).slice(0, 300)}`);
      return withCors(() => j({ error: "internal" }, 500));
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        if (event.cron === "0 6 * * *") {
          // Nightly 2 AM EDT: fee-watch ETL + 30-day PII sweep.
          await runNightlyEtl(env);
          await sweepPii(env);
        } else {
          // Weekly Sunday 9 AM EDT: compliance nudges (internal only, no emails).
          await runWeeklyNudges(env);
        }
      } catch (e) {
        console.log(`[cron] ${event.cron} failed: ${String(e && e.message || e).slice(0, 300)}`);
      }
    })());
  },
};
