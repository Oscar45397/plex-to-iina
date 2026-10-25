"""Minimal Plex Media Server stand-in for testing without a real server.

Serves one video file at every /library/parts/ path (with HTTP range support, so IINA can
seek) and appends every progress call the plugin makes (/:/timeline, /:/progress,
/:/scrobble) to a JSON-lines log. Every video request is logged too ("media", with the
byte offset it starts at), so you can see when a seek made IINA re-download.

It also has a tiny library, for the extension's Download button: "Mock Show" (ratingKey
100; a special, season 1 with episodes 1001-1004, season 2 with 1005-1006; 1001 watched,
1002 half-watched and On Deck) and "Mock Film" (200). Every item plays the same video.
/web/index.html is a bare stand-in for Plex Web with a details-page Play button, so the
extension runs on it. The token may come as a query parameter or an X-Plex-Token header.

Usage:
    ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=24 -f lavfi -i sine -t 40 \\
        -c:v libx264 -pix_fmt yuv420p -c:a aac test.mkv
    python3 tools/mock-pms.py test.mkv 32411 calls.jsonl
    open 'iina://open?url=http%3A%2F%2F127.0.0.1%3A32411%2Flibrary%2Fparts%2F1%2F1%2Ffile.mkv%3FX-Plex-Token%3Dtok123%26plexRatingKey%3D4242&mpv_start=5'
    tail -f calls.jsonl

Expect "playing" reports every 10 s, "paused" plus /:/progress when you pause,
/:/scrobble past 90%, and "stopped" when you close the window.

Downloads: load the extension in Chrome, open http://127.0.0.1:32411/web/index.html and
use the links there. Set MOCK_RATE_KBPS=2000 to send video at 2 MB/s, so you can watch
the downloads queue up.
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VIDEO = sys.argv[1]
PORT = int(sys.argv[2])
LOG = sys.argv[3]
TOKEN = 'tok123'
MACHINE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'  # made up
RATE = int(os.environ.get('MOCK_RATE_KBPS', '0')) * 1000  # bytes per second, 0 = no limit
T0 = time.time()


def record(entry):
    entry['t'] = round(time.time() - T0, 1)
    with open(LOG, 'a') as f:
        f.write(json.dumps(entry) + '\n')


# ---- The mock library ------------------------------------------------------------

def media(rating_key):
    return [{
        'id': rating_key * 10, 'width': 1920, 'height': 1080, 'bitrate': 8000,
        'videoResolution': '1080', 'videoCodec': 'h264', 'audioCodec': 'aac', 'audioChannels': 2,
        'container': 'mkv',
        'Part': [{
            'id': rating_key * 10, 'key': f'/library/parts/{rating_key * 10}/1600000000/file.mkv',
            'size': os.path.getsize(VIDEO), 'container': 'mkv',
            'file': f'/data/media/{rating_key}.mkv',
        }],
    }]


SHOW = {'ratingKey': '100', 'key': '/library/metadata/100/children', 'type': 'show',
        'title': 'Mock Show', 'year': 2024, 'leafCount': 7, 'viewedLeafCount': 1}
SEASONS = [
    {'ratingKey': '103', 'type': 'season', 'index': 0, 'title': 'Specials'},
    {'ratingKey': '101', 'type': 'season', 'index': 1, 'title': 'Season 1'},
    {'ratingKey': '102', 'type': 'season', 'index': 2, 'title': 'Season 2'},
]
EPISODES = [
    # (ratingKey, season ratingKey, season, episode, title, extra)
    (1000, 103, 0, 1, 'Behind the Scenes', {}),
    (1001, 101, 1, 1, 'Pilot', {'viewCount': 1}),
    (1002, 101, 1, 2, 'The Second One', {'viewOffset': 15000}),
    (1003, 101, 1, 3, 'Third: A Colon/Slash Title?', {}),
    (1004, 101, 1, 4, 'Finale', {}),
    (1005, 102, 2, 1, 'New Season', {}),
    (1006, 102, 2, 2, 'Last One', {}),
]
FILM = {'ratingKey': '200', 'type': 'movie', 'title': 'Mock Film', 'year': 2024,
        'duration': 40000, 'Media': media(200)}


def episode(row):
    rk, season_rk, season, index, title, extra = row
    return {'ratingKey': str(rk), 'key': f'/library/metadata/{rk}', 'type': 'episode',
            'title': title, 'index': index, 'parentIndex': season,
            'parentRatingKey': str(season_rk), 'grandparentRatingKey': '100',
            'grandparentTitle': SHOW['title'], 'duration': 40000, 'Media': media(rk), **extra}


def season(s):
    return {**s, 'parentRatingKey': '100', 'parentTitle': SHOW['title']}


def library(path, query):
    """The MediaContainer for a /library/metadata/... path, or None."""
    parts = path.strip('/').split('/')[2:]  # after library/metadata
    if not parts:
        return None
    key, rest = parts[0], parts[1:]
    episodes = [episode(row) for row in EPISODES]
    seasons = {s['ratingKey']: s for s in SEASONS}
    if key == '100':
        if rest == ['allLeaves']:
            return {'Metadata': episodes}
        if rest == ['children']:
            return {'Metadata': [season(s) for s in SEASONS]}
        if not rest:
            show = dict(SHOW)
            if query.get('includeOnDeck') == '1':
                show['OnDeck'] = {'Metadata': episode(EPISODES[2])}
            return {'Metadata': [show]}
    if key in seasons:
        if rest == ['children']:
            return {'Metadata': [e for e in episodes if e['parentRatingKey'] == key]}
        if not rest:
            return {'Metadata': [season(seasons[key])]}
    if key == '200' and not rest:
        return {'Metadata': [FILM]}
    for e in episodes:
        if e['ratingKey'] == key and not rest:
            return {'Metadata': [e]}
    return None


# A bare stand-in for Plex Web's details page: the Play button the extension looks for,
# in a row like Plex's, plus links to the mock library's items.
WEB = f'''<!doctype html>
<meta charset="utf-8"><title>Mock Plex Web</title>
<style>
  body {{ background: #1f1f1f; color: #eee; font: 15px system-ui, sans-serif; margin: 32px; }}
  a {{ color: #e5a00d; margin-right: 14px; }}
  .row {{ display: flex; gap: 8px; align-items: center; min-height: 40px; flex-wrap: wrap; margin-top: 24px; }}
  .row > button {{ height: 40px; min-width: 40px; border-radius: 20px; border: 0; padding: 0 14px;
    background: rgba(255, 255, 255, 0.1); color: inherit; font: inherit; }}
  .row > button:first-child {{ background: #e5a00d; color: #000; font-weight: 600; }}
</style>
<script>localStorage.setItem('myPlexAccessToken', '{TOKEN}');</script>
<nav>
  <a href="#!/server/{MACHINE}/details?key=%2Flibrary%2Fmetadata%2F100">Show</a>
  <a href="#!/server/{MACHINE}/details?key=%2Flibrary%2Fmetadata%2F101">Season 1</a>
  <a href="#!/server/{MACHINE}/details?key=%2Flibrary%2Fmetadata%2F1003">S01E03</a>
  <a href="#!/server/{MACHINE}/details?key=%2Flibrary%2Fmetadata%2F200">Film</a>
</nav>
<h1 id="title">Mock Plex Web</h1>
<div class="row">
  <button data-testid="preplay-play">▶ Play</button>
  <button data-testid="preplay-togglePlayedState">✓</button>
  <button data-testid="preplay-more">⋯</button>
</div>
<script>
  const show = () => {{ document.getElementById('title').textContent = decodeURIComponent(location.hash) || 'Mock Plex Web'; }};
  addEventListener('hashchange', show); show();
</script>
'''


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def send_json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        token = q.get('X-Plex-Token') or self.headers.get('X-Plex-Token')
        if u.path in ('/:/timeline', '/:/progress', '/:/scrobble'):
            q.pop('X-Plex-Token', None)
            record({'path': u.path, 'token_ok': token == TOKEN,
                    'client': self.headers.get('X-Plex-Client-Identifier'),
                    'product': self.headers.get('X-Plex-Product'), **q})
            return self.send_json(200, {})
        if u.path == '/identity':
            record({'path': u.path})
            return self.send_json(200, {'MediaContainer': {'machineIdentifier': MACHINE}})
        if u.path in ('/web', '/web/', '/web/index.html'):
            data = WEB.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path.startswith('/library/metadata/'):
            if token != TOKEN:
                return self.send_json(401, {})
            body = library(u.path, q)
            return self.send_json(200, {'MediaContainer': body}) if body else self.send_json(404, {})
        if u.path.startswith('/library/parts/'):
            return self.send_video(q, token)
        self.send_json(404, {})

    def send_video(self, q, token):
        size = os.path.getsize(VIDEO)
        start, end = 0, size - 1
        rng = self.headers.get('Range')
        if rng and rng.startswith('bytes='):
            a, _, b = rng[6:].partition('-')
            start = int(a) if a else size - int(b)
            end = int(b) if a and b else size - 1
        # Each new request means IINA (re)started reading at this offset, e.g. after
        # a seek outside its buffer.
        record({'path': 'media', 'part': self.path.split('?')[0], 'token_ok': token == TOKEN,
                'token_in': 'header' if self.headers.get('X-Plex-Token') else 'query' if 'X-Plex-Token' in q else None,
                'download': q.get('download'), 'extra': sorted(k for k in q if k not in ('X-Plex-Token', 'download')),
                'from_byte': start, 'from_pct': round(100 * start / size, 1)})
        if token != TOKEN:
            return self.send_json(401, {})
        self.send_response(206 if rng else 200)
        self.send_header('Content-Type', 'video/x-matroska')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(end - start + 1))
        if rng:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        if q.get('download') == '1':
            self.send_header('Content-Disposition', 'attachment; filename="file.mkv"')
        self.end_headers()
        with open(VIDEO, 'rb') as f:
            f.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    chunk = f.read(min(1 << 16, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
                    if RATE:
                        time.sleep(len(chunk) / RATE)
            except (BrokenPipeError, ConnectionResetError):
                pass


ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
