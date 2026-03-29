#!/usr/bin/env python3
"""
Liri local matching test + lyrics seeder.

Usage:
  python3 test-matching.py                    # run built-in test phrases
  python3 test-matching.py "heard lyrics"     # test a specific transcript
  python3 test-matching.py --seed             # fetch lyrics + write to Supabase
  python3 test-matching.py --seed --artist "Fleetwood Mac" --album "Rumours"
"""

import sys, re, json, time, urllib.request, urllib.parse

SUPABASE_URL = "https://xjdjpaxgymgbvcwmvorc.supabase.co"
SUPABASE_KEY = "sb_publishable_C-NBnfg0ltAoUi46XQTUjA_ozjZW_Nd"

# ── Helpers ─────────────────────────────────────────────────────────────────

def norm(s):
    return re.sub(r'\s+', ' ', re.sub(r'[^\w\s]', '', s.lower())).strip()

def parse_lrc(lrc):
    lines = []
    for line in lrc.split('\n'):
        m = re.match(r'^\[(\d+):(\d+\.\d+)\](.*)', line)
        if m:
            text = m.group(3).strip()
            if text:
                lines.append({'time': int(m.group(1))*60 + float(m.group(2)), 'text': text})
    return lines

def fetch_json(url, headers=None, label=""):
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"  ⚠  {label or url}: {e}")
        return None

# ── Step 1: iTunes lookup ────────────────────────────────────────────────────

def get_album_tracks(artist, album):
    print(f"\n🔍 Looking up '{album}' by {artist} on iTunes…")
    q = urllib.parse.quote(f"{artist} {album}")
    data = fetch_json(
        f"https://itunes.apple.com/search?term={q}&entity=song&limit=200",
        label="iTunes search"
    )
    if not data:
        return None, []

    # Filter to tracks from the correct album
    album_key = album.lower()[:10]
    all_tracks = [
        t for t in data.get('results', [])
        if t.get('wrapperType') == 'track'
        and album_key in (t.get('collectionName') or '').lower()
    ]

    if not all_tracks:
        print("  ❌ No tracks found — try a different search term")
        return None, []

    # Pick the edition with the most tracks as the "canonical" one
    from collections import Counter
    cid_counts = Counter(t.get('collectionId') for t in all_tracks)
    best_cid = cid_counts.most_common(1)[0][0]
    tracks = [t for t in all_tracks if t.get('collectionId') == best_cid]
    tracks.sort(key=lambda t: (t.get('discNumber', 1), t.get('trackNumber', 1)))

    print(f"  ✅ Using collection {best_cid} ({len(tracks)} tracks) from {len(cid_counts)} editions found")
    for t in tracks:
        print(f"     {t.get('discNumber',1)}-{t.get('trackNumber',1):02d}  {t.get('trackName')}")
    return best_cid, tracks

# ── Step 2: LRCLib lyrics fetch ─────────────────────────────────────────────

def fetch_lrc(artist, title):
    for url in [
        f"https://lrclib.net/api/search?artist_name={urllib.parse.quote(artist)}&track_name={urllib.parse.quote(title)}",
        f"https://lrclib.net/api/search?q={urllib.parse.quote(artist + ' ' + title)}",
    ]:
        data = fetch_json(url)
        if data:
            for r in (data if isinstance(data, list) else []):
                if r.get('syncedLyrics') and '**' not in r['syncedLyrics']:
                    return r['syncedLyrics']
    return None

def build_lyrics_cache(tracks):
    print(f"\n🎵 Fetching lyrics for {len(tracks)} tracks from LRCLib…")
    cache = {}   # trackId or trackName → syncedLyrics
    missing = []
    for i, t in enumerate(tracks):
        name   = t.get('trackName', '')
        artist = t.get('artistName', '')
        tid    = t.get('trackId')
        lrc = fetch_lrc(artist, name)
        if lrc:
            if tid:    cache[tid]   = lrc
            if name:   cache[name]  = lrc
            print(f"  ✅ {name}")
        else:
            missing.append(name)
            print(f"  ❌ {name}  (no LRC found)")
        time.sleep(0.15)   # be polite to LRCLib

    print(f"\n  {len(cache)//2 if cache else 0} tracks cached, {len(missing)} missing")
    if missing:
        print("  Missing:", ", ".join(missing))
    return cache

# ── Step 3: Matching algorithm (mirrors JS matchTranscriptToTracks) ──────────

