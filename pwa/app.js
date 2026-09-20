/* Legit PWA — chat client.
 * CONTRACT: backend CONTRACT.md (repo root) is authoritative. This file was
 * reconciled against it 2026-09-20: cards fee|form|payment|download|progress|
 * id_upload|disclaimer with exact backend shapes; stage id_upload/forms_review
 * normalized; fee lookup uses fee_cents + Phase-1 ten states; id-extract
 * address is an object; payment-status polls /api/vault until docs_ready.
 * NEVER touches card data. No Stripe keys anywhere in this file.
 */
"use strict";

/* ================= config ================= */
const API_BASE = "https://api.legit.mehyar.us";
const LS_KEY = "legit.session.v1";

const STAGES = {
  discovery: "Discovery — state & business name",
  id: "ID capture",
  form: "Review your forms",
  payment: "Payment — $39 one-time",
  docs: "Generating your documents",
  advisor: "Advisor — what's next"
};
// backend maps internal id_upload/forms_review -> id/form at the /api/chat boundary;
// normalize here too in case a raw value ever slips through.
function normalizeStage(s) {
  if (s === "id_upload") return "id";
  if (s === "forms_review") return "form";
  return s;
}
function showStage(s) {
  const k = normalizeStage(s);
  if (STAGES[k]) $("chat-stage").textContent = STAGES[k];
  if (k === "id") enableIdUpload();
}

// Phase-1 states only — GET /api/state/:code 404s outside these ten.
const STATES = [
  ["WY","Wyoming"],["DE","Delaware"],["FL","Florida"],["TX","Texas"],["CA","California"],
  ["NY","New York"],["NV","Nevada"],["CO","Colorado"],["GA","Georgia"],["AZ","Arizona"]
];

/* ================= state ================= */
const $ = (id) => document.getElementById(id);
let session = null;   // {session_id, token}
let booted = false;

function loadSession() {
  try { session = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch { session = null; }
  return session;
}
function saveSession(s) { session = s; localStorage.setItem(LS_KEY, JSON.stringify(s)); }

/* ================= api ================= */
async function api(path, body, opts = {}) {
  const url = path.startsWith("http") ? path : API_BASE + path;
  const res = await fetch(url, {
    method: opts.method || "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error || ""; } catch {}
    throw new Error(`Request failed (${res.status})${detail ? ": " + detail : ""}`);
  }
  return res.json();
}
async function ensureSession() {
  if (session && session.session_id && session.token) return session;
  const s = await api("/api/session");
  saveSession({ session_id: s.session_id, token: s.token });
  return session;
}

/* ================= views ================= */
function show(name) {
  for (const v of ["landing", "chat", "vault"]) $("view-" + v).classList.toggle("active", v === name);
  if (name === "chat") setTimeout(scrollChat, 50);
}

/* ================= chat ui ================= */
const chatEl = () => $("chat");
function scrollChat() { const c = chatEl(); c.scrollTop = c.scrollHeight; }

function addMsg(text, who = "bot") {
  const d = document.createElement("div");
  d.className = "msg " + who;
  d.textContent = text;
  chatEl().appendChild(d);
  scrollChat();
  return d;
}

function setTyping(on) { $("typing").hidden = !on; if (on) scrollChat(); }

function addCards(cards) {
  if (!cards || !cards.length) return;
  const wrap = document.createElement("div");
  wrap.className = "cards";
  for (const c of cards) wrap.appendChild(renderCard(c));
  chatEl().appendChild(wrap);
  scrollChat();
}


/* ---- card renderers (backend CONTRACT.md — cards: fee|form|payment|download|progress|id_upload|disclaimer) ---- */
function renderCard(c) {
  switch (c.type) {
    case "fee": return cardFee(c);
    case "form": return cardForm(c);
    case "payment": return cardPayment(c);
    case "download": return cardDownload(c);
    case "progress": return cardProgress(c);
    case "id_upload": return cardIdUpload(c);
    case "disclaimer": {
      const d = document.createElement("div");
      d.className = "legal-chip";
      d.innerHTML = `<strong>Not a law firm.</strong> ${esc(c.text || "Legit provides self-help business formation tools, not legal advice.")}`;
      return d;
    }
    default: {
      const d = document.createElement("div");
      d.className = "rcard";
      d.textContent = c.text || c.title || "Card";
      return d;
    }
  }
}

function dollars(cents) {
  if (cents == null) return null;
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0 });
}

