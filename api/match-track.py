"""
api/match-track.py — Unique consecutive-word track matcher

POST { transcript: str, collection_id: str|int }
  → { match: { track_name, artist_name, start_pos, match_length } | null }

Algorithm:
  Try runs of 1 word, 2 words, 3 words… up to 18.
  For each run, check every track's lyrics.
  A phrase must appear in exactly ONE track AND only ONCE in that track
  (truly unique) before we call it a match.
  Shortest unique run wins — a single rare word is enough.

Position: scan LRC lines accumulating text until the matched phrase is
fully contained. The timestamp of that line = where in the song we are.
"""

from http.server import BaseHTTPRequestHandler
import json, os, re, urllib.request

SUPABASE_URL = "https://xjdjpaxgymgbvcwmvorc.supabase.co"
SUPABASE_KEY = os.environ.get(
    "SUPABASE_ANON_KEY",
    "sb_publishable_C-NBnfg0ltAoUi46XQTUjA_ozjZW_Nd"
)


def norm(s):
    return re.sub(r'\s+', ' ', re.sub(r'[^\w\s]', '', s.lower())).strip()


def parse_lrc(lrc):
    lines = []
    for line in lrc.split('\n'):
        m = re.match(r'^\[(\d+):(\d+\.\d+)\](.*)', line)
        if m:
            text = m.group(3).strip()
            if text:
                lines.append({
                    'time': int(m.group(1)) * 60 + float(m.group(2)),
                    'text': text,
                })
    return lines


def find_match(transcript, tracks):
    words = [w for w in norm(transcript).split() if len(w) > 1]
    if not words:
        return None

    # Pre-build normalised lyrics string + parsed lines for each track
    data = []
    for t in tracks:
        parsed = parse_lrc(t['lrc'])
        if not parsed:
            continue
        data.append({
            **t,
            'parsed': parsed,
            'norm_lyrics': norm(' '.join(l['text'] for l in parsed)),
        })

    if not data:
        return None

    max_run = min(len(words), 18)

    for length in range(1, max_run + 1):
        for start in range(len(words) - length + 1):
            phrase = ' '.join(words[start:start + length])

            # Must appear in exactly 1 track AND only once — truly unique
            hits = [d for d in data if d['norm_lyrics'].count(phrase) == 1]
            if len(hits) != 1:
                continue

            match = hits[0]

            # Position: accumulate LRC lines until the phrase is fully contained
            start_pos, buf = 0.0, ''
            for line in match['parsed']:
                buf = (buf + ' ' + norm(line['text'])).strip()
                if phrase in buf:
                    start_pos = line['time']
                    break

            return {
                'track_name':    match['track_name'],
                'artist_name':   match['artist_name'],
                'start_pos':     start_pos,
                'match_length':  length,
            }

    return None


class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        try:
            body = json.loads(
                self.rfile.read(int(self.headers.get('Content-Length', 0)))
            )
            transcript    = body.get('transcript', '').strip()
            collection_id = str(body.get('collection_id', '')).strip()

            if not transcript or not collection_id:
                return self._json(400, {'error': 'transcript and collection_id required'})

            # Fetch all cached lyrics for this collection from Supabase
            url = (
                f"{SUPABASE_URL}/rest/v1/liri_lyric_cache"
                f"?itunes_collection_id=eq.{collection_id}"
                f"&select=track_name,artist_name,synced_lyrics"
            )
            req = urllib.request.Request(url, headers={
                'apikey':         SUPABASE_KEY,
                'Authorization':  f'Bearer {SUPABASE_KEY}',
            })
            with urllib.request.urlopen(req, timeout=5) as resp:
                rows = json.loads(resp.read())

            tracks = [
                {
                    'track_name':  r['track_name'],
                    'artist_name': r['artist_name'],
                    'lrc':         r['synced_lyrics'],
                }
                for r in rows if r.get('synced_lyrics')
            ]

            self._json(200, {'match': find_match(transcript, tracks)})

        except Exception as e:
            self._json(500, {'error': str(e)})

    def _json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass
