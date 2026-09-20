// Legit conversational agent: system prompt, tool definitions, and the
// tool-calling loop. Chat calls Workers AI through the OpenAI-compatible
// /ai/v1/chat/completions REST endpoint (the only path whose tool-call
// validation works); vision/ID extraction still uses the binding via the
// legit-gateway AI Gateway.
//
// Model choice (verified live 2026-09-20 on this account):
//   primary  @cf/meta/llama-3.3-70b-instruct-fp8-fast  (emitted correct tool calls)
//   fallback @cf/qwen/qwen3-30b-a3b-fp8                (emitted correct tool calls)
// @cf/zai-org/glm-5.2 and @cf/openai/gpt-oss-120b were probed the same day and
// emitted NO tool calls on Workers AI, so they are not used despite strong
// third-party benchmark reputations.

export const SYSTEM_PROMPT = `You are Legit, an AI business-formation specialist inside a chat app. Your job is to get this user's LLC formed correctly and fast. You are precise, warm, and plain-spoken. You text like a smart friend: short messages, no fluff, no jargon. One question or one confirmation per turn — never stack questions, never dump a wall of text.

RULES YOU NEVER BREAK:
1. NEVER invent state fees, filing times, form numbers, or legal requirements. Every fact comes from the get_state_info tool, which reads the verified state database. If the tool doesn't have it, say "I don't have that verified — I won't guess." Making up a fee is the one unforgivable sin.
2. You are not a law firm and this is not legal advice. Legit is document-preparation software. When the user asks for legal judgment — which entity type to pick, S-corp election, liability exposure, tax strategy — give general information, then say: "I'm not a law firm and this isn't legal advice — for your specific situation, an hour with a business attorney or CPA is money well spent." Trigger this disclaimer every time legal judgment is on the table, not just once.
3. Corrections: if the user corrects anything, call save_field immediately with the fix, confirm it in one line, and move on. Never argue, never re-ask what they just corrected.
4. One step at a time. The flow is: discovery (state + business name) → ID photo → review the pre-filled forms → $39 payment → documents → advisor. Don't skip ahead. Don't mention payment before the forms are confirmed.

YOUR TOOLS:
- get_state_info: look up a state BEFORE quoting any fee, form, turnaround, or rule. Call it the moment a state is named.
- ask_field: declare which single question you are asking this turn (keeps you honest about one-question-per-turn).
- save_field: record every fact the user gives you (business name, email, corrections...). Call it the moment you learn something.
- upload_id: when it's time for the ID photo. Returns an upload card for the user.
- preview_form: show the pre-filled Articles of Organization card for confirmation. Say: "Here's your Articles of Organization — tap any field to fix it."
- charge_card: ONLY after the user confirms the forms AND gives you an email address. $39 one-time for the Legit Launch Kit: pre-filled state forms, 4 generated documents, and a permanent download vault. No subscription, no hidden fees.
- start_filing: the user asks about actually filing with the state. Be honest: in Phase 1 you prepare everything and they file at the state's portal (link is in the fee card) — automated filing is coming in Phase 2.
- fetch_vault: after payment, when the user wants their documents.

CONVERSATION SHAPE:
- First message: greet briefly, ask which state they're forming in. That's it — one question.
- When they name a state: get_state_info, then give the fee + form name + turnaround in two short lines, then ask for the business name.
- Keep every reply under 60 words unless you're explaining a form. Never say "as an AI". No emojis when discussing money or legal topics.
- If they go off-topic, answer briefly and steer back: "Happy to dig into that after we lock in your state — which state are we filing in?"`;

export const TOOLS = [
  {
    name: "get_state_info",
    description: "Look up verified LLC filing facts for a US state: fee, form name/ID, portal URL, turnaround, registered-agent rules, annual report. Call BEFORE quoting any state fact.",
    parameters: {
      type: "object",
      properties: { state_code: { type: "string", description: "Two-letter state code, e.g. WY" } },
      required: ["state_code"],
    },
  },
  {
    name: "ask_field",
    description: "Declare the single field/question you are asking the user this turn. Keeps the one-question-per-turn discipline.",
    parameters: {
      type: "object",
      properties: {
        field_key: { type: "string", description: "e.g. business_name, state_code, email" },
        question: { type: "string", description: "The exact question you are asking" },
      },
      required: ["field_key", "question"],
    },
  },
  {
    name: "save_field",
    description: "Record a fact the user gave you (or a correction) into the session.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Field key, e.g. business_name, email, legal_name" },
        value: { type: "string", description: "The value" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "upload_id",
    description: "Start the ID photo step. Returns an upload card shown to the user.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "preview_form",
    description: "Show the pre-filled Articles of Organization card for the user to review and confirm.",
    parameters: {
      type: "object",
      properties: { form: { type: "string", description: "Always 'articles_of_organization' in Phase 1" } },
      required: ["form"],
    },
  },
  {
    name: "charge_card",
    description: "Create the $39 one-time checkout AFTER the user confirmed the forms AND provided an email. Returns a payment card.",
    parameters: {
      type: "object",
      properties: { email: { type: "string", description: "Customer email for the receipt" } },
      required: ["email"],
    },
  },
  {
    name: "start_filing",
    description: "User asks about filing with the state. Returns honest Phase-1 filing guidance.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "fetch_vault",
    description: "Return the user's document vault download card (after payment).",
    parameters: { type: "object", properties: {} },
  },
];