function cardFee(c) {
  const d = document.createElement("div");
  d.className = "rcard";
  const fee = dollars(c.fee_cents);
  d.innerHTML = `<h3>💰 ${esc(c.state_code || "")} LLC filing fee</h3>
    <div class="row"><span class="k">State filing fee</span><span class="v">${esc(fee || c.fee_display || "?")}</span></div>
    ${c.form_name ? `<div class="row"><span class="k">Form</span><span class="v">${esc(c.form_name)}</span></div>` : ""}
    ${c.turnaround ? `<div class="row"><span class="k">Typical turnaround</span><span class="v">${esc(c.turnaround)}</span></div>` : ""}
    ${c.annual_fee_cents != null ? `<div class="row"><span class="k">Annual fee</span><span class="v">${esc(dollars(c.annual_fee_cents))}</span></div>` : ""}
    ${c.portal_url ? `<p class="micro" style="margin-top:8px"><a href="${esc(c.portal_url)}" target="_blank" rel="noopener">Official state portal ↗</a></p>` : ""}
    <p class="micro" style="margin-top:8px">${esc(c.disclaimer || "State fee is paid to the state separately.")}</p>
    <p class="micro" style="margin-top:4px">+ $39 Legit Launch Kit (one-time). Fee data from official state sources.</p>`;
  return d;
}

function cardForm(c) {
  const d = document.createElement("div");
  d.className = "rcard fcard";
  const uid = "f" + Math.random().toString(36).slice(2, 8);
  // contract shape: fields:[{key,label,value,editable}]
  const fields = c.fields || [];
  let html = `<h3>📄 ${esc(c.title || "Articles of Organization")}</h3>
    <p class="micro" style="margin-bottom:10px">${esc(c.note || "Pre-filled from your ID — tap any field to fix it, then confirm.")}</p>`;
  html += fields.map(f => {
    if (f.editable === false) {
      return `<div class="field"><label>${esc(f.label || prettify(f.key))}</label>
        <div class="static-val">${esc(String(f.value ?? ""))}</div></div>`;
    }
    return `<div class="field"><label for="${uid}-${esc(f.key)}">${esc(f.label || prettify(f.key))}</label>
      <input id="${uid}-${esc(f.key)}" data-field="${esc(f.key)}" value="${esc(String(f.value ?? ""))}"></div>`;
  }).join("");
  d.innerHTML = html;
  const btn = document.createElement("button");
  btn.className = "cta"; btn.style.marginTop = "6px";
  btn.textContent = c.confirm_label || "Looks right — continue →";
  btn.onclick = () => {
    const updated = {};
    d.querySelectorAll("[data-field]").forEach(el => { updated[el.dataset.field] = el.value; });
    // backend reads action:"confirm_form" out of the chat message (LLM tool path)
    sendMessage(JSON.stringify({ action: "confirm_form", form: c.form || c.title, fields: updated }),
                "Form details confirmed ✓", true);
  };
  d.appendChild(btn);
  return d;
}

/* id_upload card: direct signed upload URL from the backend */
let pendingIdUpload = null; // {upload_url, key}
function cardIdUpload(c) {
  pendingIdUpload = { upload_url: c.upload_url, key: c.key };
  enableIdUpload();
  const d = document.createElement("div");
  d.className = "rcard";
  d.innerHTML = `<h3>📷 Snap a photo of your ID</h3>
    <p class="micro">${esc(c.note || "Your ID photo is encrypted, auto-deleted after 30 days, and only the extracted name/address fields are kept.")}</p>`;
  const btn = document.createElement("button");
  btn.className = "cta"; btn.style.marginTop = "10px";
  btn.textContent = "Take / upload ID photo";
  btn.onclick = () => $("file-input").click();
  d.appendChild(btn);
  return d;
}

