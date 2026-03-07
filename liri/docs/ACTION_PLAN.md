# Liri — Action Plan
### Date-specific. Capital-tracked. No fluff.

> Today is March 7, 2026. Here is exactly what happens and when.

---

## Capital investment summary

| Item | When | Cost | Notes |
|---|---|---|---|
| AudD API key (free) | Today | $0 | Get it now at audd.io |
| Domain name | This week | ~$15/yr | liriapp.com or similar |
| Netlify hosting (free tier) | This week | $0 | Good until ~10k visits/month |
| AudD paid tier (1k req/mo) | April | ~$10/mo | Upgrade when beta starts |
| Music attorney consultation | May | ~$500 one-time | Before charging anyone |
| MusixMatch commercial license | June | ~$500–800/mo | Required for legal launch |
| Samsung Developer account | June | $99/yr | Required for TV store submission |
| **Total to launch day** | | **~$1,500–2,000** | Most of it is the attorney + MusixMatch |
| **Monthly operating cost** | Post-launch | **~$600–900/mo** | AudD + MusixMatch + hosting |

**Break-even**: ~200 paying subscribers at $4.99/month = $998 gross revenue/month.
At $2.99/month you need ~300. Recommend $4.99 — the audience already spends $40+ per record.

**ROI date (realistic)**: October–November 2026. That's 7–8 months from today.

---

## THE PLAN

### WEEK 1 — March 7–14 ← YOU ARE HERE

