# Samsung TV and device handoff plan

## Product definition

Liri works independently on every signed-in device. **Switch devices** moves the
user's live lyric session to another online device. The session belongs to the
account, not to the device that originally recognized or selected the record.

**Standalone TV operation is a launch requirement.** A user must be able to
install Liri, create an account or sign in, browse their library, choose an
album and track, start lyrics, and control the entire session using only the
Samsung remote. A phone, computer, Smart View, or another running Liri client
must never be required for normal use.

For the first release, Liri continues to follow physical audio rather than play
audio through the TV. The active device owns the lyric clock and displays the
synced lyric experience.

## First-release experience

### Start on the web, continue on TV

1. The user starts a synced record in web Liri.
2. They open **Playing on** and choose **Living Room TV**.
3. The TV receives the complete session and opens the same track and lyric
   position.
4. The web app shows **Playing on Living Room TV** and can remain a remote.
5. Choosing **This computer** transfers clock ownership back to the web app.

### Start on TV, continue on the web

1. The user opens Liri on the TV, signs in if needed, and browses their library.
2. They choose an album and track using the Samsung remote.
3. The TV becomes the active device and starts the lyric clock without another
   Liri device being online.
4. Web Liri shows **Playing on Living Room TV** if it is opened later.
5. The user can control the TV session or transfer it to **This computer**.

Automatic recognition is not part of the Samsung TV release. Recognition can
still happen on web or iPhone before the session is transferred to the TV.

## Scope

### MVP

- A packaged Samsung Tizen web application with remote-control navigation.
- Complete TV-only authentication. The user can create an account or enter their
  email and password with the Samsung on-screen keyboard and complete sign-in
  without another Liri device. Password-reset and email-verification states must
  be handled clearly. A QR/short-code flow can also be offered as a faster
  optional method, but it cannot be the only method.
- Complete TV-only library and playback flow: browse/search the user's library,
  choose an album, choose a track, start the lyric clock, pause/resume, nudge
  timing, change tracks/sides, and end the session with the remote.
- User-editable TV name, defaulting to a friendly Samsung model/device name
  where available.
- Account device list with online/offline state and last-seen time.
- One live listening session per account.
- Transfer of song, lyrics, position, pause state, album context, and track
  index between web and Samsung TV.
- Exactly one clock owner at a time, protected by a monotonically increasing
  ownership generation.
- Web controls for pause/resume, timing nudges, track selection, and transfer
  while the TV owns the session.
- Recovery after refresh, temporary disconnect, or app restart from the last
  persisted session snapshot.

### Later

- App launch/discovery through Smart View or Samsung platform integrations.
- Background notifications or wake-up, where Samsung policy and model support
  permit them.
- iPhone, Apple TV, Android TV, and additional browser devices.
- Multiple concurrent listening sessions for one account.
- TV-side automatic recognition.
- Migration of Chromecast from its sender-owned receiver model into the shared
  account device model.

## Architecture

### Clients

- **Existing web/iOS client:** remains the recognition-capable client and gains
  a platform-neutral device-session hook and **Playing on** sheet.
- **Samsung client:** a separate Tizen web application under `samsung-tv/`,
  built as a signed widget with `config.xml`, a 16:9 ten-foot UI, spatial focus,
  and Samsung remote key handling.
- **Supabase:** owns device registration, live session snapshots, commands,
  presence, authorization, and realtime delivery.

The Samsung app should not be an iframe or a wrapper around `tv.html`.
`tv.html` remains the Chromecast custom receiver until that product is
deliberately migrated.

### Proposed data model

#### `account_devices`

- `id uuid primary key`
- `user_id uuid not null`
- `name text not null`
- `platform text not null` (`web`, `ios`, `samsung_tv`, later others)
- `installation_id text not null`
- `model text`
- `app_version text`
- `last_seen_at timestamptz not null`
- `created_at timestamptz not null`
- `revoked_at timestamptz`
- unique `(user_id, installation_id)`

#### `listening_sessions`

- `id uuid primary key`
- `user_id uuid not null unique` for the MVP's one-session-per-account rule
- `owner_device_id uuid not null`
- `owner_generation bigint not null default 1`
- `status text not null` (`playing`, `paused`, `ended`)
- `song jsonb not null`
- `lyrics jsonb not null`
- `album_context jsonb`
- `track_index integer`
- `position_seconds numeric not null`
- `position_recorded_at timestamptz not null`
- `updated_at timestamptz not null`

