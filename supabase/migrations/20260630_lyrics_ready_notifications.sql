-- Tracks which (user, album) pairs have already been emailed about
-- their album's lyrics being complete. Inserted once when the
-- nightly cron sends the "lyrics ready" email; presence of a row
-- means we've notified that user about that album.
--
-- Compound primary key (user_id, itunes_collection_id) gives us
-- both natural deduplication AND a fast lookup index.

create table if not exists lyrics_ready_notifications (
  user_id              uuid not null references auth.users(id) on delete cascade,
  itunes_collection_id bigint not null,
  sent_at              timestamptz not null default now(),
  resend_message_id    text,
  primary key (user_id, itunes_collection_id)
);

-- Cron job uses service role and bypasses RLS — but lock down anything
-- else that touches this table by enabling RLS with no policies.
alter table lyrics_ready_notifications enable row level security;