def match_transcript(transcript, tracks, cache):
    words = [w for w in norm(transcript).split() if len(w) > 1]
    if not words:
        return None, "transcript too short"

    # Build per-track data — deduplicated by BASE track name.
    # Strips parentheticals like "(the long pond studio sessions)", "(bonus track)", "[live]"
    # so album+sessions editions don't double-count every phrase.
    def base_name(n): return norm(re.sub(r'\s*[\(\[].*', '', n or '').strip())

    seen_names = set()
    data = []
    for t in tracks:
        name = t.get('trackName', '')
        name_key = base_name(name)
        if name_key in seen_names:
            continue
        key = t.get('trackId') or name
        lrc = cache.get(key) or cache.get(name)
        if not lrc:
            continue
        parsed = parse_lrc(lrc)
        if not parsed:
            continue
        seen_names.add(name_key)
        data.append({
            'name':        name,
            'parsed':      parsed,
            'norm_lyrics': norm(' '.join(l['text'] for l in parsed)),
            'lrc':         lrc,
        })

    if not data:
        return None, f"no cached lyrics for any of the {len(tracks)} tracks"

    max_run = len(words)   # no cap — use all words, keep going until perfect match
    min_run = 3            # <3 words is too loose — single words hit wrong tracks
    for length in range(min_run, max_run + 1):
        for start in range(len(words) - length + 1):
            phrase = ' '.join(words[start:start + length])
            # Both must be true: phrase in exactly 1 track AND appears exactly once in it
            hits = [d for d in data if d['norm_lyrics'].count(phrase) == 1]
            if len(hits) != 1:
                continue

            match = hits[0]
            start_pos, buf = 0.0, ''
            for line in match['parsed']:
                buf = (buf + ' ' + norm(line['text'])).strip()
                if phrase in buf:
                    start_pos = line['time']
                    break

            return {
                'track':        match['name'],
                'phrase':       phrase,
                'run_length':   length,
                'start_pos_s':  start_pos,
                'start_pos_fmt': f"{int(start_pos//60)}:{start_pos%60:05.2f}",
            }, None

    # Debug: show why nothing matched
    tried = []
    for length in range(1, min(max_run+1, 4)):
        for start in range(len(words) - length + 1):
            phrase = ' '.join(words[start:start + length])
            hits = [d['name'] for d in data if phrase in d['norm_lyrics']]
            tried.append(f"  '{phrase}' → {len(hits)} tracks: {hits[:3]}")
    return None, "no unique run found\nSample phrase hits:\n" + "\n".join(tried[:15])

# ── Step 4: Interactive test loop ────────────────────────────────────────────

def run_match_test(tracks, cache, transcript=None):
    print("\n" + "─"*60)
    print("🎤  MATCHING TEST")
    print("─"*60)
    print("Paste a Whisper transcript (what you'd hear on the record)")
    print("Press Enter twice to test, or Ctrl+C to quit.\n")

    while True:
        if transcript:
            t = transcript
            transcript = None
        else:
            lines = []
            try:
                while True:
                    line = input()
                    if line == "" and lines:
                        break
                    lines.append(line)
            except KeyboardInterrupt:
                print("\n👋  Done.")
                break
            t = " ".join(lines).strip()

        if not t:
            continue

        print(f"\nTranscript: \"{t}\"")
        print(f"Words: {[w for w in norm(t).split() if len(w) > 1]}")

        result, err = match_transcript(t, tracks, cache)
        if result:
            print(f"\n✅  MATCH: \"{result['track']}\"")
            print(f"   Phrase: \"{result['phrase']}\" ({result['run_length']} word{'s' if result['run_length']>1 else ''})")
            print(f"   Position: {result['start_pos_fmt']} ({result['start_pos_s']:.1f}s)")
        else:
            print(f"\n❌  NO MATCH — {err}")
        print()


# ── Supabase seeder ──────────────────────────────────────────────────────────