// One chat completion through the AI Gateway. Code-level fallback to the
// secondary model if the primary errors (gateway gives us caching + cost
// tracking either way).
//
// 2026-09-20: Workers AI tool calls must go through the OpenAI-compatible
// /ai/v1/chat/completions endpoint. The AI Gateway's OpenAI normalization,
// the Workers AI binding, AND the native /ai/run REST endpoint all reject
// the models' native-format tool calls ({name, arguments}, no id) with
// platform 8007/400 validation errors — both on model output and when those
// calls are replayed in message history. The OpenAI-compatible endpoint
// synthesizes proper ids and returns/accepts OpenAI-format tool calls, which
// is the only path verified to work end to end. Auth: scoped API token in
// secret CF_AI_TOKEN ("Workers AI Read"). The binding is still used for
// vision (id_extract), which has no tools and works fine via the AI Gateway.
// NOTE: assistant message content must be a string ("" ok) — the endpoint
// rejects null content with 400.
const CF_ACCOUNT_ID = "621600637337cc1c9ecb7095508bc732";

function toOpenAITools(tools) {
  return (tools || []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description || "", parameters: t.parameters || { type: "object", properties: {} } },
  }));
}

async function chatComplete(env, messages, tools) {
  if (!env.CF_AI_TOKEN) throw new Error("CF_AI_TOKEN secret not configured");
  const models = [env.CHAT_MODEL, env.CHAT_MODEL_FALLBACK].filter(Boolean);
  let lastErr = null;
  for (const model of models) {
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1/chat/completions`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.CF_AI_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, tools: toOpenAITools(tools) }),
      });
      if (!r.ok) throw new Error(`workers-ai ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const d = await r.json();
      const msg = d.choices && d.choices[0] && d.choices[0].message;
      if (!msg) throw new Error("workers-ai: no choices in response");
      const rawCalls = msg.tool_calls || [];
      const toolCalls = rawCalls.map((tc) => {
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* keep {} */ }
        return { id: tc.id, name: tc.function?.name, arguments: args };
      });
      return { res: { response: msg.content || "", tool_calls: toolCalls }, model, rawCalls };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("all chat models failed");
}

function money(cents) {
  if (cents === null || cents === undefined) return "n/a";
  return "$" + (cents / 100).toFixed(2).replace(/\.00$/, "");
}

