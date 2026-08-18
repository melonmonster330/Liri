// api/_lib/discogs-oauth.js — Discogs OAuth 1.0a helper (PLAINTEXT)
//
// Implements the three-legged OAuth flow Discogs uses to let a Liri user
// authorize us to read their collection on their behalf. We use the PLAINTEXT
// signature method, which Discogs explicitly recommends over HMAC-SHA1 for
// its simplicity (it's secure because every request is over HTTPS).
//
// Required env:
//   DISCOGS_KEY     — consumer key    (from discogs.com/settings/developers)
//   DISCOGS_SECRET  — consumer secret (keep server-side)
//
// Flow:
//   1. getRequestToken(callbackUrl)  → { oauth_token, oauth_token_secret }
//   2. redirect user to authorizeUrl(oauth_token)
//   3. Discogs redirects back to callbackUrl with ?oauth_token&oauth_verifier
//   4. getAccessToken(token, secret, verifier) → long-lived access token
//   5. getIdentity(...) / signedGet(...) using the access token

const https  = require("https");
const crypto = require("crypto");

const USER_AGENT = "Liri/1.0 +https://getliri.com";

const consumerKey    = () => process.env.DISCOGS_KEY;
const consumerSecret = () => process.env.DISCOGS_SECRET;

function hasCredentials() {
  return !!(consumerKey() && consumerSecret());
}

// Build the `Authorization: OAuth ...` header from a params object.
function oauthHeader(params) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}="${encodeURIComponent(v)}"`)
    .join(", ");
  return `OAuth ${parts}`;
}

function baseParams(extra = {}) {
  return {
    oauth_consumer_key:     consumerKey(),
    oauth_nonce:            crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "PLAINTEXT",
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_version:          "1.0",
    ...extra,
  };
}

// PLAINTEXT signature = "consumerSecret&tokenSecret" (tokenSecret empty for step 1).
function withSignature(params, tokenSecret = "") {
  return { ...params, oauth_signature: `${consumerSecret()}&${tokenSecret}` };
}

function httpRequest(method, url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path:     u.pathname + u.search,
        method,
        headers:  { "User-Agent": USER_AGENT, ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Discogs request timed out")); });
    req.end();
  });
}

const parseForm = body => Object.fromEntries(new URLSearchParams(body));

// Step 1 — request token.
async function getRequestToken(callbackUrl) {
  const params = withSignature(baseParams({ oauth_callback: callbackUrl }));
  const { status, body } = await httpRequest("GET", "https://api.discogs.com/oauth/request_token", {
    "Authorization": oauthHeader(params),
    "Content-Type":  "application/x-www-form-urlencoded",
  });
  if (status !== 200) throw new Error(`request_token failed (${status}): ${body.slice(0, 200)}`);
  const parsed = parseForm(body);
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new Error(`request_token response missing fields: ${body.slice(0, 200)}`);
  }
  return parsed; // { oauth_token, oauth_token_secret, oauth_callback_confirmed }
}

function authorizeUrl(requestToken) {
  return `https://www.discogs.com/oauth/authorize?oauth_token=${encodeURIComponent(requestToken)}`;
}

// Step 4 — exchange request token + verifier for a long-lived access token.
async function getAccessToken(requestToken, requestTokenSecret, verifier) {
  const params = withSignature(
    baseParams({ oauth_token: requestToken, oauth_verifier: verifier }),
    requestTokenSecret
  );
  const { status, body } = await httpRequest("POST", "https://api.discogs.com/oauth/access_token", {
    "Authorization": oauthHeader(params),
    "Content-Type":  "application/x-www-form-urlencoded",
  });
  if (status !== 200) throw new Error(`access_token failed (${status}): ${body.slice(0, 200)}`);
  const parsed = parseForm(body);
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new Error(`access_token response missing fields: ${body.slice(0, 200)}`);
  }
  return parsed; // { oauth_token, oauth_token_secret }
}

// Signed GET on behalf of a user — used for identity now and the collection later.
async function signedGet(url, accessToken, accessTokenSecret) {
  const params = withSignature(baseParams({ oauth_token: accessToken }), accessTokenSecret);
  const { status, body } = await httpRequest("GET", url, { "Authorization": oauthHeader(params) });
  let json = null;
  try { json = JSON.parse(body); } catch { /* non-JSON */ }
  return { status, json, body };
}

async function getIdentity(accessToken, accessTokenSecret) {
  const { status, json, body } = await signedGet(
    "https://api.discogs.com/oauth/identity", accessToken, accessTokenSecret
  );
  if (status !== 200 || !json) throw new Error(`identity failed (${status}): ${body.slice(0, 200)}`);
  return json; // { id, username, resource_url, consumer_name }
}

// Full profile for the authenticated user. email is only returned when the
// request is signed as that same user (which ours is). Returns null on failure.
async function getProfile(username, accessToken, accessTokenSecret) {
  const { status, json } = await signedGet(
    `https://api.discogs.com/users/${encodeURIComponent(username)}`, accessToken, accessTokenSecret
  );
  if (status !== 200 || !json) return null;
  return json; // { email, avatar_url, num_collection, num_wantlist, location, ... }
}

module.exports = {
  hasCredentials,
  getRequestToken,
  authorizeUrl,
  getAccessToken,
  signedGet,
  getIdentity,
  getProfile,
};