**Helen does:**
- [ ] Go to **audd.io**, create a free account, get your API key. Takes 5 minutes. Paste it in the Liri ⚙ settings.
- [ ] Register a domain. Options: `liriapp.com`, `lirivinyl.com`, `listenwithliri.com`, `lirilyrics.com`. Use Namecheap or Cloudflare Registrar (~$10–15/year). Pick one today.
- [ ] Create a **GitHub account** at github.com (if you don't have one). We'll put the Liri code there so it's version-controlled and not just living on your Desktop.
- [ ] Test the app on 5 different albums — any genre, any era. Note what works and what doesn't. This is real product feedback.

**I build (next session):**
- Connect the landing page email form to Formspree
- Set up GitHub repo with proper structure
- Add "re-detect" button to the sync screen (if sync drifts badly, one tap to re-listen and catch up)

---

### WEEK 2–3 — March 14–28: Get the landing page live

**Helen does:**
- [ ] Go to **netlify.com/drop** — literally drag the `liri` folder onto the page. You'll have a live URL in 30 seconds. No login needed initially.
- [ ] Claim your custom domain on Netlify (connect the domain you registered)
- [ ] Create a **Formspree account** at formspree.io (free, handles 50 signups/month) — get your form ID and we'll connect it
- [ ] Start sharing the landing page URL. Target: vinyl communities, turntable subreddits, Discogs forums, Twitter/Instagram vinyl accounts. Not "here's my app" — just "hey, would you use this? I'm building it."
- [ ] Set a goal: **50 email signups by April 1.** That's your first real market signal.

**What we're measuring:**
- Email signups (is there demand?)
- Where traffic comes from (where are your people?)

---

### APRIL: Beta prep + Samsung TV research

**Goal: Have a beta-ready app with a polished experience**

**Helen does:**
- [ ] Upgrade AudD to a paid plan ($10/month basic tier) — you'll need this before sending a beta link to real users
- [ ] Personally test with 20 different albums across different genres and decades. File a bug report document for anything that fails or feels off.
- [ ] Start a simple **Instagram or TikTok account** for Liri. Not polished. Just behind-the-scenes: "building this thing, here's what it looks like." Vinyl content has a huge community. Even 200 followers before launch matters.

**I build:**
- Samsung TV companion prototype (phone sends lyrics to TV via local network)
- TV remote microphone investigation (Samsung 2019+ remotes have Bixby mic — we'll test whether we can access raw audio from it for fingerprinting)
- Auto re-detection (if sync drifts more than 10 seconds, Liri quietly re-listens and corrects)
- Album-flip detection (detect silence at end of side and prompt for next track)

---

### MAY: Legal + beta launch

**Goal: Invite your email list to a private beta**

**Helen does:**
- [ ] **Hire a music licensing attorney for one consultation** (~$500). Search "music IP attorney" or use the Volunteer Lawyers for the Arts if budget is tight. Ask specifically: does our MusixMatch sublicense cover the Liri display use case?
- [ ] Contact MusixMatch (developers.musixmatch.com) and start the commercial licensing conversation. You don't need to sign anything yet — just understand the cost and timeline.
- [ ] Send your email list a beta invite. Personal, direct email — not a newsletter blast. "Hey, I built this thing, want to try it?"
- [ ] Gather feedback obsessively. The #1 beta question: "Did it feel like magic or did it feel clunky?"

**I build:**
- Switch lyrics source from lrclib to MusixMatch API (once licensed)
- Usage tracking for freemium tier (localStorage-based, 10 free recognitions/month)
- Paywall UI (non-intrusive — shows after 10 uses, explains what you get for $4.99)

---

### JUNE: Public launch + Samsung TV submission

**Goal: App is live, Samsung TV submission is in progress**

**Helen does:**
- [ ] Pay for MusixMatch commercial license (or LyricFind — whichever the attorney recommends)
- [ ] Pay for Samsung Developer account ($99/year) and submit the TV app for review
- [ ] Set up **Stripe** for payment processing (stripe.com — create account, it's free until you make money)
- [ ] Announce the public launch to your email list and every vinyl community you've joined. Post the TikTok/Instagram content you've been building.
- [ ] Submit Liri to: Product Hunt, Hacker News "Show HN", relevant subreddits (r/vinyl, r/audiophile, r/turntables)

**I build:**
- Stripe payment integration
- Account system (email + password or Google login — use Supabase, free tier is generous)
- Samsung TV companion app (full version, submittable)
- iOS web app manifest so it installs like a native app from Safari

---

### JULY–AUGUST: Growth + iteration

**Goal: 100 paying subscribers**

**Helen does:**
- [ ] Actively engage every person who tweets, posts, or reviews Liri. Reply. Ask what they want. This is your moat early on.
- [ ] Reach out to 3–5 vinyl influencers (YouTube, TikTok, Instagram) for collaboration. Not paid promo — just "I made this for people like you, want to try it?" Authentic.
- [ ] Look at your analytics: which songs are being detected most? Which artists? That tells you who your real user is.

---

### SEPTEMBER–OCTOBER: Break-even

**Goal: 200+ paying subscribers = ROI**

At 200 paying users × $4.99/month = ~$998 gross.
Monthly costs at this point: ~$600–900 (MusixMatch + AudD + Stripe fees + hosting).
**Net positive: October 2026.**

From here, every additional subscriber is profit.

---

## The Samsung TV remote microphone question

Yes — this is feasible, and it's genuinely a killer feature.

**How it would work:**
Samsung Smart Remotes (2019 and newer) have a built-in microphone used for Bixby voice commands. In a Tizen app, you can access voice input via `tizen.voice` APIs. The catch is that this API is designed for short voice commands, not continuous audio streaming.

**The workaround that makes it work:**
- User points remote at TV and holds the mic button (same button they use for Bixby)
- Liri captures 8 seconds of audio from the remote's mic
- Detection runs, lyrics load, sync begins
- The TV becomes completely standalone — no phone needed

**Feasibility**: Medium. Samsung's Tizen docs expose the remote mic API, but continuous audio capture may require some creative use of the voice recognition hooks. This is a Phase 2 feature (April/May sprint) and the outcome is not 100% guaranteed — but it's worth the investigation because if it works, it's the headline feature for the TV app. "Your Samsung remote is the microphone" is the kind of thing people share.

**Fallback if it doesn't work**: The companion model (phone listens, TV displays) is still excellent and is what we build first regardless.

---

## Helen's actual to-do list for today

These are the things that will have happened or not happened by March 8. Be honest with yourself.

1. ✅ Get AudD API key — audd.io — 5 minutes
2. ✅ Register a domain name — 10 minutes
3. ✅ Test Liri on 3+ albums with your actual turntable — real feedback
4. 🔲 Create GitHub account (we'll set up the repo next session)
5. 🔲 Open landing.html in your browser and tell me what you want changed

That's it for today. Small list, real momentum.

---

## What "working with me" looks like going forward

Every session: you bring what changed, what broke, and what you tested. I build the next thing. We don't have big gaps between sessions where nothing happens.

The project stays alive because of the 5-minute decisions you make between sessions — signing up for an account, registering a domain, texting a friend who has a record player to try it. Those are your moves. The code is mine.

We can actually do this. The product is real and it already works.