def seed_to_supabase(cid, tracks, cache):
    print(f"\n🌱 Seeding lyrics to Supabase (collection {cid})…")
    ok, skip, fail = 0, 0, 0
    for t in tracks:
        name   = t.get('trackName', '')
        tid    = t.get('trackId')
        artist = t.get('artistName', '')
        tnum   = t.get('trackNumber')
        dnum   = t.get('discNumber', 1)
        lrc    = cache.get(tid) or cache.get(name)
        if not lrc:
            skip += 1
            continue
        if not tid:
            print(f"  ⚠  {name}: no iTunes track ID — skipping")
            skip += 1
            continue

        row = {
            'itunes_track_id':      tid,
            'itunes_collection_id': cid,
            'track_name':    name,
            'artist_name':   artist,
            'track_number':  tnum,
            'disc_number':   dnum,
            'synced_lyrics': lrc,
        }
        body = json.dumps([row]).encode()
        req = urllib.request.Request(
            f"{SUPABASE_URL}/rest/v1/liri_lyric_cache",
            data=body,
            method='POST',
            headers={
                'apikey':         SUPABASE_KEY,
                'Authorization':  f'Bearer {SUPABASE_KEY}',
                'Content-Type':   'application/json',
                'Prefer':         'resolution=merge-duplicates,return=minimal',
            }
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                r.read()
            print(f"  ✅ {name}")
            ok += 1
        except Exception as e:
            print(f"  ❌ {name}: {e}")
            fail += 1
        time.sleep(0.05)

    print(f"\n  Done: {ok} written, {skip} skipped (no LRC or no ID), {fail} failed")
    return ok > 0


# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    args = sys.argv[1:]
    do_seed   = '--seed'   in args
    artist_i  = args.index('--artist') if '--artist' in args else -1
    album_i   = args.index('--album')  if '--album'  in args else -1
    ARTIST = args[artist_i + 1] if artist_i >= 0 and artist_i + 1 < len(args) else "Taylor Swift"
    ALBUM  = args[album_i  + 1] if album_i  >= 0 and album_i  + 1 < len(args) else "folklore"

    # Remaining args (not flags) = optional CLI transcript
    skip = {'--seed', '--artist', '--album'}
    flag_vals = set()
    if artist_i >= 0: flag_vals.add(args[artist_i + 1])
    if album_i  >= 0: flag_vals.add(args[album_i  + 1])
    cli_words = [a for a in args if a not in skip and a not in flag_vals]
    cli_transcript = " ".join(cli_words).strip() or None

    cid, tracks = get_album_tracks(ARTIST, ALBUM)
    if not tracks:
        sys.exit(1)

    cache = build_lyrics_cache(tracks)
    if not cache:
        print("❌  No lyrics found at all — can't test matching.")
        sys.exit(1)

    if do_seed:
        seed_to_supabase(cid, tracks, cache)
        print("\n✅  Supabase seeded. Now add this album to your library in-app")
        print(f"    and select it in turntable mode (collection ID: {cid})")
        sys.exit(0)

    # Run a built-in batch of test phrases from folklore
    test_phrases = [
        # Verse lines (unique — short transcript, should match fast)
        "I had the shiniest wheels now theyre rusting",
        "Rebekah rode up on the afternoon train it was sunny her saltbox house on the coast took her mind off St Louis",
        "You drew stars around my scars but now Im bleeding",
        # Repeated chorus lines — need longer unique phrase from surrounding verse context
        "she had a marvelous time ruining everything and they said there goes the last great american dynasty who knows if she never showed up",
        "meet me behind the mall back when we were still changing for the better wanting was enough for me it was enough to live for the hope of it all",
        "the lakes where all the poets went to die dont you worry your pretty little mind people throw rocks at things that shine",
        # Simulate Whisper: mixed chorus + verse context
        "salt air and the rust on your door I never needed anything more whispers of are you sure never your mind",
    ]

    if cli_transcript:
        test_phrases = [cli_transcript]

    print(f"\n{'─'*60}")
    print("🎤  RUNNING MATCH TESTS")
    print(f"{'─'*60}")
    unique_with_lyrics = len(set(norm(t.get('trackName','')) for t in tracks
        if (t.get('trackId') or t.get('trackName'))
        and (cache.get(t.get('trackId')) or cache.get(t.get('trackName')))))
    print(f"Unique tracks with lyrics: {unique_with_lyrics}\n")

    passed = 0
    for phrase in test_phrases:
        result, err = match_transcript(phrase, tracks, cache)
        if result:
            passed += 1
            print(f"✅  \"{phrase[:50]}\"")
            print(f"    → \"{result['track']}\" at {result['start_pos_fmt']} ({result['run_length']}w run: '{result['phrase']}')")
        else:
            print(f"❌  \"{phrase[:50]}\"")
            print(f"    → {err}")
        print()

    print(f"{'─'*60}")
    print(f"Result: {passed}/{len(test_phrases)} matched")

    if not cli_transcript:
        print("\n💡  Run with your own transcript:")
        print("    python3 test-matching.py \"lyrics you heard on the record\"")
