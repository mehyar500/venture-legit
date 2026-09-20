// Worker-signed time-limited URLs (HMAC-SHA256).
// Used for ID-upload PUT URLs (10-min) and vault download URLs (7-day).
// Semantics identical to presigned URLs; enforced server-side, no extra
// credential distribution needed.

const enc = new TextEncoder();

async function hmacKey(env) {
  if (!env.URL_SIGNING_KEY) throw new Error("URL_SIGNING_KEY secret not set");
  return crypto.subtle.importKey(
    "raw", enc.encode(env.URL_SIGNING_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}

function b64url(bytes) {
  let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function signUrl(env, base, key, expiresInSec) {
  const exp = Math.floor(Date.now() / 1000) + expiresInSec;
  const msg = `${key}.${exp}`;
  const sigBytes = await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(msg));
  const sig = b64url(sigBytes);
  return {
    url: `${base}?key=${encodeURIComponent(key)}&exp=${exp}&sig=${sig}`,
    expires_at: new Date(exp * 1000).toISOString(),
  };
}

export async function verifyUrl(env, key, exp, sig) {
  if (!key || !exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const msg = `${key}.${exp}`;
  const expected = await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(msg));
  const expB64 = b64url(expected);
  if (expB64.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expB64.charCodeAt(i);
  return diff === 0;
}
