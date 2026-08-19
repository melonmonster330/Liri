# Private lyrics and daily catalogue research

User-entered lyrics live in `user_track_lyrics` and are visible only to their
owner through RLS. The app overlays that row on `track_lyrics`, so personal
lyrics take effect immediately without modifying the shared catalogue.

The editor's catalogue-review checkbox is off by default. When enabled, the
submission is marked `pending`; the service-role daily worker may inspect it.

`/api/lyrics-agent` runs daily at 12:00 UTC, before the existing lyrics-ready
email job at 14:00 UTC. For each open/backlogged `missing_lyrics` report it:

1. closes stale reports whose canonical row already exists;
2. searches the existing LRCLIB/Genius provider chain;
3. validates opted-in user candidates if providers miss;
4. promotes user text only when two independent users submitted matching text;
5. leaves a single valid candidate in `needs_review`;
6. rejects malformed, webpage-like, or duration-invalid candidates.

Per-report failures are returned as `status: "error"`, moved to the back of
the queue, and eventually backlogged. One problematic catalogue row therefore
cannot abort the rest of the daily batch.

The worker contains no model call and never generates, completes, paraphrases,
or reconstructs lyrics.

Apply `supabase/migrations/20260818_private_user_lyrics.sql` before deploying
the client changes. The migration also removes authenticated client writes to
canonical `track_lyrics`; service-role jobs and admin APIs remain able to write.

Manual authenticated run:

```sh
curl -H "x-cron-secret: $CRON_SECRET" https://www.getliri.com/api/lyrics-agent
```

The endpoint requires `CRON_SECRET` either in `x-cron-secret` or as a bearer
token. It does not trust `x-vercel-cron` alone. Vercel automatically sends the
bearer token for scheduled jobs when the project secret is configured.

Tune the daily batch with `LYRICS_AGENT_BATCH_LIMIT` (default 20, maximum 50).
