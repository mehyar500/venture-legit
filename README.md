# Legit — Get legit in 15 minutes

AI-chat LLC formation PWA. You chat, it forms your LLC. **$39 one-time launch kit.**

- Live: https://legit.mehyar.us
- Redirect/SEO mirror: https://llc.mehyar.us → [venture-llc](https://github.com/mehyar500/venture-llc)

## The flow

1. **Chat intake** — conversational PWA, natural-language questions (business name, state, owners, registered agent).
2. **ID photo** — snap/upload ID; vision extraction pre-fills the forms.
3. **Pre-filled form cards** — review and confirm; you never type a state form from scratch.
4. **In-chat $39 Stripe** — one-time launch kit, Payment Element, via the centralized mehyar-web checkout.
5. **Document vault** — filed docs in your personal R2-backed vault (PDFs, confirmations).
6. **Post-formation advisor** — EIN next steps, operating agreement guidance, compliance reminders.

## Technical plan (Phase 1)

1. **Chat brain** — best Workers AI LLM via AI Gateway + role-model system prompt.
2. **Durable Object sessions** — per-user conversation state.
3. **D1 state database** — 10-state coverage: filing fees, forms, requirements.
4. **R2 vault** — document storage per customer.
5. **Browser Rendering `/pdf` docs** — generated filings/artifacts.
6. **Nightly fee-watch ETL cron** — state fees change; we catch it before customers do.
7. **Phase 2 filing agent** — Queues + Browser Rendering Puppeteer with per-state playbooks; CAPTCHA via paid solver (~$0.60–1.30/1k); human-in-the-loop review dashboard from day one (Mayor handles first filings manually).

**Economics:** ~$1.50–2.50 all-in cost per $39 kit (~94% gross margin before human fallback).

## Hard rules

- **Deploy via GitHub Actions → Cloudflare Pages only.** Never run `wrangler pages deploy` from a repo directory (it wipes the project's dashboard env vars — see the 2026-09-14 mehyar-web incident).
- **Never invent state fees.** Every fee shown comes from the D1 fee table; fees are ETL-verified, never hallucinated by the chat brain.
- **"Not a law firm"** — disclaimers on the landing page, in the chat, and at checkout. Legit is document-prep software, not legal advice.
- **No new Stripe keys.** All payments flow through the centralized mehyar-web checkout (`/api/pay/checkout`).
- No refunds system — Mayor's standing order.
