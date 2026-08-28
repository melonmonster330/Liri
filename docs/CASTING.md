# TV display setup

Liri supports two transports that share the same full-screen lyric receiver:

- Google Cast for Chromecast and Google TV.
- A four-digit room code for smart-TV browsers and the packaged Samsung app.

## Universal TV-code flow

1. Open `https://getliri.com/tv`, or launch the installed Liri Samsung app.
2. Open the TV panel in Liri while signed in.
3. Enter the four-digit code shown on the TV and select **Connect**.
4. Verify artwork, lyrics, pause/resume, timing nudges, and track changes update.
5. Select **Disconnect TV** and verify the pairing screen returns.

The sender upserts the authenticated user's row in `cast_sessions`; the TV has
read-only access and subscribes through Supabase Realtime. Receivers discard
stale sessions after 15 seconds without a sender update.

## Google Cast setup

Liri uses a Custom Web Receiver. Desktop Chrome is the sender; `tv.html` is the
receiver rendered by Chromecast or Google TV. No audio is cast and the browser
is not mirrored.

## Cast Console

The web sender currently uses receiver application ID `2FBB66AA`. In the
[Google Cast SDK Developer Console](https://cast.google.com/publish/), confirm
that this application:

- is a **Custom Receiver**;
- points to `https://getliri.com/tv`;
- includes the Chromecast/Google TV being used for unpublished testing.

After adding a test device, allow several minutes for registration to propagate
and reboot the device before testing.

## Test flow

1. Deploy the current web build so `https://getliri.com/tv` contains the matching
   receiver protocol.
2. Put the computer and Cast device on the same network.
3. Open Liri in desktop Google Chrome and start synced lyrics.
4. Select the Cast icon in the now-playing header and choose the TV.
5. Verify song metadata, artwork, and highlighted lyrics appear.
6. Verify pause/resume, early/behind nudges, and automatic track advance update
   the TV within about one second.
7. Stop casting and verify the receiver returns to its waiting screen.

## Protocol

Namespace: `urn:x-cast:com.getliri.lyrics`

- `SESSION_START`: complete current receiver state. Sent immediately on
  connection and once per second while connected. It includes legacy field
  aliases so preview senders can work with the receiver URL currently registered
  in the Cast Console. The receiver advances its clock locally between messages.
- `SESSION_END`: clears the lyrics and returns the receiver to its waiting state.

iOS/Capacitor sender integration is intentionally out of scope for this version.
