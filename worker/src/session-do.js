// LegitSession Durable Object: one per conversation.
// Holds running context (stage, fields, history), survives the async
// hours-long filing later. Mirrors snapshots to D1 for analytics.

import { runAgentTurn, executeTool } from "./agent.js";
import { signUrl } from "./sign.js";

const ALLOWED_ORIGINS = ["https://legit.mehyar.us", "https://www.legit.mehyar.us"];

// API-boundary stage names. Internal canonical stages are
// discovery|id_upload|forms_review|payment|docs|advisor; the PWA consumes
// the compact enum discovery|id|form|payment|docs|advisor, so we map at the
// boundary (the attach-button flow keys off stage === "id").
function apiStage(stage) {
  if (stage === "id_upload") return "id";
  if (stage === "forms_review") return "form";
  return stage;
}

export class LegitSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.db = env.LEGIT_DB;
  }

  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/chat" && req.method === "POST") {
        const body = await req.json();
        return await this.chat(body);
      }
      if (url.pathname === "/id-extract" && req.method === "POST") {
        const body = await req.json();
        return await this.idExtract(body);
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    } catch (e) {
      return Response.json({ error: "internal", detail: String((e && e.message) || e).slice(0, 300) }, { status: 500 });
    }
  }

  async loadSess(session_id) {
    let sess = await this.state.storage.get("sess");
    if (!sess) {
      const row = await this.db.prepare(
        "SELECT token, stage, fields_json FROM sessions WHERE session_id = ?"
      ).bind(session_id).first();
      if (!row) return null;
      sess = {
        session_id, token: row.token, stage: row.stage || "discovery",
        fields: JSON.parse(row.fields_json || "{}"), history: [], turns: 0,
      };
    } else {
      // Refresh stage/paid from D1: payment confirmation and doc generation
      // update D1 outside the DO, so a warm DO would otherwise serve stale state.
      const row = await this.db.prepare(
        "SELECT stage, paid FROM sessions WHERE session_id = ?"
      ).bind(session_id).first();
      if (row) {
        if (row.stage) sess.stage = row.stage;
        sess.paid = !!row.paid;
      }
    }
    return sess;
  }

  async saveSess(sess) {
    await this.state.storage.put("sess", sess);
    await this.db.prepare(
      "UPDATE sessions SET stage = ?, fields_json = ?, updated_at = datetime('now') WHERE session_id = ?"
    ).bind(sess.stage, JSON.stringify(sess.fields), sess.session_id).run();
    // Mirror snapshots to D1 for analytics (every 5 turns).
    if (sess.turns % 5 === 0) {
      await this.db.prepare(
        "INSERT INTO session_snapshots (session_id, stage, snapshot_json) VALUES (?, ?, ?)"
      ).bind(sess.session_id, sess.stage, JSON.stringify({
        turns: sess.turns, fields: sess.fields, model: sess.model,
        pending_field: sess.pending_field || null,
      })).run();
    }
  }

  checkToken(sess, token) {
    return sess && token && sess.token === token;
  }

  async chat({ session_id, token, message, host }) {
    const sess = await this.loadSess(session_id);
    if (!this.checkToken(sess, token)) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (!message || typeof message !== "string") {
      return Response.json({ error: "message required" }, { status: 400 });
    }
    const ctx = { host: host || "https://api.legit.mehyar.us" };
    let { text, cards } = await runAgentTurn(this.env, this.db, sess, message.slice(0, 2000), ctx);

    // Surface unsurface compliance nudges in the advisor stage (internal only).
    // Folded into the message text because the PWA renders disclaimer cards
    // as a fixed chip without body text.
    if (sess.stage === "advisor" || sess.stage === "docs") {
      const nudges = await this.db.prepare(
        "SELECT id, due_text FROM compliance_nudges WHERE session_id = ? AND surfaced = 0"
      ).bind(session_id).all();
      const rows = nudges.results || [];
      if (rows.length) {
        text += "\n\n📌 " + rows.map((n) => n.due_text).join("\n\n📌 ");
        for (const n of rows) {
          await this.db.prepare("UPDATE compliance_nudges SET surfaced = 1 WHERE id = ?").bind(n.id).run();
        }
      }
    }

    await this.saveSess(sess);
    return Response.json({
      messages: [{ role: "assistant", text }],
      cards,
      stage: apiStage(sess.stage),
    });
  }

  // Vision extraction: legal_name, dob, address -> D1 id_captures.
  // ONLY extracted fields are stored. The raw image lives in R2 under
  // id-captures/ and is auto-deleted after 30 days by the nightly sweep.
  async idExtract({ session_id, token, key }) {
    const sess = await this.loadSess(session_id);
    if (!this.checkToken(sess, token)) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (!key || !key.startsWith(`id-captures/${session_id}/`)) {
      return Response.json({ error: "invalid key" }, { status: 400 });
    }
    const obj = await this.env.LEGIT_DATA.get(key);
    if (!obj) return Response.json({ error: "upload not found" }, { status: 404 });

    const bytes = await obj.arrayBuffer();
    if (bytes.byteLength > 8 * 1024 * 1024) {
      return Response.json({ error: "image too large (8MB max)" }, { status: 413 });
    }
    let bin = "";
    const u8 = new Uint8Array(bytes);
    for (let i = 0; i < u8.length; i += 8192) {
      bin += String.fromCharCode(...u8.subarray(i, i + 8192));
    }
    const b64 = btoa(bin);
    const contentType = obj.httpMetadata?.contentType || "image/jpeg";

    const prompt = `Extract from this ID image as JSON with EXACTLY these keys:
{"legal_name": string, "dob": "YYYY-MM-DD", "street": string, "city": string, "state": string, "zip": string, "confidence": number 0-1}.
Dates on US IDs are MM/DD/YYYY — convert carefully to YYYY-MM-DD. Reply with ONLY the JSON object, no other text.`;
    // Routed through the AI Gateway for cost tracking (vision model verified live 2026-09-20).
    const res = await this.env.AI.run(
      this.env.VISION_MODEL,
      {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${contentType};base64,${b64}` } },
          ],
        }],
        max_tokens: 400,
      },
      { gateway: { id: this.env.AI_GATEWAY_ID || "legit-gateway", skipCache: true } }
    );
    let extracted;
    try {
      const raw = typeof res.response === "string" ? res.response : JSON.stringify(res.response);
      extracted = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
    } catch (e) {
      return Response.json({ error: "could not read the ID photo — please retake it with better lighting" }, { status: 422 });
    }

    // Strict PII minimization: id_captures stores ONLY the extracted fields.
    // The raw image's R2 key is deliberately not persisted — the object is
    // located by prefix in the sweep and auto-expires via bucket lifecycle.
    await this.db.prepare(
      `INSERT INTO id_captures (session_id, legal_name, dob, street, city, state, zip, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      session_id,
      extracted.legal_name || null, extracted.dob || null,
      extracted.street || null, extracted.city || null,
      extracted.state || null, extracted.zip || null,
      extracted.confidence ?? null
    ).run();

    // Fold extracted fields into the conversation; advance the stage.
    const f = sess.fields;
    if (extracted.legal_name) f.legal_name = extracted.legal_name;
    if (extracted.dob) f.dob = extracted.dob;
    if (extracted.street) f.street = extracted.street;
    if (extracted.city) f.city = extracted.city;
    if (extracted.state) f.state = extracted.state;
    if (extracted.zip) f.zip = extracted.zip;
    sess.stage = "forms_review";
    sess.history.push({
      role: "user",
      content: `[system: ID photo processed — extracted legal_name=${extracted.legal_name || "?"}, dob=${extracted.dob || "?"}, address=${[extracted.street, extracted.city, extracted.state, extracted.zip].filter(Boolean).join(", ") || "?"}]`,
    });
    await this.saveSess(sess);

    return Response.json({
      legal_name: extracted.legal_name || null,
      dob: extracted.dob || null,
      address: {
        street: extracted.street || null, city: extracted.city || null,
        state: extracted.state || null, zip: extracted.zip || null,
      },
      confidence: extracted.confidence ?? null,
    });
  }
}
