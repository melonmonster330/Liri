# Security — Apply this before close of day

Triggered by the Supabase Advisor email on 2026-05-11 flagging:
- `rls_disabled_in_public` (critical)
- `sensitive_columns_exposed` (critical)

## What's in this commit

`supabase/migrations/20260513_rls_for_newer_tables.sql` — enables RLS
and adds policies for every table referenced in app code that was
missing from the earlier `20260323_security_rls_fix.sql` sweep:

| Table           | Policy                                                  |
| --------------- | ------------------------------------------------------- |
| `user_library`  | Users manage their own rows only                        |
| `catalogue`     | Public read · auth insert/update                        |
| `album_tracks`  | Public read · auth insert/update                        |
| `track_lyrics`  | Public read · auth insert/update                        |
| `vinyl_sides`   | Public read · auth insert/update                        |
| `bug_reports`   | **Anyone can INSERT · no client read** (service_role only) |
| `button_events` | INSERT from anyone · users read own rows                |

`bug_reports` is the most likely cause of the `sensitive_columns_exposed`
warning (it has `user_email` and free-text `description` columns).

## What Helen has to do — 2 minutes

The migration file is in the repo but doesn't run itself. Apply it:

1. Open the Supabase dashboard → Liri project (xjdjpaxgymgbvcwmvorc)
2. SQL Editor → New query
3. Paste the contents of `supabase/migrations/20260513_rls_for_newer_tables.sql`
4. Run

The migration is idempotent (`IF EXISTS` everywhere, `DROP POLICY IF EXISTS`
before each `CREATE POLICY`), so it's safe to re-run if anything goes sideways.

Then verify:
- Authentication → Policies → confirm every public-schema table has a
  green "RLS enabled" pill
- Advisors → the two critical warnings should clear within a few minutes

## Recommendations (not in this commit)

### 1. Remove `/test` from production routes
`vercel.json` rewrites `/test` → `app/test.html`. That page leaks the
signed-in user's email + JWT prefix, and tries to call a non-existent
`/api/test-auth` endpoint that (in the past) would have echoed back
masked env-var status. Today the API call 404s, so the actual leak is
small, but the page shouldn't be live in prod.

Delete this line from `vercel.json`:
```json
{ "source": "/test", "destination": "/app/test.html" },
```

The file stays in the repo so you can still use it via the direct
`/app/test.html` URL locally during dev.

### 2. Future migrations — check the Advisor afterwards
The 2026-03 RLS sweep was thorough, but every table added after that
(`track_lyrics`, `bug_reports`, etc.) shipped without RLS. Add a
ritual: after every Supabase schema change, glance at
Dashboard → Advisors before merging.

### 3. Already-secured surface — for your reference
For reference, these are already locked down — don't worry about them:

- `/admin` route: gated on `ADMIN_PASSWORD` env var with `safeCompare`
- Stripe webhook (`api/stripe-webhook.js`): signature verified via
  `constructWebhookEvent` (rejects unsigned requests)
- All other API endpoints under `api/`: JWT-verified via
  `api/_lib/auth.js`, except `api/image-proxy.js` (Discogs domain
  allowlist) and `api/itunes-lookup.js` (CORS origin allowlist, no
  data to leak)
- Supabase anon key in client code (`sb_publishable_…`): publishable
  by design — RLS is the actual gate
- `subscriptions` table: RLS'd in `20260408_subscriptions.sql`,
  read-own-only, writes service_role only
