# Liri — Legal Research & Licensing Notes

> **Important disclaimer**: This document is research, not legal advice. Before monetizing Liri, consult an IP attorney who specializes in music licensing. The music industry's licensing structure is genuinely complex, and getting it wrong can be expensive.

---

## The three legal questions Liri needs to answer

1. **Can we display song lyrics?** (Display rights / lyric licensing)
2. **Can we use audio fingerprinting to identify songs?** (Recognition API licensing)
3. **Can we charge money for it?** (Commercial licensing requirements)

---

## Question 1: Displaying Lyrics

### What are "display rights"?

When lyrics appear on a screen, that's called a *lyric display* (sometimes "print rights" or "lyric sync display rights"). These are separate from:
- **Performance rights** — playing music in public (ASCAP, BMI, SESAC)
- **Mechanical rights** — reproducing/distributing recorded music (MLC in the US)
- **Synchronization rights** — pairing music with video

Lyric display rights are controlled by music publishers. For Taylor Swift:
- Early catalog (Big Machine years): Owned/controlled by **UMPG (Universal Music Publishing Group)** following the Ithaca Holdings / Braun dispute
- Taylor's Version and current work: **UMPG** (Taylor re-signed)
- Bottom line: **UMPG controls essentially all Taylor Swift lyric display rights**

### What does this mean for Liri?

**For personal/prototype use**: Showing lyrics to yourself in your own home is not commercially meaningful. No one gets sued for printing lyrics on a Post-it note.

**For a public app**: Once Liri is distributed publicly — even for free — displaying lyrics from a library without a license is a legal risk.

### The commercial lyric licensing landscape

There are three realistic paths:

**Path A: License through a lyric data provider**
These companies have already done the work of licensing lyrics from publishers and will sublicense to app developers:
- **MusixMatch** — the dominant player. Has licensing deals with all major publishers. Their API has a free tier (limited use) and commercial tiers. Commercial licensing requires a direct conversation with their team, as pricing is custom. Typically quoted around $500+/month for commercial apps, but varies wildly by usage and negotiation.
- **Genius** — has lyric data and an API, but their commercial licensing situation is messier. They've been in disputes with Google over lyric scraping. Their API Terms of Service restrict commercial use without a separate agreement.
- **LyricFind** — another major provider with publisher deals. Used by Spotify, Amazon Music, Deezer. Also custom pricing, similarly positioned to MusixMatch.

**Path B: License directly from publishers**
Theoretically possible, practically very hard for an indie developer. Publishers like UMPG are set up to deal with large companies. You'd need a music attorney to navigate this, and the minimum advances tend to be significant.

**Path C: Partner with an existing licensed provider**
If Liri becomes compelling enough, a MusixMatch or LyricFind partnership becomes a business conversation rather than just an API fee. They get distribution; you get licensing coverage.

### What about lrclib.net?

lrclib.net is an open-source, community-contributed lyrics database. It does NOT have publisher licensing agreements. The lyrics in it are user-submitted, which puts it in a legally grey area similar to how early Napster or LyricWiki operated.

**For prototyping**: Fine. You're testing a concept.
**For a commercial product**: This would need to be replaced with a properly licensed source before launch.

lrclib's own terms note it's for personal, non-commercial use. The community has done the work of creating timestamps (which is actually a huge amount of effort and has real value), but the underlying lyric text is still copyrighted content.

### The "fair use" question

Some apps have argued that displaying lyrics while a user plays their own legally purchased record might qualify as fair use. This is genuinely unsettled law. The argument: the user owns the record, the lyrics are being displayed for personal private use, it's transformative (adding sync value). The counter-argument: commercial display of lyrics has a well-established licensing market, which weakens fair use claims. Don't rely on this without legal counsel.

---

## Question 2: Audio Fingerprinting (Recognition APIs)

### AudD

AudD's terms of service permit commercial use on paid tiers. They are a legit business and this part of Liri's stack has the clearest path to commercial use.

**Free tier**: ~10 requests/day, non-commercial only
**Commercial tiers**: Available at audd.io/pricing — tiered by monthly request volume
**Important**: AudD's fingerprinting works by comparing audio against a database of reference recordings. The legality of audio fingerprinting for identification purposes (vs. reproduction) has generally been upheld in courts — Shazam and SoundHound have operated commercially for years on this model.

**Action item**: When ready to launch commercially, upgrade to an AudD paid plan. Their pricing is reasonable at scale.

### ACRCloud (alternative to AudD)

Another audio fingerprinting provider with a more established enterprise track record. More expensive than AudD but well-proven. Worth considering at scale.

### Could we build our own fingerprinting?

Technically yes — Dejavu and Chromaprint are open-source fingerprinting libraries. But running your own fingerprinting service requires:
- A large database of reference audio (licensing issues)
- Significant server infrastructure
- Ongoing maintenance

Not worth it when AudD exists. Use AudD and pay for the commercial tier.

---

## Question 3: Monetizing Liri

### The clean commercial path

1. **Get an AudD commercial API key** — their paid tiers are explicitly for commercial apps
2. **License lyrics from MusixMatch** — negotiate a commercial API agreement
3. **Consult a music licensing attorney** before launch — one consultation ($300–800) is worth it to confirm the above covers you

The attorney should specifically review:
- Whether MusixMatch's sublicense covers the Liri use case
- Whether the "timecode sync" display is covered under standard lyric display rights or needs additional clearance
- Whether the approach of "user plays their own record, app assists" changes the analysis

### The MVP/testing exception

For a private prototype that you're showing to a handful of people, testing viability, or demoing to potential investors — you're not in a legally meaningful risk zone. The music industry doesn't typically go after individual developers in prototype stage. They go after commercial products making real money.

The rule of thumb: "if you're not making money, you're probably fine to test." But once you charge users, get licensed.

### Taylor Swift specifically

Taylor Swift (and her team) are known to be particularly protective of her intellectual property. She's spoken publicly about rights and has pursued takedowns more actively than many artists. This doesn't change the legal framework (publishers handle this, not artists directly), but it's worth being aware of. Getting properly licensed before public launch is more important here than it might be with a less high-profile catalog.

---

## Advertising alternative

If going with a free-with-ads model instead of subscriptions, additional consideration:

- **Display ads** in a lyric app are possible via Google AdMob or similar networks
- The ads cannot contain copyrighted music without their own sync licenses
- Audio ads over vinyl playback would be a terrible UX anyway
- For a Samsung TV app, advertising standards and SDK availability are more restricted

The cleaner model for Liri is subscription, not advertising. Ads in an ambient home-listening product feel wrong.

---

## Summary: what to do and when

| Stage | Action |
|---|---|
| Right now (prototype) | Continue with AudD free tier + lrclib. Fine for personal testing. |
| Before public beta | Upgrade to AudD paid commercial tier. |
| Before charging users | Consult a music licensing attorney. Negotiate a MusixMatch commercial agreement. |
| Before Samsung TV submission | Samsung reviews apps for proper licensing — you'll need to demonstrate rights clearance in the submission. |
| Long term | Consider a direct publisher relationship or a MusixMatch/LyricFind partnership deal rather than API fees. |

---

## Useful resources

- **MusixMatch for Developers**: developers.musixmatch.com
- **LyricFind**: lyricfind.com (enterprise, requires direct contact)
- **AudD pricing**: audd.io/pricing
- **UMPG (Taylor's publisher)**: umpg.com
- **Music attorney search**: Volunteer Lawyers for the Arts (if budget is tight early stage), or search for "music IP attorney" in your state
- **US Copyright Office — Lyrics**: copyright.gov/music-modernization
