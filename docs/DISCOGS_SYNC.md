# Discogs Login + Collection Sync — working checklist

> Feature branch: `discogs-integration`. Design/planning doc — the running list of
> things we can't forget. Nothing here is built yet. Last updated: Aug 2026.

## The one-line goal
Let a user sign in with their Discogs account and have **the records they actually
own** show up in their Liri library — no duplicates, no bloat, as few Discogs API
calls as possible.

## Progress
- ✅ **Slice 1 — OAuth handshake (backend).** `user_discogs_accounts` +
  `discogs_oauth_pending` + `user_discogs_collection` tables
  (`supabase/migrations/20260817_discogs_oauth.sql`), OAuth 1.0a PLAINTEXT helper
  (`api/_lib/discogs-oauth.js`), and `discogs-oauth-start` / `-callback` / `discogs-status`
  endpoints. Connects a logged-in user's Discogs account and stores their tokens
  server-side. **Not yet wired into the UI; not yet tested end-to-end.**
- ✅ **Slice 2 — Import endpoint** (`api/discogs-import.js`): list-only, paginated,
  resumable pull of the owned collection into `user_discogs_collection`.
- ✅ **Slice 3 — My Records connect flow** (`app/library.html`): greyed "Connect to
  Discogs" link at the bottom of the list (hidden once connected) → OAuth → returns
  to /library → import with a live progress banner → imported records shown in a
  "From your Discogs collection" section ("Lyrics not fetched yet"). Backend
  `return_to` support added (migration `20260817b_discogs_return.sql`).
- ⏭️ Next: (a) merge imported records into the main list as normal cards +
  click-to-fetch enrichment (iTunes match + lyrics on demand); (b) the Settings
  Discogs section (connected info + email + refresh button).

### Manual setup needed before end-to-end testing
- [ ] Register a Discogs application (discogs.com/settings/developers) and set
      **`DISCOGS_KEY`** + **`DISCOGS_SECRET`** in Vercel (Preview + Production).
      Only `DISCOGS_TOKEN` is currently set — OAuth needs the consumer key/secret.
- [ ] Add the callback URL(s) to the Discogs app: the preview
      (`https://liri-git-discogs-integration-…/api/discogs-oauth-callback`) and prod
      (`https://www.getliri.com/api/discogs-oauth-callback`).
- [ ] For testing on the preview URL, turn off Vercel deployment protection (or test on prod),
      so Discogs can redirect the browser back without hitting the SSO wall.

---

## What already exists (don't rebuild)
- `api/discogs-lookup.js` — proxy for Discogs search + release detail, authed with an
  **app-level** credential (`DISCOGS_TOKEN` / `DISCOGS_KEY`+`SECRET`). This is NOT
  per-user login.
- `api/add-to-library.js` — the interactive "add one album" path. **Heavy** per album
  (iTunes lookup + MusicBrainz + up to ~6 Discogs release fetches + per-track LRCLib).
  Built for one-at-a-time. Do **not** run this in a loop over a whole collection.
- `scripts/seed-vinyl-discogs.js` — already does Discogs→iTunes matching + the exact
  rate-limit dance we need (1100ms sleeps, 429 backoff, skip-if-exists, resumable
  pages). Reuse this machinery for the import worker.
- The app is **spined on `itunes_collection_id`** — `user_library`, `catalogue`,
  `album_tracks`, `track_lyrics`, `vinyl_sides`, `liri_lyric_cache` all key on it.
  Discogs releases have no iTunes ID until we resolve them. That gap is the core of
  the storage rethink below.

---

## Checklist

### 1. Login with Discogs → linked Liri account
- [ ] OAuth 1.0a three-legged flow (request token → authorize on discogs.com →
      per-user access token). Access tokens don't expire unless revoked.
- [ ] New Vercel endpoint(s) for the token exchange (keep consumer secret server-side).
- [ ] On success, pull **name + email** from Discogs identity/profile and create a
      Liri account **linked to** the Discogs account.
      - [ ] ⚠️ VERIFY we can actually read the user's email via the API — Discogs only
            exposes email on the *authenticated user's own* profile. If it's missing,
            need a fallback (ask for email, or username-only account).