The calculated live position is:

`position_seconds + (now - position_recorded_at)` when playing, or simply
`position_seconds` when paused.

#### `device_commands`

- `id uuid primary key`
- `session_id uuid not null`
- `user_id uuid not null`
- `target_device_id uuid not null`
- `owner_generation bigint not null`
- `kind text not null` (`take_ownership`, `pause`, `resume`, `seek`,
  `select_track`, `end`)
- `payload jsonb`
- `created_at timestamptz not null`
- `acknowledged_at timestamptz`

Commands give reconnecting devices a durable catch-up path. Supabase Realtime
delivers them quickly, while the rows prevent a missed broadcast from silently
losing a transfer or control action.

#### `device_activation_codes`

- Optional convenience flow, not a dependency of the Samsung app.
- A server-managed, short-lived, single-use code linked to an unclaimed TV
  installation.
- The signed-in web/mobile user approves the code.
- A server endpoint exchanges the approved activation for TV credentials and
  immediately invalidates the code.
- Codes must never grant access through a publicly readable table.

### Clock ownership and handoff

1. The controller calls a database function to transfer the session to a target
   device.
2. The function locks the session row, increments `owner_generation`, records a
   fresh position anchor, changes `owner_device_id`, and inserts a
   `take_ownership` command in one transaction.
3. The target receives the command, reloads the authoritative snapshot, and
   acknowledges the command.
4. A device may publish clock anchors only when both its device ID and ownership
   generation match the session row.
5. The former owner immediately stops its local clock-authority writes when it
   observes the higher generation.

This generation check is the split-brain fence: a delayed or reconnected former
owner cannot overwrite the new owner's position.

### Presence and recovery

- Online state is derived from a realtime presence channel plus a persisted
  `last_seen_at` heartbeat; presence gives immediate UI and the timestamp gives
  recovery after disconnects.
- Devices heartbeat about every 10 seconds while foregrounded. A device is
  considered offline after roughly 30 seconds without presence or heartbeat.
- The clock owner writes a compact position anchor every few seconds and on
  pause, seek/nudge, track change, visibility change, and unload.
- On reconnect, every client reads the database snapshot before accepting new
  realtime events.
- If the owner disappears, the session stays assigned to it. Another online
  device can explicitly take ownership; automatic failover is deferred until
  its UX is defined.

### Security

- Row-level security limits every device, session, and command to `auth.uid()`.
- Clients cannot claim another user's device or write a lower/foreign ownership
  generation.
- Ownership transfer and activation use security-definer database functions or
  authenticated server endpoints with narrow validation.
- Activation codes expire quickly, are rate-limited, and are stored hashed.
- Device revocation invalidates its refresh credentials and marks it revoked.
- Lyrics/session data is private to the account; no public room-code reads.

## Compatibility target

The first implementation should target Samsung Tizen web apps from the 2020
model year onward. This offers a practical initial browser baseline while still
covering several generations. Exact oldest-model support should be finalized
after running the skeleton on a physical target TV; the app build must avoid
unsupported JavaScript and CSS features for the chosen floor.

Samsung distribution is a separate release track: the widget must be signed,
tested on an emulator and physical TV, submitted through Seller Office, and pass
Samsung verification before public availability.

## Delivery phases

### Phase 0 — decisions and development setup

- Confirm the oldest Samsung model year to support and obtain one physical test
  TV's model/year.
- Install Tizen Studio, TV extensions, and Samsung certificate tooling.
- Create and securely back up the author/distributor certificates.
- Confirm Seller Office access and intended launch countries.
- Record the device naming, native TV sign-in, and optional activation UX.

**Exit:** a signed hello-world widget runs on the target TV.

### Phase 1 — shared session backend

- Add migrations for devices, sessions, commands, activation, RLS, indexes, and
  transactional RPCs.
- Add automated database/RLS tests for cross-account isolation, generation
  fencing, expired activation, and command acknowledgement.
- Add server endpoints only where a public client cannot safely perform the
  operation directly.

**Exit:** two test clients can securely register, observe one session, and
transfer ownership without split brain.

### Phase 2 — web device foundation

