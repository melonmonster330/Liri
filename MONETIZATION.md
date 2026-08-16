# Liri Monetization — Strategy

Living doc. Captures the money plan so it survives between sessions. Pairs with
SOCIAL_PLAN.md (the social layer is the growth engine that makes any of this
worth doing).

---

## Current state: Liri is free

**As of 2026-08-16 there is no payment system.** Subscriptions, Stripe, Apple
IAP, and the 10-record free limit were removed from the whole product — web,
iOS, API, and database. Every account has an unlimited library and every
feature. There is no premium tier, no upgrade path, and no paywall copy
anywhere in the app.

The `subscriptions` table was dropped (`20260816_drop_subscriptions.sql`).
The native StoreKit plugin (`ios/App/CapApp-SPM/Sources/CapApp-SPM/LiriIAPPlugin.swift`)
is still in the Xcode project but nothing calls it.

---

## Guiding principle

Liri's differentiator is a **calm, premium-feeling, minimal** vinyl-and-lyrics
ritual. That immersion *is* the product. Every monetization choice is judged
against: **does this protect or erode the core experience?**

- Protects → fair game.
- Erodes → avoid, even if it looks like easy money.

---

## If paid ever comes back

The intent is **not** to re-gate the library. If there's a paid tier again, the
thing it buys is **removing ads** — not unlocking records. That only makes
sense once ads exist, and ads only make sense at meaningful DAU, so this is far
out.

Rough ordering if it ever happens:

1. **Build the audience first.** Social + lyric-quote posts. Don't monetize an
   app people aren't hooked on.
2. **Then ads, tastefully.** Feeds are where users *expect* ads, so a native ad
   every N posts is defensible. A silent image card at the LP flip or side
   change is also acceptable — the flip is already a natural pause. Never
   mid-song, never audio.
3. **Then, optionally, ad-free as a paid upgrade.** That's the premium pitch:
   pay to remove ads. Not "pay to add records."

**Audio ads between songs — AVOID.** Injecting audio into the listening ritual
shatters exactly the mood people came for. Not planned.

Note before charging anyone: LRCLib is not licensed for commercial use, so the
lyrics provider has to change first (see NEXT_STEPS.md).

---

## Change log

- 2026-08-16 — **Payment system removed entirely.** Unlimited records for
  everyone; all premium/subscription code and copy deleted across web, iOS,
  API, and Supabase. Strategy reframed: if paid returns, it buys ad-removal,
  not library access.
- 2026-05-29 — Initial strategy. Subscription = primary engine, feed ads =
  secondary at scale, audio-between-songs = avoid. Lyric-quote posts promoted
  to MVP as both the growth hook and a premium feature.