// Execute one tool call. Mutates sess (stage/fields), pushes chat cards.
export async function executeTool(env, db, sess, cards, call, ctx) {
  const { name, arguments: a } = call;
  const args = a || {};

  if (name === "get_state_info") {
    const code = String(args.state_code || "").toUpperCase().slice(0, 2);
    const row = await db.prepare(
      "SELECT state_code, state_name, fee_cents, form_id, form_name, portal_url, turnaround, registered_agent_rules, annual_report_due, annual_report_fee_cents, franchise_tax FROM states WHERE state_code = ?"
    ).bind(code).first();
    if (!row) return { error: `State ${code} is not covered yet in Phase 1 (10 states). Say so and ask which of the covered states they'd like, or offer to note their state for later.` };
    sess.fields.state_code = code;
    cards.push({
      type: "fee",
      state_code: row.state_code,
      fee_cents: row.fee_cents,
      form_name: row.form_name,
      turnaround: row.turnaround,
      portal_url: row.portal_url,
      annual_fee_cents: row.annual_report_fee_cents,
      disclaimer: "State fee shown is the verified filing fee from the Secretary of State. Legit is not a law firm.",
    });
    return {
      state_code: row.state_code, state_name: row.state_name,
      fee: money(row.fee_cents), form_id: row.form_id, form_name: row.form_name,
      portal_url: row.portal_url, turnaround: row.turnaround,
      registered_agent_rules: row.registered_agent_rules,
      annual_report: `${row.annual_report_due} — fee ${money(row.annual_report_fee_cents)}`,
      franchise_tax: row.franchise_tax || "none",
    };
  }

  if (name === "ask_field") {
    sess.pending_field = args.field_key;
    return { ack: true };
  }

  if (name === "save_field") {
    if (args.key) sess.fields[args.key] = args.value;
    return { saved: args.key };
  }

  if (name === "upload_id") {
    const key = `id-captures/${sess.session_id}/${crypto.randomUUID()}.jpg`;
    const { signUrl } = await import("./sign.js");
    const base = `${ctx.host}/api/id-put`;
    const signed = await signUrl(env, base, key, 600); // 10-min expiry
    cards.push({
      type: "id_upload",
      upload_url: signed.url,
      key,
      expires_at: signed.expires_at,
      text: "Your secure ID upload link is ready (expires in 10 minutes) — tap the 📷 button below to snap or choose a photo of your ID.",
      note: "Your ID photo is encrypted, auto-deleted after 30 days, and only the extracted name/address fields are kept.",
    });
    sess.stage = "id_upload";
    return { key, expires_at: signed.expires_at };
  }

  if (name === "preview_form") {
    const f = sess.fields;
    const st = await db.prepare("SELECT form_name, form_id, fee_cents FROM states WHERE state_code = ?")
      .bind(f.state_code || "").first();
    const fields = [
      { key: "business_name", label: "LLC name", value: f.business_name || "", editable: true },
      { key: "state_code", label: "State", value: f.state_code || "", editable: true },
      { key: "legal_name", label: "Organizer (from ID)", value: f.legal_name || "", editable: true },
      { key: "street", label: "Street", value: f.street || "", editable: true },
      { key: "city", label: "City", value: f.city || "", editable: true },
      { key: "zip", label: "ZIP", value: f.zip || "", editable: true },
      { key: "registered_agent_name", label: "Registered agent", value: f.registered_agent_name || f.legal_name || "", editable: true },
      { key: "management", label: "Management", value: f.management || "Member-managed", editable: true },
    ];
    cards.push({
      type: "form",
      form: "articles_of_organization",
      title: `${st ? st.form_name : "Articles of Organization"}${st && st.form_id ? " (" + st.form_id + ")" : ""}`,
      fields,
      note: "Here's your Articles of Organization — tap any field to fix it. Nothing is filed until you confirm.",
    });
    if (sess.stage === "id_upload" || sess.stage === "discovery") sess.stage = "forms_review";
    return { fields: fields.map((x) => ({ key: x.key, value: x.value })) };
  }

  if (name === "charge_card") {
    const { createCheckout } = await import("./pay.js");
    const email = args.email || sess.fields.email;
    if (!email) return { error: "Need the user's email before creating checkout. Ask for it (ask_field: email)." };
    const co = await createCheckout(env, { session_id: sess.session_id, email });
    cards.push({
      type: "payment",
      checkout_url: co.checkout_url,
      amount_cents: 3900,
      note: "$39 one-time. Card details go to Stripe — Legit never sees them.",
    });
    sess.stage = "payment";
    sess.fields.email = email;
    return { checkout_url: co.checkout_url, payment_id: co.payment_id, amount_cents: 3900 };
  }

  if (name === "start_filing") {
    const st = await db.prepare("SELECT portal_url, state_name, fee_cents FROM states WHERE state_code = ?")
      .bind(sess.fields.state_code || "").first();
    cards.push({
      type: "progress",
      stage: "filing",
      steps: [
        { label: "Forms prepared and confirmed", done: true },
        { label: "Payment completed", done: !!sess.paid },
        { label: `File at ${st ? st.state_name : "the state"} portal (${st ? st.portal_url : ""})`, done: false },
        { label: "Automated filing (Phase 2 — coming soon)", done: false },
      ],
    });
    return {
      phase: "phase1",
      message: "In Phase 1 you file at the state's portal yourself with the prepared forms — automated filing ships in Phase 2.",
      portal_url: st ? st.portal_url : null,
    };
  }

  if (name === "fetch_vault") {
    const { vaultDownloadList } = await import("./docs.js");
    const docs = await vaultDownloadList(env, db, sess.session_id, ctx.host);
    cards.push({ type: "download", docs });
    return { docs: docs.map((d) => d.name) };
  }

  return { error: `unknown tool ${name}` };
}

// Run one conversational turn: model -> tools -> model ... -> final text + cards.
export async function runAgentTurn(env, db, sess, userMessage, ctx) {
  const history = sess.history || [];
  history.push({ role: "user", content: userMessage });

  const base = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-20),
  ];

  const cards = [];
  let messages = [...base];
  let finalText = "";
  let usedModel = env.CHAT_MODEL;

  for (let i = 0; i < 5; i++) {
    const { res, model, rawCalls } = await chatComplete(env, messages, TOOLS);
    usedModel = model;
    const text = res.response || "";
    const toolCalls = res.tool_calls || [];
    if (!toolCalls.length) {
      finalText = text;
      break;
    }
    const asstMsg = { role: "assistant", content: text || "" };
    if (rawCalls.length) asstMsg.tool_calls = rawCalls;
    messages.push(asstMsg);
    for (const tc of toolCalls) {
      const out = await executeTool(env, db, sess, cards, tc, ctx);
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out) });
    }
    if (i === 4) finalText = text; // cap reached; use last text
  }

  if (!finalText) {
    // Model only emitted tool calls with no closing text — synthesize a nudge.
    finalText = sess.stage === "payment"
      ? "Your $39 checkout is ready above — once Stripe confirms, I'll generate your documents."
      : "Done — see the card above. What's next?";
  }

  history.push({ role: "assistant", content: finalText });
  sess.history = history.slice(-30);
  sess.turns = (sess.turns || 0) + 1;
  sess.model = usedModel;
  return { text: finalText, cards };
}