function cardPayment(c) {
  const d = document.createElement("div");
  d.className = "rcard pcard";
  const total = dollars(c.amount_cents) || "$39.00";
  d.innerHTML = `<h3>🧾 ${esc(c.title || "Legit Launch Kit — order summary")}</h3>
    <div class="total"><span>Total due today</span><span>${esc(total)}</span></div>
    <p class="note">${esc(c.note || "$39 one-time. Card details go to Stripe — Legit never sees them.")}<br>
    <strong>Not a law firm.</strong> Legit provides self-help business formation tools, not legal advice.</p>
    <input type="email" class="pay-email" placeholder="Email for your receipt &amp; vault access" inputmode="email">`;
  const btn = document.createElement("button");
  btn.className = "cta";
  btn.textContent = c.pay_label || "Pay $39 →";
  btn.onclick = async () => {
    const emailEl = d.querySelector(".pay-email");
    const email = emailEl.value.trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      alert("Please enter a valid email so we can send your receipt and vault access.");
      return;
    }
    btn.disabled = true; btn.textContent = "Opening secure checkout…";
    try {
      const s = await ensureSession();
      const r = await api("/api/checkout", { session_id: s.session_id, token: s.token, email });
      if (!r.checkout_url) throw new Error("No checkout URL returned");
      // same-tab redirect to Stripe-hosted checkout; success returns to /?token=…&paid=1
      window.location.href = r.checkout_url;
    } catch (e) {
      btn.disabled = false; btn.textContent = c.pay_label || "Pay $39 →";
      addMsg("Hmm, checkout didn't open: " + e.message + ". Want to try again?");
    }
  };
  d.appendChild(btn);
  return d;
}

function cardDownload(c) {
  const d = document.createElement("div");
  d.className = "rcard";
  const docs = c.docs || c.documents || [];
  d.innerHTML = `<h3>📥 ${esc(c.title || "Your documents are ready")}</h3>
    <p class="micro" style="margin-bottom:6px">Saved to your vault — re-download anytime.</p>`;
  docs.forEach(doc => {
    const row = document.createElement("div");
    row.className = "dl-row";
    row.innerHTML = `<div class="name">${esc(doc.name)}${doc.expires_at ? `<span class="exp">link refreshes ${esc(doc.expires_at)}</span>` : ""}</div>`;
    const b = document.createElement("button");
    b.className = "mini-btn"; b.textContent = "Download";
    b.onclick = () => window.open(doc.url, "_blank", "noopener");
    row.appendChild(b);
    d.appendChild(row);
  });
  refreshVaultStrip(docs.length);
  return d;
}

function cardProgress(c) {
  const d = document.createElement("div");
  d.className = "rcard";
  // contract shape: steps:[{label, done}]
  const steps = c.steps || [];
  let nowMarked = false;
  d.innerHTML = `<h3>🗺 ${esc(c.title || "Your formation progress")}</h3><div class="prog">` +
    steps.map((s) => {
      const label = typeof s === "string" ? s : s.label;
      const done = typeof s === "object" && !!s.done;
      let cls = "", mark = "";
      if (done) { cls = "done"; mark = "✓"; }
      else if (!nowMarked) { cls = "now"; mark = "●"; nowMarked = true; }
      else { mark = "·"; }
      return `<div class="pstep ${cls}"><span class="pdot">${mark}</span><span class="plabel">${esc(label)}</span></div>`;
    }).join("") + `</div>`;
  return d;
}

/* ================= chat flow ================= */
async function sendMessage(text, displayText, hiddenJson) {
  if (!hiddenJson) addMsg(displayText || text, "user");
  $("input").value = "";
  setTyping(true);
  try {
    const s = await ensureSession();
    const r = await api("/api/chat", { session_id: s.session_id, token: s.token, message: text });
    setTyping(false);
    (r.messages || []).forEach(m => addMsg(m.text, m.role === "user" ? "user" : "bot"));
    addCards(r.cards);
    if (r.stage) showStage(r.stage);
    if (r.docs_count != null) refreshVaultStrip(r.docs_count);
  } catch (e) {
    setTyping(false);
    addMsg("Connection hiccup — " + e.message + ". Tap send to retry.");
  }
}

function enableIdUpload() {
  $("btn-attach").hidden = false;
  $("id-banner").hidden = false;
}

