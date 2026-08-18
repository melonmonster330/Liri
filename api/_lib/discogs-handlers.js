// api/_lib/discogs-handlers.js — all Discogs request handlers in one module.
//
// These used to be separate api/discogs-*.js routes, but the Hobby plan caps a
// deployment at 12 serverless functions. They're consolidated behind a single
// api/discogs.js function that dispatches on ?action=. Living under api/_lib
// (underscore-prefixed) means Vercel does NOT treat this file as its own route.
//
// The old paths (/api/discogs-status etc.) still work via rewrites in
// vercel.json, so callers and the registered OAuth callback URL are unchanged.

const { verifyAuth }          = require("./auth");
const { sbRequest, sbUpsert, authAdminRequest } = require("./supabase");
const discogs                 = require("./discogs-oauth");

const ALLOWED = ["https://getliri.com", "https://www.getliri.com", "capacitor://localhost"];

function publicHost(req) {
  const host = String(req.headers.host || "").toLowerCase();
  if (host === "getliri.com" || host === "www.getliri.com" || host.endsWith(".vercel.app")) return host;
  return "www.getliri.com";
}

function cors(req, res, methods) {
  const origin = req.headers.origin || "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED.includes(origin) ? origin : "https://getliri.com");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ── start: begin "Connect Discogs" (OAuth step 1) ──────────────────────────
async function start(req, res) {
  cors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  if (!discogs.hasCredentials()) {
    console.error("[discogs.start] DISCOGS_KEY/DISCOGS_SECRET not configured");
    return res.status(500).json({ error: "Discogs sign-in isn't configured yet." });
  }

  // Authenticated requests link Discogs to the current Liri account. A logged
  // out request starts a Discogs-first sign-in/create-account flow instead.
  const auth = req.headers.authorization ? await verifyAuth(req) : null;
  if (auth && auth._authError) {
    return res.status(401).json({ error: "Session expired — please sign out and back in." });
  }

  const host = publicHost(req);
  const callbackUrl = `https://${host}/api/discogs-oauth-callback`;

  const rawReturn = req.body && req.body.return_to;
  const returnTo = (typeof rawReturn === "string" && rawReturn.startsWith("/") && !rawReturn.startsWith("//"))
    ? rawReturn : "/app";
  const nativeCallback = req.body?.native === true;

  try {
    const { oauth_token, oauth_token_secret } = await discogs.getRequestToken(callbackUrl);
    const { status } = await sbRequest("POST", "discogs_oauth_pending", {
      oauth_token,
      oauth_token_secret,
      user_id: auth?.userId || null,
      return_to: returnTo,
      native_callback: nativeCallback,
    });
    if (status >= 300) {
      console.error("[discogs.start] failed to store pending token, status", status);
      return res.status(500).json({ error: "Couldn't start Discogs sign-in. Please try again." });
    }
    return res.status(200).json({ authorizeUrl: discogs.authorizeUrl(oauth_token) });
  } catch (e) {
    console.error("[discogs.start] error:", e.message);
    return res.status(502).json({ error: "Couldn't reach Discogs. Please try again." });
  }
}

// ── callback: finish "Connect Discogs" (OAuth steps 3–4) ───────────────────
// Not authenticated — the browser arriving from Discogs has no Supabase JWT.
function backToApp(res, host, path, params, native = false) {
  const safePath = (typeof path === "string" && path.startsWith("/") && !path.startsWith("//")) ? path : "/app";
  const qs = new URLSearchParams(params).toString();
  res.statusCode = 302;
  res.setHeader("Location", native ? `liri://auth/callback?${qs}` : `https://${host}${safePath}?${qs}`);
  res.end();
}

async function callback(req, res) {
  const host = publicHost(req);
  const url  = new URL(req.url, `https://${host}`);
  const oauthToken = url.searchParams.get("oauth_token");
  const verifier   = url.searchParams.get("oauth_verifier");
  const denied     = url.searchParams.get("denied");

  if (!oauthToken) return backToApp(res, host, "/app", { discogs: "error", reason: "missing_params" });

  let nativeCallback = false;
  try {
    const { data } = await sbRequest(
      "GET",
      `discogs_oauth_pending?oauth_token=eq.${encodeURIComponent(oauthToken)}&select=oauth_token_secret,user_id,return_to,native_callback&limit=1`
    );
    const pending = Array.isArray(data) ? data[0] : null;
    if (!pending) return backToApp(res, host, "/app", { discogs: "error", reason: "expired" });
    const returnTo = pending.return_to || "/app";
    nativeCallback = pending.native_callback === true;
    if (denied) return backToApp(res, host, returnTo, { discogs: "cancelled" }, nativeCallback);
    if (!verifier) return backToApp(res, host, returnTo, { discogs: "error", reason: "missing_params" }, nativeCallback);

    const access   = await discogs.getAccessToken(oauthToken, pending.oauth_token_secret, verifier);
    const identity = await discogs.getIdentity(access.oauth_token, access.oauth_token_secret);
    if (!identity.id) throw new Error("Discogs did not return a stable user id");

    const existing = await sbRequest(
      "GET",
      `user_discogs_accounts?discogs_user_id=eq.${encodeURIComponent(identity.id)}&select=user_id&limit=1`
    );
    const linked = Array.isArray(existing.data) ? existing.data[0] : null;

    let userId = pending.user_id || linked?.user_id || null;
    let createdUser = false;

    // Never move a proven Discogs identity from one established Liri account
    // to another. The user must sign into the original account and disconnect
    // it first, or delete that test account completely.
    if (pending.user_id && linked && linked.user_id !== pending.user_id) {
      return backToApp(res, host, returnTo, { discogs: "error", reason: "already_linked" }, nativeCallback);
    }

    if (!userId) {
      const syntheticEmail = `discogs-${identity.id}@auth.getliri.com`;
      const made = await authAdminRequest("POST", "users", {
        email: syntheticEmail,
        email_confirm: true,
        user_metadata: {
          name: identity.username,
          signup_platform: "web",
          signup_provider: "discogs",
          discogs_user_id: identity.id,
        },
      });
      userId = made.data?.id || made.data?.user?.id || null;
      if (made.status >= 300 || !userId) {
        console.error("[discogs.callback] user creation failed", made.status, made.data);
        return backToApp(res, host, returnTo, { discogs: "error", reason: "account_create_failed" }, nativeCallback);
      }
      createdUser = true;
    }

    const up = await sbUpsert("user_discogs_accounts", {
      user_id:            userId,
      discogs_user_id:    identity.id || null,
      discogs_username:   identity.username,
      oauth_token:        access.oauth_token,
      oauth_token_secret: access.oauth_token_secret,
      connected_at:       new Date().toISOString(),
    }, "user_id");
    if (up.status >= 300) {
      console.error("[discogs.callback] store failed, status", up.status, up.data);
      if (createdUser) await authAdminRequest("DELETE", `users/${encodeURIComponent(userId)}`).catch(() => {});
      return backToApp(res, host, returnTo, { discogs: "error", reason: "store_failed" }, nativeCallback);
    }

    await sbRequest("DELETE", `discogs_oauth_pending?oauth_token=eq.${encodeURIComponent(oauthToken)}`)
      .catch(() => {});

    if (pending.user_id) {
      return backToApp(res, host, returnTo, { discogs: "connected", u: identity.username }, nativeCallback);
    }

    // Discogs is not a native Supabase provider, so finish the custom provider
    // flow with a service-generated, single-use OTP. It travels only through a
    // direct redirect into Liri and is exchanged immediately by supabase-js.
    const found = await authAdminRequest("GET", `users/${encodeURIComponent(userId)}`);
    const email = found.data?.email || found.data?.user?.email;
    if (found.status >= 300 || !email) {
      return backToApp(res, host, returnTo, { discogs: "error", reason: "account_lookup_failed" }, nativeCallback);
    }
    const signIn = await authAdminRequest("POST", "generate_link", {
      type: "magiclink",
      email,
      redirect_to: nativeCallback ? "liri://auth/callback" : `https://${host}${returnTo}`,
    });
    const tokenHash = signIn.data?.hashed_token || signIn.data?.properties?.hashed_token;
    if (signIn.status >= 300 || !tokenHash) {
      console.error("[discogs.callback] sign-in link failed", signIn.status, signIn.data);
      return backToApp(res, host, returnTo, { discogs: "error", reason: "sign_in_failed" }, nativeCallback);
    }
    return backToApp(res, host, returnTo, {
      discogs: "connected",
      u: identity.username,
      token_hash: tokenHash,
      type: "magiclink",
    }, nativeCallback);
  } catch (e) {
    console.error("[discogs.callback] error:", e.message);
    return backToApp(res, host, "/app", { discogs: "error", reason: "exchange_failed" }, nativeCallback);
  }
}

// ── status: is this user connected? (returns safe profile fields) ──────────
async function status(req, res) {
  cors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")     return res.status(405).json({ error: "Method not allowed" });

  const auth = await verifyAuth(req);
  if (!auth || auth._authError) {
    return res.status(401).json({ error: "Session expired — please sign out and back in." });
  }

  try {
    const { data } = await sbRequest(
      "GET",
      `user_discogs_accounts?user_id=eq.${encodeURIComponent(auth.userId)}` +
        `&select=discogs_username,discogs_email,discogs_avatar_url,discogs_num_collection,` +
        `oauth_token,oauth_token_secret,connected_at,last_synced_at&limit=1`
    );
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return res.status(200).json({ connected: false });

    let email     = row.discogs_email;
    let avatarUrl = row.discogs_avatar_url;
    let numColl   = row.discogs_num_collection;

    if (email == null && avatarUrl == null && numColl == null) {
      try {
        const profile = await discogs.getProfile(row.discogs_username, row.oauth_token, row.oauth_token_secret);
        if (profile) {
          email     = profile.email      || null;
          avatarUrl = profile.avatar_url || null;
          numColl   = profile.num_collection != null ? profile.num_collection : null;
          await sbRequest("PATCH",
            `user_discogs_accounts?user_id=eq.${encodeURIComponent(auth.userId)}`,
            { discogs_email: email, discogs_avatar_url: avatarUrl, discogs_num_collection: numColl }
          ).catch(() => {});
        }
      } catch (e) { console.warn("[discogs.status] profile backfill failed:", e.message); }
    }

    return res.status(200).json({
      connected:      true,
      username:       row.discogs_username,
      email:          email || null,
      avatar_url:     avatarUrl || null,
      num_collection: numColl != null ? numColl : null,
      connected_at:   row.connected_at,
      last_synced_at: row.last_synced_at || null,
    });
  } catch (e) {
    console.error("[discogs.status] error:", e.message);
    return res.status(500).json({ error: "Couldn't check Discogs status." });
  }
}

// ── import: pull the owned collection into staging (list-only, resumable) ──
const PER_PAGE           = 100;
const MAX_PAGES_PER_CALL = 10;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanArtist = name => (name || "").replace(/\s*\(\d+\)\s*$/, "").trim();

function toRow(userId, item) {
  const bi = item.basic_information || {};
  return {
    user_id:             userId,
    discogs_release_id:  item.id || bi.id,
    discogs_instance_id: item.instance_id || 0,
    artist_name:         cleanArtist(bi.artists && bi.artists[0] && bi.artists[0].name),
    album_name:          bi.title || null,
    release_year:        bi.year || null,
    thumb_url:           bi.cover_image || bi.thumb || null,
    added_at:            item.date_added || new Date().toISOString(),
  };
}

async function importCollection(req, res) {
  cors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  const auth = await verifyAuth(req);
  if (!auth || auth._authError) {
    return res.status(401).json({ error: "Session expired — please sign out and back in." });
  }

  const { data: accts } = await sbRequest(
    "GET",
    `user_discogs_accounts?user_id=eq.${encodeURIComponent(auth.userId)}` +
      `&select=discogs_username,oauth_token,oauth_token_secret&limit=1`
  );
  const acct = Array.isArray(accts) ? accts[0] : null;
  if (!acct) return res.status(400).json({ error: "Connect your Discogs account first." });

  const startPage = Math.max(1, parseInt((req.body && req.body.page) != null ? req.body.page : (req.query && req.query.page) || "1", 10) || 1);
  const endPage   = startPage + MAX_PAGES_PER_CALL - 1;

  let imported = 0, totalItems = null, totalPages = null, page = startPage;

  try {
    for (; page <= endPage; page++) {
      const url =
        `https://api.discogs.com/users/${encodeURIComponent(acct.discogs_username)}` +
        `/collection/folders/0/releases?per_page=${PER_PAGE}&page=${page}`;
      const { status, json } = await discogs.signedGet(url, acct.oauth_token, acct.oauth_token_secret);

      if (status === 401) return res.status(401).json({ error: "Discogs access was revoked. Please reconnect." });
      if (status === 429) { await sleep(2000); page--; continue; }
      if (status !== 200 || !json) {
        return res.status(502).json({ error: "Couldn't read your Discogs collection. Please try again." });
      }

      totalItems = (json.pagination && json.pagination.items != null) ? json.pagination.items : totalItems;
      totalPages = (json.pagination && json.pagination.pages != null) ? json.pagination.pages : totalPages;

      const items = Array.isArray(json.releases) ? json.releases : [];
      if (items.length) {
        const rows = items.map(it => toRow(auth.userId, it)).filter(r => r.discogs_release_id);
        const onConflict = encodeURIComponent("user_id,discogs_release_id,discogs_instance_id");
        const up = await sbRequest(
          "POST",
          `user_discogs_collection?on_conflict=${onConflict}`,
          rows,
          "resolution=ignore-duplicates,return=representation"
        );
        if (up.status >= 300) {
          console.error("[discogs.import] insert failed, status", up.status, up.data);
          return res.status(500).json({ error: "Couldn't save your collection. Please try again." });
        }
        imported += Array.isArray(up.data) ? up.data.length : 0;
      }

      if (totalPages != null && page >= totalPages) break;
      await sleep(250);
    }

    const done = totalPages == null || page >= totalPages;
    if (done) {
      await sbRequest("PATCH",
        `user_discogs_accounts?user_id=eq.${encodeURIComponent(auth.userId)}`,
        { last_synced_at: new Date().toISOString() }
      ).catch(() => {});
    }

    return res.status(200).json({
      imported,
      total: totalItems,
      pages: totalPages,
      done,
      nextPage: done ? null : page + 1,
    });
  } catch (e) {
    console.error("[discogs.import] error:", e.message);
    return res.status(500).json({ error: "Import failed. Please try again." });
  }
}

// ── disconnect: remove the stored connection (keep imported records) ───────
async function disconnect(req, res) {
  cors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });

  const auth = await verifyAuth(req);
  if (!auth || auth._authError) {
    return res.status(401).json({ error: "Session expired — please sign out and back in." });
  }

  try {
    const { status } = await sbRequest(
      "DELETE",
      `user_discogs_accounts?user_id=eq.${encodeURIComponent(auth.userId)}`
    );
    if (status >= 300) {
      console.error("[discogs.disconnect] delete failed, status", status);
      return res.status(500).json({ error: "Couldn't disconnect. Please try again." });
    }
    return res.status(200).json({ disconnected: true });
  } catch (e) {
    console.error("[discogs.disconnect] error:", e.message);
    return res.status(500).json({ error: "Couldn't disconnect. Please try again." });
  }
}

module.exports = { start, callback, status, importCollection, disconnect };
