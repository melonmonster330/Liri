// api/_lib/supabase.js — minimal Supabase REST helper (service role)
//
// Shared by the Discogs endpoints. Uses the service role key, which bypasses
// RLS — so it can read/write the service-role-only Discogs token tables.
//
// Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const https = require("https");

// method: GET|POST|PATCH|DELETE, path: e.g. "user_discogs_accounts?user_id=eq.<id>"
// Pass `prefer` to override the default Prefer header (e.g. for upserts).
function sbRequest(method, path, body, prefer) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return Promise.reject(new Error("Supabase env vars not set"));

  const hostname = url.replace(/^https?:\/\//, "");
  const bodyStr  = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: `/rest/v1/${path}`,
        method,
        headers: {
          "apikey":        key,
          "Authorization": `Bearer ${key}`,
          "Content-Type":  "application/json",
          "Prefer":        prefer || "return=representation",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          try { resolve({ status: res.statusCode, data: text ? JSON.parse(text) : null }); }
          catch { resolve({ status: res.statusCode, data: text }); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Supabase request timed out")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Upsert a single row, merging on a conflict target (e.g. "user_id").
function sbUpsert(table, row, onConflict) {
  const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : "";
  return sbRequest("POST", `${table}${qs}`, row, "return=representation,resolution=merge-duplicates");
}

// Call Supabase Auth's service-role-only admin API. Kept here beside the REST
// helper so Discogs can act as a custom sign-in provider without exposing the
// service role key or a one-time sign-in link to browser JavaScript.
function authAdminRequest(method, path, body) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return Promise.reject(new Error("Supabase env vars not set"));

  const hostname = url.replace(/^https?:\/\//, "");
  const bodyStr = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path: `/auth/v1/admin/${path}`,
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: text ? JSON.parse(text) : null }); }
        catch { resolve({ status: res.statusCode, data: text }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Supabase Auth request timed out")); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

module.exports = { sbRequest, sbUpsert, authAdminRequest };