/* ================= ID upload ================= */
$("file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  addMsg("📷 ID photo attached — uploading securely…", "user");
  setTyping(true);
  try {
    const s = await ensureSession();
    // Prefer the backend's signed id_upload card URL when we have one;
    // otherwise fall back to minting our own upload URL.
    let putUrl, key;
    if (pendingIdUpload && pendingIdUpload.upload_url && pendingIdUpload.key) {
      putUrl = pendingIdUpload.upload_url; key = pendingIdUpload.key;
      pendingIdUpload = null;
    } else {
      const u = await api("/api/upload-url", {
        session_id: s.session_id, token: s.token, content_type: file.type || "image/jpeg"
      });
      putUrl = u.url; key = u.key;
    }
    const put = await fetch(putUrl, { method: "PUT", headers: { "Content-Type": file.type || "image/jpeg" }, body: file });
    if (!put.ok) throw new Error("upload failed (" + put.status + ")");
    addMsg("Photo received. Reading the details — one moment…");
    const x = await api("/api/id-extract", { session_id: s.session_id, token: s.token, key });
    setTyping(false);
    const addr = x.address
      ? (typeof x.address === "string" ? x.address
         : [x.address.street, x.address.city, x.address.state, x.address.zip].filter(Boolean).join(", "))
      : "—";
    addMsg(`Got it — here's what I read from your ID${x.confidence ? ` (confidence ${x.confidence})` : ""}:`);
    addMsg(`👤 ${x.legal_name || "—"}\n🎂 ${x.dob || "—"}\n🏠 ${addr}`);
    // feed extracted fields back into the conversation; backend pre-fills form cards
    await sendMessage(JSON.stringify({ action: "id_extracted", fields: {
      legal_name: x.legal_name, dob: x.dob, address: addr
    } }), "ID details captured ✓", true);
  } catch (err) {
    setTyping(false);
    addMsg("Upload didn't go through: " + err.message + ". Tap 📷 to try again.");
  }
});
$("btn-attach").addEventListener("click", () => $("file-input").click());

/* ================= checkout return: ?token=…&paid=1 ================= */
async function handleCheckoutReturn() {
  const q = new URLSearchParams(location.search);
  const access = q.get("token"), paid = q.get("paid");
  if (!access || paid !== "1") return false;
  history.replaceState(null, "", location.pathname);
  const s = await ensureSession();
  show("chat");
  addMsg("Welcome back — confirming your payment…");
  setTyping(true);
  try {
    const r = await api("/api/payment-status", { session_id: s.session_id, token: s.token, access_token: access });
    setTyping(false);
    (r.messages || []).forEach(m => addMsg(m.text, "bot"));
    addCards(r.cards);
    if (r.stage) showStage(r.stage);
    if (!r.paid) {
      addMsg("Payment hasn't cleared yet — if you just paid, give it a minute and tap send to re-check.");
    } else if (r.docs_ready) {
      await refreshVaultFromServer(s);
    } else {
      // docs generate in the background — poll the vault, then drop the download card in chat
      addMsg("Payment confirmed ✓ — your documents are being generated. I'll drop them here the moment they're ready.");
      pollVaultForDocs(s, 20);
    }
  } catch (e) {
    setTyping(false);
    addMsg("Couldn't confirm the payment just now: " + e.message + ". Tap send and I'll re-check.");
  }
  return true;
}

/* poll GET /api/vault until docs appear (docs_ready flow), then show a download card */
let vaultPollTimer = null;
async function refreshVaultFromServer(s) {
  try {
    const v = await api(`/api/vault?token=${encodeURIComponent(s.token)}`, null, { method: "GET" });
    const docs = v.docs || [];
    if (docs.length) {
      addCards([{ type: "download", title: "Your documents are ready", docs }]);
    }
    return docs.length;
  } catch { return 0; }
}
async function pollVaultForDocs(s, triesLeft) {
  clearTimeout(vaultPollTimer);
  if (triesLeft <= 0) {
    addMsg("Still generating — your documents will be in your vault shortly. Tap 🗂 anytime to check.");
    return;
  }
  vaultPollTimer = setTimeout(async () => {
    const n = await refreshVaultFromServer(s);
    if (!n) pollVaultForDocs(s, triesLeft - 1);
  }, 15000);
}

