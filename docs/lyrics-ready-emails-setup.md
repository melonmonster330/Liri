# "Lyrics ready" email setup

The nightly cron at `/api/refresh-lyrics?action=lyrics-ready-emails` emails
users when an album in their library reaches full lyric coverage. Before it
can actually send, three things need to be in place.

## 1. Apply the migration

Run `supabase/migrations/20260630_lyrics_ready_notifications.sql` against
the production database (Supabase dashboard → SQL editor → paste → run).
This creates the dedup table that tracks who's already been emailed about
which album.

## 2. Set up Resend

1. Sign up at resend.com
2. Add `getliri.com` as a sending domain → copy the DNS records into your
   DNS provider (4 records: 1 MX, 2 TXT for DKIM, 1 TXT for SPF). Verify.
3. Create an API key → copy the value (`re_...`).

## 3. Add env vars in Vercel

Project → Settings → Environment Variables:

| Key | Value |
| --- | --- |
| `RESEND_API_KEY` | the `re_...` key from step 2 |
| `RESEND_FROM` | `Liri <hello@getliri.com>` (or whatever from-address matches the verified domain — defaults to `hello@getliri.com` if unset) |

`CRON_SECRET` and `SUPABASE_SERVICE_ROLE_KEY` are already in place.

## Testing

**Dry run** (no email sent, no DB write — returns the list of who *would*
get emailed):

```bash
curl -X POST -H "x-cron-secret: $CRON_SECRET" \
  "https://getliri.com/api/refresh-lyrics?action=lyrics-ready-emails&dry=1"
```

**Live run** (actually sends + records):

```bash
curl -X POST -H "x-cron-secret: $CRON_SECRET" \
  "https://getliri.com/api/refresh-lyrics?action=lyrics-ready-emails"
```

The Vercel cron at `0 14 * * *` (daily 14:00 UTC / 9am CST) runs this
automatically. Vercel adds an `x-vercel-cron` header which the endpoint
trusts in lieu of the secret.

## How it decides who gets emailed

1. Find albums where **every track** in `album_tracks` has a `track_lyrics`
   row with non-null `lrc_raw` or `lyrics_plain`.
2. Find users whose `user_library` contains one of those albums.
3. Skip any `(user_id, itunes_collection_id)` pair that already has a row
   in `lyrics_ready_notifications` (we've emailed them already).
4. Send + insert a notification row keyed on (user, album) — that's what
   makes it one-shot per user per album.

## Email content

Each email contains:
- Subject: `Good news — Liri now has the full lyrics for <Album>`
- Album artwork + title + artist
- A "Sync now →" button linking to `https://getliri.com/library?sync=<cid>`

The `?sync=NNN` param on the library page sets the turntable to that album
and redirects to the main sync screen (see `library.html`).

## Pause / stop

To pause: remove the cron entry from `vercel.json` and redeploy. The
endpoint still works for manual runs.

To stop entirely: delete the env vars in Vercel — the endpoint will return
`stage: "no-resend-key"` style errors but won't try to send.