- [ ] Store per user: discogs username, discogs user id, access token + secret,
      `last_synced_at`. New table (e.g. `user_discogs_accounts`).
- [ ] **Account de-dup:** if a Liri account already exists for that email, **link**
      to it — never create a second account.

### 2. Existing users → "Connect Discogs"
- [ ] Surface a "Connect Discogs" option in the app (settings / library header).
- [ ] Connecting runs the same OAuth flow, then imports their collection into their
      existing library.
- [ ] **No duplicates:** merging Discogs into an already-populated library must not
      double up albums they added manually. Dedup on resolved `itunes_collection_id`
      when known, and on `discogs_release_id` otherwise.

### 3. "Sync Discogs" button
- [ ] Button in the library that re-pulls the collection and adds anything new.
- [ ] **Incremental:** Discogs collection items carry a date-added — sort by newest
      and stop once we hit records we already have, so a re-sync is cheap.
- [ ] Show sync state (last synced, in-progress, "N new records added").

### 4. Lazy lyrics + side info on first play (with a loading bar)
- [ ] Import does NOT fetch lyrics/side data. That happens on **first open/play** of
      an album that isn't enriched yet.
- [ ] Loading bar when opening an un-enriched album: "Fetching lyrics and side info
      for _____" — cycle real track titles through the blank so it visibly feels like
      work is happening, not lag/breakage.
- [ ] Enrichment reuses the existing add-to-library pipeline (iTunes match + LRCLib +
      Discogs sides), just triggered lazily instead of at import.
- [ ] If an album has no iTunes match or no lyrics, still show it as owned with a clear
      "lyrics unavailable / pending" state — never a silent dead end.

### 5. Only import albums they OWN
- [ ] Pull from collection folder **0 ("All")** — their actual owned records only.
- [ ] Never dump search results or the community DB into a user's library.
- [ ] Handle duplicate copies of the same release (Discogs allows multiple; each has
      its own `instance_id`) without showing the album twice.

### 6. Minimize Discogs calls (rate limit = 60/min authenticated)
- [ ] Import stores ownership **cheaply** first — just what the collection-list
      endpoint returns (100 items/page: artist, album, year, thumb, release_id,
      instance_id). No per-release detail calls at import time.
- [ ] Defer per-release detail + iTunes match + lyrics to lazy enrichment (step 4).
- [ ] **Reuse the community `vinyl_releases` DB:** if a user's release resolves to an
      iTunes collection we already seeded, take its side data for free — no re-fetch.
- [ ] Background enrichment is rate-limited + resumable (copy `seed-vinyl-discogs.js`).
- [ ] Cache release detail (the lookup proxy already sets `s-maxage`).

---

## The storage change (why the schema has to move)
Today `user_library` **requires** `itunes_collection_id`. A freshly imported Discogs
record doesn't have one yet. So:

- [ ] Make a library item able to exist with `itunes_collection_id` **nullable/pending**.
- [ ] Add `discogs_release_id` (+ `discogs_instance_id`) columns as the stable import key.
- [ ] Add an `enrichment_status` (e.g. `owned` → `enriching` → `ready` / `unavailable`).
- [ ] Idempotent re-sync: keying on `discogs_release_id` means re-imports update, never
      duplicate.

**Mental model:** the collection is its own thing with a *sync relationship* to Discogs;
iTunes-matching becomes lazy background enrichment, not a gate on import.

---

## Edge cases to not forget
- [ ] Private collections (fine — we're authed as the owner via their token).
- [ ] Very large collections (thousands): import the *list* fast; enrich slowly. Never
      block the UI on a full sync.
- [ ] Re-connecting / re-authing an already-linked account (refresh token, don't dup).
- [ ] Disconnect Discogs: what happens to imported records? (keep, but stop syncing).
- [ ] Records with no iTunes match at all — still owned, lyrics unavailable.
- [ ] Token revoked on Discogs' side → detect 401 and prompt reconnect.

---

## Guardrails
- Work + test **only** on the `discogs-integration` branch. Nothing to `main` until it's
  proven on the preview URL.
- Preview URL (updates on every push to this branch):
  `https://liri-git-discogs-integration-melonmonster330s-projects.vercel.app`
</content>
</invoke>