/* ================= vault ================= */
async function openVault() {
  show("vault");
  const list = $("vault-list");
  list.innerHTML = `<div class="empty-vault">Loading your documents…</div>`;
  try {
    const s = await ensureSession();
    const v = await api(`/api/vault?token=${encodeURIComponent(s.token)}`, null, { method: "GET" });
    const docs = v.docs || [];
    refreshVaultStrip(docs.length);
    list.innerHTML = "";
    if (!docs.length) {
      list.innerHTML = `<div class="empty-vault">No documents yet.<br>Finish your LLC setup in the chat and your documents will live here forever.</div>
        <button class="cta" id="btn-vault-chat">Back to chat →</button>`;
      $("btn-vault-chat").onclick = () => show("chat");
      return;
    }
    docs.forEach(doc => {
      const d = document.createElement("div");
      d.className = "rcard";
      d.innerHTML = `<div class="dl-row"><div class="name">${esc(doc.name)}
        ${doc.expires_at ? `<span class="exp">link refreshes ${esc(doc.expires_at)}</span>` : ""}</div></div>`;
      const b = document.createElement("button");
      b.className = "mini-btn"; b.textContent = "Download";
      b.style.marginTop = "8px";
      b.onclick = () => window.open(doc.url, "_blank", "noopener");
      d.appendChild(b);
      list.appendChild(d);
    });
  } catch (e) {
    list.innerHTML = `<div class="empty-vault">Couldn't load your vault: ${esc(e.message)}</div>`;
  }
}

function refreshVaultStrip(count) {
  const strip = $("vault-strip");
  strip.hidden = false;
  $("vault-count").textContent = count;
}

/* ================= boot ================= */
function esc(s) {
  return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function prettify(n) { return n.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()); }

async function boot() {
  if (booted) return; booted = true;
  loadSession();

  // free state fee lookup on landing
  const sel = $("fee-state");
  sel.innerHTML = `<option value="">Select a state…</option>` +
    STATES.map(([c, n]) => `<option value="${c}">${n}</option>`).join("");
  $("btn-fee").onclick = async () => {
    const code = sel.value;
    if (!code) return;
    const box = $("fee-result");
    box.hidden = false; box.textContent = "Looking up…";
    try {
      const r = await api(`/api/state/${code}`, null, { method: "GET" });
      const fee = dollars(r.fee_cents);
      box.innerHTML = `<strong>${esc(code)} LLC filing fee: ${esc(fee || "—")}</strong>` +
        (r.form_name ? `<br><span class="micro">Form: ${esc(r.form_name)}</span>` : "") +
        (r.turnaround ? `<br><span class="micro">Typical turnaround: ${esc(r.turnaround)}</span>` : "") +
        (r.portal_url ? `<br><span class="micro"><a href="${esc(r.portal_url)}" target="_blank" rel="noopener">Official state portal ↗</a></span>` : "") +
        `<br><br><button class="cta sm" id="btn-fee-start">Form my LLC here — $39 →</button>`;
      $("btn-fee-start").onclick = startChat;
    } catch (e) {
      box.textContent = e.message.includes("(404)")
        ? "That state isn't in our Phase-1 coverage yet — the chat can still help you with the general steps."
        : "Couldn't load fee data right now. Try again in a moment.";
    }
  };

  $("btn-start").onclick = startChat;
  $("btn-back").onclick = () => show("landing");
  $("btn-vault").onclick = openVault;
  $("btn-vault-back").onclick = () => show("chat");
  $("btn-send").onclick = () => { const t = $("input").value.trim(); if (t) sendMessage(t); };
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { const t = $("input").value.trim(); if (t) sendMessage(t); }
  });

  const resumed = loadSession();
  if (resumed && resumed.token) $("btn-resume").hidden = false;
  $("btn-resume").onclick = () => { startChat(false); openVault(); };

  if (await handleCheckoutReturn()) return;
  // token param without paid flag (deep link) → go straight to chat
  if (new URLSearchParams(location.search).get("token")) startChat(false);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

async function startChat(fresh) {
  show("chat");
  if (chatEl().children.length) return; // already in a conversation
  addCards([{ type: "disclaimer" }]);
  addMsg("Hey, I'm Legit 👋 — I'll get your LLC formed in about 15 minutes. Answer one question at a time and I'll handle the paperwork. Which state do you want to form in?");
}

document.addEventListener("DOMContentLoaded", boot);
