// Document generation: HTML templates -> Browser Rendering /pdf -> R2 vault.
// Every document carries the "not a law firm / not legal advice" footer.

import puppeteer from "@cloudflare/puppeteer";
import { signUrl } from "./sign.js";

const DISCLAIMER_FOOTER = `
<div class="footer">
  Legit is document-preparation software, not a law firm. This document is not legal advice
  and creates no attorney-client relationship. For advice about your specific situation,
  consult a licensed business attorney or CPA.
</div>`;

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const CSS = `
body{font-family:Georgia,serif;color:#1a1a1a;margin:48px;line-height:1.55}
h1{font-size:24px;border-bottom:3px solid #111;padding-bottom:8px}
h2{font-size:17px;margin-top:28px;color:#222}
table{width:100%;border-collapse:collapse;margin:16px 0}
td,th{border:1px solid #999;padding:8px 10px;text-align:left;font-size:14px}
th{background:#f2f2f2;width:38%}
.sig{margin-top:48px;border-top:1px solid #111;width:60%;padding-top:6px}
.footer{margin-top:40px;padding:12px;border:1px solid #999;background:#f7f7f7;font-size:11px;color:#555}
.meta{color:#555;font-size:13px}
ol li{margin-bottom:8px}
.note{background:#fffbe6;border:1px solid #d9c93c;padding:10px 12px;font-size:13px;margin:14px 0}`;

function money(cents) {
  if (cents === null || cents === undefined) return "n/a";
  return "$" + (cents / 100).toFixed(2).replace(/\.00$/, "");
}

function articlesHtml(f, st) {
  return `<!doctype html><html><body>
<h1>${esc(st.form_name)}${st.form_id ? " (" + esc(st.form_id) + ")" : ""}</h1>
<p class="meta">State of ${esc(st.state_name)} &bull; Prepared by Legit on ${esc(new Date().toISOString().slice(0, 10))} from information you confirmed in chat.</p>
${DISCLAIMER_FOOTER}
<h2>Article I — Name</h2>
<p>The name of the limited liability company is <strong>${esc(f.business_name)}</strong>.</p>
<h2>Article II — Registered Agent</h2>
<table>
<tr><th>Registered agent</th><td>${esc(f.registered_agent_name || f.legal_name)}</td></tr>
<tr><th>Registered office street</th><td>${esc(f.street)}</td></tr>
<tr><th>City / State / ZIP</th><td>${esc(f.city)}, ${esc(f.state_code)} ${esc(f.zip)}</td></tr>
</table>
<h2>Article III — Organizer</h2>
<table>
<tr><th>Organizer name</th><td>${esc(f.legal_name)}</td></tr>
<tr><th>Organizer address</th><td>${esc(f.street)}, ${esc(f.city)}, ${esc(f.state_code)} ${esc(f.zip)}</td></tr>
</table>
<h2>Article IV — Management</h2>
<p>The company shall be managed by its ${esc(f.management || "member(s)")} (member-managed).</p>
<h2>Article V — Duration</h2>
<p>The company shall have perpetual duration unless dissolved under applicable law.</p>
<h2>Filing instructions (verified ${esc(st.verified_at || "")})</h2>
<div class="note">File online at <strong>${esc(st.portal_url)}</strong>. State filing fee: <strong>${money(st.fee_cents)}</strong>. Typical turnaround: ${esc(st.turnaround)}</div>
<p class="meta">Registered-agent rule: ${esc(st.registered_agent_rules)}</p>
<div class="sig">Signature of organizer &nbsp;&nbsp; Date</div>
${DISCLAIMER_FOOTER}
</body></html>`;
}

