// Money path: centralized mehyar.us Stripe checkout. Test mode ONLY.
// No new Stripe keys. No live path exists in this module.
//
// Paid-detection rule: the ONLY thing that gates paid features is the
// server-side GET /api/pay/status?token=... returning paid===true.
// A client-supplied ?paid=1 flag is NEVER trusted.

export async function createCheckout(env, { session_id, email }) {
  const base = env.MEHYAR_PAY_BASE || "https://mehyar.us";
  const res = await fetch(`${base}/api/pay/checkout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": env.BROWSER_UA, // mehyar.us bot firewall 1010-blocks non-browser clients
    },
    body: JSON.stringify({ product_id: env.PRODUCT_ID || "legit-launch-kit", email, test: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok || !data.checkout_url) {
    throw new Error(`checkout failed: ${JSON.stringify(data).slice(0, 200)}`);
  }
  await env.LEGIT_DB.prepare(
    `INSERT INTO payments (session_id, payment_id, access_token, email, amount_cents, status, checkout_url)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(session_id, data.payment_id, data.token, email, Number(env.PRICE_CENTS || 3900), data.checkout_url).run();
  return { checkout_url: data.checkout_url, access_token: data.token, payment_id: data.payment_id };
}

// Idempotent checkout reuse: return the stored checkout URL for a pending
// payment (created earlier this session) instead of minting a duplicate.
export async function getCheckoutUrl(env, access_token) {
  const row = await env.LEGIT_DB.prepare(
    "SELECT checkout_url FROM payments WHERE access_token = ? ORDER BY id DESC LIMIT 1"
  ).bind(access_token).first();
  return row && row.checkout_url ? { checkout_url: row.checkout_url } : null;
}

export async function fetchPaidStatus(env, access_token) {
  const base = env.MEHYAR_PAY_BASE || "https://mehyar.us";
  const res = await fetch(
    `${base}/api/pay/status?token=${encodeURIComponent(access_token)}`,
    { headers: { "User-Agent": env.BROWSER_UA } } // bot firewall 1010
  );
  const data = await res.json().catch(() => ({}));
  return data; // { ok, paid, status, product_id, email, paid_at }
}
