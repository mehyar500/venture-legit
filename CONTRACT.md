# Legit API contract — `api.legit.mehyar.us`

Backend: Cloudflare Worker `legit-api` (this repo: `worker/`, `wrangler.toml`).
Frontend PWA lives in `pwa/` and builds to this contract exactly.

Base URL: `https://api.legit.mehyar.us` (custom domain on the Worker).
CORS: `https://legit.mehyar.us` (and `https://www.legit.mehyar.us`) only.

Auth model: `POST /api/session` returns `{session_id, token}`. The token is an
unguessable per-session secret — send it on every call. Anyone holding the
token can read that session's vault, so treat it like a password.

Stages: `discovery` → `id` → `form` → `payment` → `docs` → `advisor` (as consumed
by the PWA; the backend's canonical internal values `id_upload`/`forms_review`
are mapped to `id`/`form` at the `/api/chat` boundary — the PWA enables its ID
attach button on `stage === "id"`).

---

## Endpoints

### POST /api/session
Create a conversation. No body.
→ `{session_id, token}`

### POST /api/chat
`{session_id, token, message}` → `{messages:[{role,text}], cards:[Card], stage}`

`role` is always `"assistant"` in v1. `stage` ∈ discovery|id_upload|forms_review|payment|docs|advisor.

Cards (exactly one shape each):
```jsonc
{type:"fee", state_code:"WY", fee_cents:10000, form_name:"Articles of Organization",
 turnaround:"...", portal_url:"https://wyobiz.wy.gov", annual_fee_cents:6000,
 disclaimer:"State fee shown is the verified filing fee... Legit is not a law firm."}

{type:"form", form:"articles_of_organization", title:"Articles of Organization",
 fields:[{key:"business_name", label:"LLC name", value:"Acme LLC", editable:true}, ...],
 note:"Here's your Articles of Organization — tap any field to fix it. Nothing is filed until you confirm."}

{type:"payment", checkout_url:"https://checkout.stripe.com/c/pay/cs_test_...",
 amount_cents:3900, note:"$39 one-time. Card details go to Stripe — Legit never sees them."}

{type:"download", docs:[{name:"Articles of Organization (pre-filled)",
 url:"https://api.legit.mehyar.us/api/dl?key=...&exp=...&sig=...",
 expires_at:"2026-09-27T05:00:00.000Z"}]}

{type:"progress", stage:"docs"|"filing", steps:[{label:"Payment confirmed", done:true}, ...]}

{type:"disclaimer", text:"..."}   // compliance nudges + legal-disclaimer moments

{type:"id_upload", upload_url:"https://api.legit.mehyar.us/api/id-put?key=...&exp=...&sig=...",
 key:"id-captures/<session_id>/<uuid>.jpg", expires_at:"<ISO>",
 note:"Your ID photo is encrypted, auto-deleted after 30 days, and only the extracted name/address fields are kept."}
```

### POST /api/upload-url
`{session_id, token, content_type}` → `{url, key}`
Returns a worker-signed PUT URL (10-minute expiry — same semantics as an R2
presigned URL). PUT the image bytes to `url` with `Content-Type: <content_type>`
(max 8 MB, images only), then call `/api/id-extract`.

### POST /api/id-extract
`{session_id, token, key}` → `{legal_name, dob, address:{street,city,state,zip}, confidence}`
Runs the vision model on the uploaded ID. ONLY the extracted fields are stored
(`id_captures`); the raw image is auto-deleted after 30 days. Advances the
session to `forms_review`.

### POST /api/checkout
`{session_id, token, email}` → `{checkout_url, access_token, payment_id}`
Server-side call to the central mehyar.us checkout
(`product_id: "legit-launch-kit"`, `test: true`). **Test mode only — no live
money path exists.** Redirect the user to `checkout_url` (Stripe, `cs_test_…`).

### POST /api/payment-status
`{session_id, token, access_token}` → `{paid, docs_ready, cards:[...]}`
Poll after the user returns from Stripe. Paid-detection is **server-side only**:
the worker calls `GET https://mehyar.us/api/pay/status?token=…` and requires
`paid === true`. A client `?paid=1` flag is never trusted. On the first
confirmed payment the worker creates the filing record and generates the 4
documents in the background (`docs_ready:false` + progress card until done;
then a `download` card). Poll `/api/vault` for completion.

### GET /api/vault?token=<session token>
→ `{docs:[{name, url, expires_at}]}` — fresh 7-day download URLs minted on
every call. "Re-downloadable forever" = call this again any time.

### GET /api/dl?key=…&exp=…&sig=…
Streams one vault/ID file. Links expire per `exp`; the frontend never builds
these URLs itself — it uses the ones from `/api/vault` or card payloads.

### GET /api/state/:code  (free tier, no auth)
`WY` → `{state_code, fee_cents, form_name, turnaround, portal_url,
annual_report_fee_cents, franchise_tax}`. Powers the free state lookup.
404 if the state isn't in the Phase-1 ten.

### GET /api/health → `{ok:true, service:"legit-api"}`

---

## Money path (test mode)

Chat intake → `POST /api/checkout` → Stripe Checkout (`cs_test_…`) →
mehyar.us webhook flips `billing_payments.status` to `paid` →
user returns → `POST /api/payment-status` verifies server-side →
document generation → vault.

Price comes from the `billing_products` D1 row (`legit-launch-kit`, 3900¢);
the client can never set it. No refunds system (standing order).

## PII promise (enforced server-side)

- ID images: R2 `id-captures/`, encrypted at rest, **auto-deleted after 30
  days** by the nightly PII sweep (logged to `pii_sweeps`).
- Only extracted fields (name, DOB, address) are kept, in `id_captures`.
- Frontend shows the promise; this worker enforces it.

## Crons (internal only — never email anyone)

- `0 6 * * *` (2 AM EDT): fee-watch ETL — Browser Rendering checks the 10
  portal pages, checksums content, diffs D1, writes `etl_alerts` on fee/form
  changes; then the PII sweep.
- `0 13 * * 0` (Sun 9 AM EDT): per-customer compliance nudges into
  `compliance_nudges`, surfaced in chat. No external emails, ever.

## Ops notes

- `URL_SIGNING_KEY` is a Worker secret (set via API, never in git) used for
  the signed upload/download URLs.
- AI Gateway `legit-gateway` (chat caching + fallbacks + cost tracking).
- Chat model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, fallback
  `@cf/qwen/qwen3-30b-a3b-fp8` (both verified for tool-calling live 2026-09-20).
- Vision: `@cf/meta/llama-3.2-11b-vision-instruct` (verified extraction 2026-09-20).
- Durable Object `LegitSession` per conversation; snapshots mirrored to
  `session_snapshots` every 5 turns.
- D1: `legit-db` (`f10eb2cb-023a-44d1-bf43-506f0948b9d8`). R2: `legit-data`.
- Deploy: GitHub Actions `deploy-legit-api.yml` on push to `main`
  (paths: `worker/**`, `wrangler.toml`, `seed.sql`, `CONTRACT.md`, workflow).
  `wrangler deploy` only — never `wrangler pages deploy`.
- Phase 2 placeholder: `agent_runs` table + `start_filing` tool (honest
  "coming soon" + portal link today).