function operatingAgreementHtml(f, st) {
  const multi = (f.members || "").split(",").map((s) => s.trim()).filter(Boolean).length > 1;
  return `<!doctype html><html><body>
<h1>Operating Agreement of ${esc(f.business_name)} LLC</h1>
<p class="meta">A ${esc(st.state_name)} limited liability company &bull; Effective ${esc(new Date().toISOString().slice(0, 10))}</p>
${DISCLAIMER_FOOTER}
<h2>1. Formation</h2>
<p>The members form a limited liability company under the laws of ${esc(st.state_name)}.</p>
<h2>2. Members</h2>
<table><tr><th>Member</th><td>${esc(f.legal_name)}${multi ? " (and additional members as listed in company records)" : " (sole member)"}</td></tr></table>
<h2>3. Management</h2>
<p>The company is member-managed. ${multi ? "Major decisions require a majority of membership interests." : "The sole member has full authority to act for the company."}</p>
<h2>4. Capital contributions</h2>
<p>Initial contributions are recorded in the company's books. No member is required to make additional contributions unless agreed in writing.</p>
<h2>5. Distributions</h2>
<p>Distributions are made ${multi ? "pro rata to membership interests" : "to the sole member"} at times determined by the member(s), subject to applicable law.</p>
<h2>6. Records &amp; tax</h2>
<p>The company keeps books at its principal office. ${multi ? "The company is taxed as a partnership unless it elects otherwise." : "The company is a disregarded entity for federal tax unless it elects otherwise (see the EIN walkthrough). S-corp election is possible via IRS Form 2553 — discuss timing with a CPA."}</p>
<h2>7. Dissolution</h2>
<p>The company dissolves upon events specified by ${esc(st.state_name)} law or written agreement of the member(s).</p>
<div class="sig">Member signature &nbsp;&nbsp; Date</div>
${DISCLAIMER_FOOTER}
</body></html>`;
}

function einWalkthroughHtml(f, st) {
  return `<!doctype html><html><body>
<h1>EIN Walkthrough — customized for ${esc(f.business_name)} LLC</h1>
<p class="meta">The IRS has no API, so you complete this yourself at <strong>irs.gov</strong> (search "EIN Assistant"). It's free and takes about 10 minutes. Hours: Mon–Fri, 7:00 a.m.–10:00 p.m. Eastern.</p>
${DISCLAIMER_FOOTER}
<h2>Before you start, have ready</h2>
<ul><li>Legal name: ${esc(f.legal_name)}</li><li>LLC name: ${esc(f.business_name)}</li><li>Address: ${esc(f.street)}, ${esc(f.city)}, ${esc(f.state || f.state_code)} ${esc(f.zip)}</li></ul>
<h2>Screen by screen</h2>
<ol>
<li><strong>What type of legal structure?</strong> → Limited Liability Company (LLC).</li>
<li><strong>Number of members?</strong> → 1 (sole member), unless you have partners.</li>
<li><strong>State where the LLC is located?</strong> → ${esc(st.state_name)}.</li>
<li><strong>Why are you requesting the EIN?</strong> → "Started a new business".</li>
<li><strong>Responsible party</strong> → yourself: ${esc(f.legal_name)} (must be an individual, not the LLC).</li>
<li><strong>Business address</strong> → the address above.</li>
<li><strong>Confirm and submit</strong> → the IRS issues your EIN immediately on screen. Save the confirmation letter (CP 575) as a PDF.</li>
</ol>
<div class="note">Never pay a third-party site for an EIN — the IRS issues them free. If a site charges you, leave.</div>
<h2>After you have the EIN</h2>
<p>Use it to open the business bank account (see checklist) and for tax filings. Keep the CP 575 letter with your vault documents.</p>
${DISCLAIMER_FOOTER}
</body></html>`;
}

