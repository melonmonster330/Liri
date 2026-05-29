# Liri Social — Product & Implementation Plan

Living doc. Captures the social-layer pivot so ideas don't get lost between sessions.

---

## Vision

Turn Liri from "lyrics-for-vinyl utility" into a **social companion for vinyl listening** — a place where friends share what they're spinning, with lyrics as the native medium.

Tagline direction: *"See what your friends are spinning."*

---

## MVP Scope (build now)

### Social primitives
- **Asymmetric follows** (Instagram-style)
  - One-way edge: follower → followed
  - "Friends" = computed mutual follow
- **Follow requests** for non-public profiles
  - Public profile → instant follow
  - Private / friends-only → approval required
- **Likes** on posts (no comments yet)

### Profiles
- Every user gets a profile page (e.g. `getliri.com/helen`)
- Privacy tiers:
  - **Private** — only you can see your posts/history
  - **Friends-only** — mutual follows only
  - **Public** — anyone, including non-followers
- **Default = private** for new accounts
- Profile shows: username, avatar, bio, follower/following counts, posts tab, history tab

### Posts
- Anchored to **album** or **track**
- Optional caption
- Two sources:
  1. **Manual** — user taps "share" on an album/track
  2. **Auto** — opt-in auto-post when an album is played end-to-end
     - Per-post privacy override allowed (auto-post can be private even if profile is public)
     - Default for auto-posts: off (user enables in settings)

### Feed
- Reverse-chronological scroll
- Shows posts from people you follow
- **Active posts only** — does NOT mix in raw scrobble history (keeps signal high)
- Auto-posts DO appear in feed (they're still "posts," just generated)

### Profile timeline
- Two tabs:
  - **Posts** — manual + auto-posts (subject to privacy)
  - **History** — quieter listening log (album plays), respects privacy

---

## Deferred (future wants)

Park here so we don't lose them. Don't build until MVP ships and gets used.

- **Comments** on posts
- **Lyrics PiP / persistent panel** — floating or docked lyrics that stay visible while scrolling feed/library
- **Live "currently listening"** presence/broadcast (requires realtime/websockets)
- **Lyric-quote posts** — highlight a lyric line, share it as a post. Liri's unique angle; high-priority once MVP is live.
- **Discovery** — suggested follows, trending albums among friends
- **Notifications** — likes, new followers, follow requests
- **Block / mute**
- **Sharing out** — share a post/profile to iMessage, Instagram Stories, etc.

---

## Data Model (draft — Supabase / Postgres)

> Slots into existing Supabase setup. RLS policies enforce privacy tiers.

```
profiles
  id (uuid, FK auth.users)
  username (unique, citext)
  display_name
  avatar_url
  bio
  privacy ENUM('private','friends','public') DEFAULT 'private'
  auto_post_plays BOOL DEFAULT false
  created_at

follows
  follower_id (FK profiles)
  followed_id (FK profiles)
  status ENUM('pending','accepted')  -- pending = follow request
  created_at
  PK (follower_id, followed_id)

posts
  id (uuid)
  author_id (FK profiles)
  kind ENUM('album','track')
  album_id (FK albums, nullable)
  track_id (FK tracks, nullable)
  caption (text, nullable)
  source ENUM('manual','auto')
  visibility ENUM('private','friends','public')  -- per-post override
  created_at

likes
  post_id (FK posts)
  user_id (FK profiles)
  created_at
  PK (post_id, user_id)

play_history  -- may already exist; check before adding
  id
  user_id
  album_id / track_id
  played_at
  completed BOOL  -- did they play it end-to-end (gates auto-post)
```

### Derived
- **friends(user)** = `SELECT followed_id FROM follows WHERE follower_id = user AND status='accepted' INTERSECT SELECT follower_id FROM follows WHERE followed_id = user AND status='accepted'`
- **can_see(viewer, author)** = author public OR viewer follows author (accepted) OR (author=friends AND mutual) OR viewer=author

---

## Open Questions (resolve before coding)

1. **Does `play_history` exist already?** Auto-posts depend on a "completed play" signal. If plays aren't logged, that's step zero.
2. **Username collisions** — claim flow for new users? Reserved names?
3. **Profile URL routing** — is `getliri.com/<username>` feasible with current Vercel/Capacitor setup, or do we need `/u/<username>`?
4. **Avatar storage** — Supabase Storage bucket, or external?
5. **Rate limits** on follow requests / posts to prevent spam.

---

## Suggested Build Order

1. **Foundation**
   - `profiles` table + username claim on signup
   - Profile page (read-only, own profile)
   - Privacy setting toggle
2. **Follow graph**
   - `follows` table + RLS
   - Follow / unfollow / request flow
   - Followers/following lists
3. **Posts**
   - Manual share flow from album/track screens
   - Post detail view
4. **Feed**
   - Scrollable feed of followed users' posts
   - Empty state ("follow some people to see posts")
5. **Likes**
6. **Auto-posts**
   - Hook into play-completion event
   - Settings toggle
7. **History tab on profile**

---

## Out of scope forever (probably)

- DMs / chat
- Stories (24h ephemeral content)
- Algorithmic feed ranking
- Ads

---

## Change log

- 2026-05-22 — Initial plan. MVP scope locked: follows (Instagram-style), posts (manual + auto), likes, profile pages with 3 privacy tiers, default private. Comments / PiP / live presence deferred.
- 2026-05-29 — **Lyric-quote posts promoted from Deferred → MVP** (the Liri-unique, shareable hook; also a premium feature per MONETIZATION.md). Posts + likes schema landed (`20260529_posts_likes.sql`): `posts` (kind album/track/lyric, per-post visibility, denormalized display fields, optional lyric timestamp window for a future audio clip) + `likes` (with denormalized `like_count` trigger) + `can_see_post()` RLS helper. Next: client compose flow (album/track/lyric share), feed render, like button. Monetization strategy captured in MONETIZATION.md (subscription primary, feed ads at scale, no audio ads).
