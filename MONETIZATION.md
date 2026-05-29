# Liri Monetization — Strategy

Living doc. Captures the money plan so it survives between sessions. Pairs with
SOCIAL_PLAN.md (the social layer is the growth engine that makes any of this
worth doing).

---

## Guiding principle

Liri's differentiator is a **calm, premium, minimal** vinyl-and-lyrics ritual.
That immersion *is* the product. Every monetization choice is judged against:
**does this protect or erode the core experience?**

- Protects → fair game.
- Erodes → avoid, even if it looks like easy money.

---

## Revenue engines (in priority order)

### 1. Subscription — PRIMARY (already wired via Stripe)
A small paying base monetizes far better than ads do at Liri's scale.
- Keep a **free tier** generous enough to grow, gated by a clear upgrade nudge.
- Reframe the free limit as a **feature gate**, not just "10 albums":
  - **Free:** listen + sync lyrics, basic profile, basic posting.
  - **Premium:** unlimited library, **lyric-quote posts (with music clip)**,
    profile customization, auto-post, ad-free feed, early features.
- Don't *remove* the free limit in exchange for ads — the limit is the upgrade
  driver; trading it for ad revenue we can't yet earn is a bad swap.
- Apple takes 15–30% on IAP; digital subscriptions MUST use IAP on iOS.

### 2. Feed ads — SECONDARY, only at scale
Feeds are where users *expect* ads, so a tasteful native ad every N posts is
defensible — but ads only pay real money at meaningful DAU (CPMs are low).
- Free tier sees occasional native ads in the feed; **premium = ad-free**
  (another upgrade reason).
- Build only after the social layer has real daily usage. Premature ads kill
  the growth that makes ads worth anything.

### 3. Audio ads between songs — AVOID
Injecting an audio ad into someone's vinyl listening ritual shatters exactly
the mood they came for. Fast path to feeling cheap and bleeding retention.
Spotify can do it at utility scale; a boutique vinyl app cannot. **Not planned.**

---

## Sequencing

1. **Now:** make it stand out & sticky — social + **lyric-quote posts** (the
   Liri-unique, shareable hook). Don't monetize an app people aren't hooked on.
2. **Then:** tighten the subscription value prop (premium features above).
3. **At scale:** add tasteful native feed ads for free users; premium stays
   ad-free.

---

## Change log

- 2026-05-29 — Initial strategy. Subscription = primary engine, feed ads =
  secondary at scale, audio-between-songs = avoid. Lyric-quote posts promoted
  to MVP as both the growth hook and a premium feature.
