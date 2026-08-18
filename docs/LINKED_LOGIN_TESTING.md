# Linked login — web test plan

Branch: `codex/linked-login`

## Account model

- One Supabase `auth.users` row is the Liri account.
- Google and Apple are Supabase identities linked to that user.
- Discogs is a custom identity stored in `user_discogs_accounts`; its
  `discogs_user_id` is unique across Liri accounts.
- Signing in through any connected method opens the same Liri user id and
  therefore the same profile, library, history, and subscription.

Discogs-first accounts use a private placeholder auth email because Discogs is
not a native Supabase provider. It is never used to send mail. The Discogs OAuth
callback proves ownership and completes login through a server-generated,
single-use Supabase link.

## One-time setup before testing

1. Run `supabase/migrations/20260818c_discogs_login.sql` in Supabase.
2. In Supabase Auth, enable Google and configure its client id and secret.
3. Enable manual identity linking in Supabase Auth.
4. Add the branch preview's `/app` URL to Auth's allowed redirect URLs.
5. Leave the existing Discogs preview callback registered in the Discogs app.

The feature includes both web and iOS. Web can be verified from a branch preview
first. Google and Apple native callbacks should be verified later from an iOS
debug/TestFlight build without changing the underlying account model.

The native app uses `liri://auth/callback`. Add that URI to Supabase's allowed
redirect URLs before iOS testing. OAuth opens in Capacitor's external browser and
the App plugin passes the PKCE code (or Discogs one-time session) back into Liri.

## Fresh Discogs account test

1. Open the preview in a private browser window.
2. Choose **Sign In** → **Continue with Discogs**.
3. Authorize the dedicated test Discogs account.
4. Confirm Liri opens signed in and Settings shows that Discogs username.
5. Add or sync a record and note the Liri user id from the admin dashboard.
6. Sign out, choose **Continue with Discogs** again, and confirm it returns to
   the same Liri user id with the same data.

## Full reset between creation tests

1. While signed into the dedicated Liri test account, open Settings.
2. Choose **Delete account** and confirm deletion.
3. Confirm the user no longer appears in the Liri admin dashboard.
4. Start **Continue with Discogs** again using the same external Discogs test
   account. It must create a new Liri user id with an empty Liri history.

Deleting the Liri auth user cascades to `profiles`, `user_discogs_accounts`, and
`user_discogs_collection`. It does **not** delete or modify the account at
Discogs, so the same Discogs login can be reused for every clean test cycle.

## Existing main-account linking test

1. Sign into the existing Liri account normally.
2. In Settings → **Ways to sign in**, connect Google.
3. Sign out and choose **Continue with Google**.
4. Confirm the Liri user id and existing library are unchanged.
5. Connect Discogs from the same signed-in Settings screen if that Discogs
   identity should also open this account.

If a Discogs identity is already attached to another Liri account, Liri refuses
to move it. Disconnect it from that account or delete the dedicated test account
first. This prevents accidental account takeover or silent data merging.