- Extract a canonical session snapshot from the state currently owned by
  `app/src/main.js`.
- Add a platform-neutral `useDeviceSession` hook; do not fold this into
  `useCast`, because Chromecast has different ownership semantics.
- Reconcile local restore in `useNowPlaying` with the account snapshot so local
  storage cannot revive a stale owner.
- Build the **Playing on** sheet, presence list, transfer confirmation/error
  states, and remote-mode controls.
- Keep the existing Chromecast flow working unchanged.

**Exit:** two web browsers signed into the same account can transfer the live
session and survive refresh/reconnect.

### Phase 3 — Samsung TV application

- Scaffold `samsung-tv/` with `config.xml`, build scripts, TV-safe assets, and a
  conservative JavaScript target.
- Build native TV sign-in, optional activation, home/library/search,
  album/track selection, now-playing lyrics, offline/reconnect, and
  account/device settings screens.
- Implement deterministic remote focus and Back/Exit behavior.
- Reuse pure lyric/session utilities where practical, without importing the
  large web app bundle.

**Exit:** after installation, a physical TV can create an account or sign in and
complete a full listening session with no phone or computer present. It also
supports optional activation, incoming transfer, outgoing transfer, restart
recovery, and revocation.

### Phase 4 — hardening and release

- Test clock drift, rapid transfers, owner crash, network loss, stale commands,
  account sign-out, device revocation, large lyric payloads, and long albums.
- Test supported TV years/resolutions and accessibility/readability at distance.
- Add privacy disclosures, support instructions, store art/screenshots, version
  handling, and deployment runbook.
- Submit to Samsung Seller Office and address verification findings.

**Exit:** approved production app with monitored backend and documented support.

## Recommended first implementation slice

Build Phase 1 plus the smallest Phase 2 proof: two web tabs using separate test
device identities, a visible **Playing on** selector, and an ownership transfer.
This validates the hardest invariant—one authoritative lyric clock—before Tizen
UI work or store setup can obscure backend problems.

### Implementation status

- Started 2026-07-18 on `codex/samsung-tv-device-handoff`.
- Added the device/session/command/activation schema, account-only RLS, realtime
  publication setup, and generation-fenced RPCs.
- Added the platform-neutral web device client for registration, heartbeat,
  account observation, publishing, transfer, commands, acknowledgement, and
  device naming.
- Next: expose the canonical web playback snapshot and build the first
  **Playing on** selector for a two-browser handoff test.

## Acceptance tests for the first slice

- Starting lyrics creates or updates the account's live session.
- Both device identities appear online with unique names.
- Switching devices preserves track, lyrics, pause state, album context, track
  index, and position within a one-second visual tolerance.
- The old owner stops publishing authoritative anchors after transfer.
- A stale owner-generation write is rejected by the backend.
- Refreshing either device reconstructs the correct owner and position.
- Disconnecting and reconnecting the target does not duplicate or rewind the
  session.
- A user cannot read, command, or claim another user's session or device.
- Existing recognition, local navigation restore, pause/nudge, track advance,
  and Chromecast behavior remain intact.

## Standalone Samsung acceptance tests

- A new user can install, create an account, and sign in using only the TV and
  remote (apart from opening any required verification email).
- A returning user stays securely signed in after closing or restarting the app.
- The user can browse and search their Liri library without another device
  online.
- The user can select an album and track, start lyrics at a chosen position,
  pause/resume, nudge timing, change tracks/sides, and end playback from the TV.
- Loss of another Liri device has no effect on a TV-owned session.
- Loss of the network produces a clear recoverable state; restored connectivity
  reloads the account session without requiring phone approval.
- Signing out or revoking the TV removes locally stored account credentials.

## Open product decisions

1. Oldest Samsung TV model year to support.
2. Whether the web app remains a full remote after transfer or defaults back to
   the library with a compact now-playing bar. Recommendation: remain a remote
   until the user dismisses it.
3. Whether an offline device remains selectable. Recommendation: show it but
   disable transfer and display its last-seen time.
4. What happens when a second session starts on another device. Recommendation:
   replace the account's current session only after a clear confirmation.
5. Whether Chromecast remains labeled **Cast** or appears in **Playing on**
   before it gains account ownership semantics. Recommendation: keep it
   separate for the MVP so the UI does not promise unsupported reverse handoff.