function bankChecklistHtml(f, st) {
  return `<!doctype html><html><body>
<h1>Business Bank Account Checklist — ${esc(f.business_name)} LLC</h1>
<p class="meta">Bring originals (or certified copies) plus a government photo ID for every signer.</p>
${DISCLAIMER_FOOTER}
<h2>Documents to bring</h2>
<ol>
<li>Filed ${esc(st.form_name)} (or the state-stamped confirmation from ${esc(st.portal_url)})</li>
<li>EIN confirmation letter from the IRS (CP 575)</li>
<li>Signed Operating Agreement (in this vault)</li>
<li>Government photo ID for each signer/owner</li>
<li>Proof of business address (utility bill or lease) — some banks ask</li>
</ol>
<h2>Fintech vs. traditional — quick picker</h2>
<table>
<tr><th></th><th>Fintech (e.g. Mercury, Relay)</th><th>Traditional bank</th></tr>
<tr><th>Best for</th><td>Online-first founders, fast signup, no branches needed</td><td>Cash deposits, in-person services, existing relationship</td></tr>
<tr><th>Watch for</th><td>Confirm FDIC pass-through coverage and support hours</td><td>Monthly fees and minimum balances — ask for the fee schedule in writing</td></tr>
</table>
<div class="note">Open the account in the LLC's legal name exactly as filed. Never mix personal and business funds from day one.</div>
${DISCLAIMER_FOOTER}
</body></html>`;
}

export const DOCS = [
  { slug: "articles-of-organization", name: "Articles of Organization (pre-filled)", render: articlesHtml },
  { slug: "operating-agreement", name: "Operating Agreement", render: operatingAgreementHtml },
  { slug: "ein-walkthrough", name: "EIN Walkthrough (IRS.gov, customized)", render: einWalkthroughHtml },
  { slug: "bank-account-checklist", name: "Bank Account Checklist", render: bankChecklistHtml },
];

// (PDFs render inside generateDocsForSession on one shared browser.)

// Generate all 4 docs for a paid session. Idempotent: skips docs already generated.
export async function generateDocsForSession(env, session_id) {
  const db = env.LEGIT_DB;
  const sess = await db.prepare("SELECT fields_json FROM sessions WHERE session_id = ?")
    .bind(session_id).first();
  if (!sess) throw new Error("session not found");
  const fields = JSON.parse(sess.fields_json || "{}");
  const st = await db.prepare(
    "SELECT state_code, state_name, form_id, form_name, fee_cents, portal_url, turnaround, registered_agent_rules, verified_at FROM states WHERE state_code = ?"
  ).bind(fields.state_code || "").first();
  if (!st) throw new Error("state not set on session");

  const pending = [];
  for (const doc of DOCS) {
    const existing = await db.prepare(
      "SELECT id FROM documents WHERE session_id = ? AND slug = ?"
    ).bind(session_id, doc.slug).first();
    if (!existing) pending.push(doc);
  }
  if (!pending.length) return [];

  // One shared browser for all docs: launching a fresh browser per PDF
  // (~4 launches) exceeds what a single waitUntil reliably survives
  // (2026-09-20 E2E: only 1 of 4 PDFs finished before the isolate died).
  const made = [];
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    for (const doc of pending) {
      const html = doc.render(fields, st);
      const page = await browser.newPage();
      try {
        await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
        const pdf = await page.pdf({ format: "Letter", printBackground: true });
        const key = `vault/${session_id}/${doc.slug}.pdf`;
        await env.LEGIT_DATA.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
        await db.prepare(
          `INSERT INTO documents (session_id, slug, name, r2_key, size_bytes) VALUES (?, ?, ?, ?, ?)`
        ).bind(session_id, doc.slug, doc.name, key, pdf.byteLength).run();
        made.push(doc.slug);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  await db.prepare("UPDATE sessions SET stage = 'docs', updated_at = datetime('now') WHERE session_id = ?")
    .bind(session_id).run();
  return made;
}

// Fresh 7-day download URLs for every doc in the vault. "Re-downloadable forever"
// = this endpoint mints new URLs on every call.
export async function vaultDownloadList(env, db, session_id, host) {
  const rows = await db.prepare(
    "SELECT slug, name, r2_key FROM documents WHERE session_id = ? ORDER BY id"
  ).bind(session_id).all();
  const docs = [];
  for (const r of (rows.results || [])) {
    const signed = await signUrl(env, `${host}/api/dl`, r.r2_key, 7 * 24 * 3600);
    docs.push({ name: r.name, url: signed.url, expires_at: signed.expires_at });
  }
  return docs;
}
