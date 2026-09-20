// Delay layer: nightly fee-watch ETL, 30-day PII sweep, weekly compliance nudges.
// INTERNAL ONLY — writes to D1 + console. NEVER emails anyone, ever.

import puppeteer from "@cloudflare/puppeteer";

async function sha256hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Pull candidate "$X" amounts appearing near fee-related keywords.
function parseFeeCandidates(text) {
  const out = [];
  const re = /([^.\n]{0,60}(?:filing fee|articles of organization|fee schedule|formation|cost)[^.\n]{0,60}\$[\d,]+(?:\.\d{2})?|\$[\d,]+(?:\.\d{2})?[^.\n]{0,60}(?:filing fee|articles of organization|fee))/gi;
  let m;
  while ((m = re.exec(text)) && out.length < 25) {
    const amt = m[0].match(/\$([\d,]+(?:\.\d{2})?)/);
    if (amt) out.push(Math.round(parseFloat(amt[1].replace(/,/g, "")) * 100));
  }
  return out;
}

// Pull candidate form-name phrases ("Articles of Organization", ...).
function parseFormMentions(text) {
  const out = new Set();
  const re = /(articles of organization|certificate of (?:organization|formation)|application for (?:registration|authority)|statement of information|annual report|biennial statement)/gi;
  let m;
  while ((m = re.exec(text)) && out.size < 10) out.add(m[0].toLowerCase());
  return [...out];
}

export async function runNightlyEtl(env) {
  const db = env.LEGIT_DB;
  const states = await db.prepare(
    "SELECT state_code, portal_url, fee_cents, form_name FROM states"
  ).all();
  const browser = await puppeteer.launch(env.BROWSER);
  const summary = { checked: 0, changed: 0, fee_alerts: 0, errors: [] };
  try {
    for (const st of states.results || []) {
      const code = st.state_code;
      try {
        const page = await browser.newPage();
        await page.goto(st.portal_url, { waitUntil: "domcontentloaded", timeout: 45000 });
        const text = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 60000) : "");
        await page.close();
        const checksum = await sha256hex(text);
        const prev = await db.prepare(
          "SELECT last_checksum, last_fee_seen_cents FROM etl_checks WHERE state_code = ?"
        ).bind(code).first();

        const candidates = parseFeeCandidates(text);
        const seenFee = candidates.length ? candidates.sort((a, b) =>
          candidates.filter((x) => x === a).length - candidates.filter((x) => x === b).length
        ).pop() : null;

        if (!prev || prev.last_checksum !== checksum) {
          summary.changed++;
          await db.prepare(
            `INSERT INTO etl_checks (state_code, portal_url, last_checksum, last_fee_seen_cents)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(state_code) DO UPDATE SET last_checksum = excluded.last_checksum,
               last_fee_seen_cents = excluded.last_fee_seen_cents, checked_at = datetime('now')`
          ).bind(code, st.portal_url, checksum, seenFee).run();
          await db.prepare(
            "INSERT INTO etl_alerts (state_code, alert_type, detail) VALUES (?, 'page_changed', ?)"
          ).bind(code, `Portal page content changed at ${st.portal_url}. Parsed fee candidates (cents): ${JSON.stringify(candidates.slice(0, 8))}. D1 fee: ${st.fee_cents}.`).run();
        }
        if (seenFee !== null && seenFee !== st.fee_cents) {
          summary.fee_alerts++;
          await db.prepare(
            "INSERT INTO etl_alerts (state_code, alert_type, detail) VALUES (?, 'fee_change', ?)"
          ).bind(code, `Parsed fee $${(seenFee / 100).toFixed(2)} differs from D1 fee_cents=${st.fee_cents} for ${st.form_name}. Human review required before any customer sees a fee.`).run();
        }
        // Explicit form-change signal: the page changed but no longer references
        // the expected formation form — the SOS may have renamed/replaced it.
        const mentions = parseFormMentions(text);
        const expected = (st.form_name || "").toLowerCase();
        if (mentions.length && expected && !mentions.some((m) => expected.includes(m) || m.includes(expected))) {
          summary.form_alerts = (summary.form_alerts || 0) + 1;
          await db.prepare(
            "INSERT INTO etl_alerts (state_code, alert_type, detail) VALUES (?, 'form_change', ?)"
          ).bind(code, `Portal page changed and no longer references the expected form "${st.form_name}". Form phrases found: ${mentions.join("; ")}. Human review required before any customer sees a form name.`).run();
        }
        summary.checked++;
      } catch (e) {
        summary.errors.push(`${code}: ${String(e && e.message || e).slice(0, 120)}`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`[etl] nightly fee-watch: ${JSON.stringify(summary)}`);
  return summary;
}

// 30-day auto-delete of raw ID images. Extracted fields in D1 are the retained
// record; the images themselves must not outlive 30 days.
export async function sweepPii(env) {
  const db = env.LEGIT_DB;
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  let deleted = 0, scanned = 0;
  let cursor;
  do {
    const listed = await env.LEGIT_DATA.list({ prefix: "id-captures/", cursor, limit: 500 });
    for (const obj of listed.objects) {
      scanned++;
      if (obj.uploaded.getTime() < cutoff) {
        await env.LEGIT_DATA.delete(obj.key);
        deleted++;
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  await db.prepare("INSERT INTO pii_sweeps (deleted_count, scanned_count) VALUES (?, ?)")
    .bind(deleted, scanned).run();
  console.log(`[pii] sweep: scanned=${scanned} deleted=${deleted} (30-day rule)`);
  return { scanned, deleted };
}

// Weekly: compute per-customer compliance nudges into D1. Surfaced in chat
// by the advisor stage. NO external emails, ever.
export async function runWeeklyNudges(env) {
  const db = env.LEGIT_DB;
  const year = new Date().getUTCFullYear();
  const paid = await db.prepare(
    `SELECT s.session_id, s.fields_json, st.state_code, st.state_name, st.annual_report_due, st.annual_report_fee_cents
     FROM sessions s JOIN states st
       ON json_extract(s.fields_json, '$.state_code') = st.state_code
     WHERE s.paid = 1`
  ).all();
  let created = 0;
  for (const row of paid.results || []) {
    const exists = await db.prepare(
      "SELECT id FROM compliance_nudges WHERE session_id = ? AND nudge_type = 'annual_report' AND period_year = ?"
    ).bind(row.session_id, year).first();
    if (exists) continue;
    const fee = row.annual_report_fee_cents == null ? "no fee" : `$${(row.annual_report_fee_cents / 100).toFixed(2).replace(/\.00$/, "")}`;
    await db.prepare(
      `INSERT INTO compliance_nudges (session_id, state_code, nudge_type, due_text, period_year)
       VALUES (?, ?, 'annual_report', ?, ?)`
    ).bind(
      row.session_id, row.state_code,
      `${row.state_name}: ${row.annual_report_due} (${fee}). File before the deadline to stay in good standing — Legit is not a law firm and this isn't legal advice.`,
      year
    ).run();
    created++;
  }
  console.log(`[nudges] weekly: ${created} new compliance nudges (internal only, surfaced in chat)`);
  return { created };
}
