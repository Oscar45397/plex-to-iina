"""Minimal Plex Media Server stand-in for testing without a real server.

Serves one video file at every /library/parts/ path (with HTTP range support, so IINA can
seek) and appends every progress call the plugin makes (/:/timeline, /:/progress,
/:/scrobble) and every lookup to a JSON-lines log. Every video request is logged too
("media", with the byte offset it starts at), so you can see when a seek made IINA
re-download. Progress calls update the items' watch state, as on a real server.

The library: "Mock Show" (ratingKey 100) and "Mock Film" (200). Every item plays the same
video; tracks come from the file (ffprobe), so a file with several audio or subtitle
tracks tests track choice. Markers are placed relative to the video's length (shown here
for 40 s):

    1000  S00E01  special, no markers
    1001  S01E01  watched; intro 5-12 s, final credits 30-40 s    Up Next with countdown
    1002  S01E02  On Deck, resume point 15 s; intro 2-8 s,        Skip Intro, Skip Credits,
                  mid credits 20-26 s, final credits 34 s          then Up Next
    1003  S01E03  no markers, a title with : / ?                   Up Next in the last seconds
    1004  S01E04  final credits 32-40 s                            next season comes next
    1005  S02E01  final credits 32-40 s
    1006  S02E02  final credits 32-40 s, last episode              nothing to play next

/web/index.html is a bare stand-in for Plex Web with a details-page Play button, so the
extension runs on it, and /photo/:/transcode returns a plain coloured poster. The token
may come as a query parameter or an X-Plex-Token header.

Usage:
    ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=24 -f lavfi -i sine=frequency=440 \\
        -f lavfi -i sine=frequency=660 -t 40 -map 0 -map 1 -map 2 \\
        -c:v libx264 -pix_fmt yuv420p -c:a aac \\
        -metadata:s:a:0 language=eng -metadata:s:a:1 language=jpn test.mkv
    python3 tools/mock-pms.py test.mkv 32411 calls.jsonl
    open 'iina://open?url=http%3A%2F%2F127.0.0.1%3A32411%2Flibrary%2Fparts%2F10010%2F1%2Ffile.mkv%3FX-Plex-Token%3Dtok123%26plexRatingKey%3D1001&mpv_start=none'
    tail -f calls.jsonl

Expect "playing" reports every 10 s, "paused" plus /:/progress when you pause,
/:/scrobble past 90% or at the final credits, and "stopped" when the episode ends or you
close the window. The next episode is added to IINA's playlist and plays when one ends.

Extension and downloads: load the extension in Chrome, open
http://127.0.0.1:32411/web/index.html and use the links there. Set MOCK_RATE_KBPS=2000 to
send video at 2 MB/s, so you can watch the downloads queue up.
"""
import json
import os
import struct
import subprocess
import sys
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VIDEO = sys.argv[1]
PORT = int(sys.argv[2])
LOG = sys.argv[3]
TOKEN = 'tok123'
MACHINE = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'  # made up
RATE = int(os.environ.get('MOCK_RATE_KBPS', '0')) * 1000  # bytes per second, 0 = no limit
T0 = time.time()


def probe(path):
    """The video's length in ms and its streams in Plex's format."""
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
                         capture_output=True, text=True, check=True)
    data = json.loads(out.stdout)
    streams = []
    first_audio = True
    for s in data['streams']:
        kind = {'video': 1, 'audio': 2, 'subtitle': 3}.get(s['codec_type'])
        if not kind:
            continue
        tags = s.get('tags', {})
        disposition = s.get('disposition', {})
        stream = {'id': 1000 + s['index'], 'streamType': kind, 'index': s['index'], 'codec': s['codec_name'],
                  'default': bool(disposition.get('default')), 'forced': bool(disposition.get('forced'))}
        language = tags.get('language')
        if language and language != 'und':
            stream['languageCode'] = language
        if 'title' in tags:
            stream['title'] = tags['title']
        if kind == 2:
            stream['channels'] = s.get('channels')
            stream['selected'] = first_audio
            first_audio = False
        streams.append(stream)
    return round(float(data['format']['duration']) * 1000), streams


DURATION, STREAMS = probe(VIDEO)


def at(fraction):
    return round(DURATION * fraction)


def marker(kind, start, end, final=False):
    m = {'type': kind, 'startTimeOffset': at(start), 'endTimeOffset': at(end)}
    if kind == 'credits':
        m['final'] = final
    return m


def record(entry):
    entry['t'] = round(time.time() - T0, 1)
    with open(LOG, 'a') as f:
        f.write(json.dumps(entry) + '\n')


# ---- The mock library ------------------------------------------------------------

def media(rating_key, details=False):
    part = {
        'id': rating_key * 10, 'key': f'/library/parts/{rating_key * 10}/1600000000/file.mkv',
        'size': os.path.getsize(VIDEO), 'container': 'mkv', 'duration': DURATION,
        'file': f'/data/media/{rating_key}.mkv',
    }
    if details:
        part['Stream'] = STREAMS  # like Plex, only in an item's own details
    return [{
        'id': rating_key * 10, 'width': 1920, 'height': 1080, 'bitrate': 8000,
        'videoResolution': '1080', 'videoCodec': 'h264', 'audioCodec': 'aac', 'audioChannels': 2,
        'container': 'mkv', 'duration': DURATION, 'Part': [part],
    }]


SHOW = {'ratingKey': '100', 'key': '/library/metadata/100/children', 'type': 'show',
        'title': 'Mock Show', 'year': 2024, 'leafCount': 7, 'viewedLeafCount': 1,
        'thumb': '/library/metadata/100/thumb/1'}
SEASON_TITLES = {103: 'Specials', 101: 'Season 1', 102: 'Season 2'}
SEASONS = [
    {'ratingKey': '103', 'type': 'season', 'index': 0, 'title': 'Specials'},
    {'ratingKey': '101', 'type': 'season', 'index': 1, 'title': 'Season 1'},
    {'ratingKey': '102', 'type': 'season', 'index': 2, 'title': 'Season 2'},
]
FINAL_CREDITS = [marker('credits', 0.8, 1.0, final=True)]
EPISODES = [
    # Watch state (viewCount, viewOffset) changes as progress comes in.
    {'rk': 1000, 'season_rk': 103, 'season': 0, 'index': 1, 'title': 'Behind the Scenes', 'markers': []},
    {'rk': 1001, 'season_rk': 101, 'season': 1, 'index': 1, 'title': 'Pilot', 'viewCount': 1,
     'markers': [marker('intro', 0.125, 0.3), marker('credits', 0.75, 1.0, final=True)]},
    {'rk': 1002, 'season_rk': 101, 'season': 1, 'index': 2, 'title': 'The Second One', 'viewOffset': at(0.375),
     'markers': [marker('intro', 0.05, 0.2), marker('credits', 0.5, 0.65), marker('credits', 0.85, 1.0, final=True)]},
    {'rk': 1003, 'season_rk': 101, 'season': 1, 'index': 3, 'title': 'Third: A Colon/Slash Title?', 'markers': []},
    {'rk': 1004, 'season_rk': 101, 'season': 1, 'index': 4, 'title': 'Finale', 'markers': FINAL_CREDITS},
    {'rk': 1005, 'season_rk': 102, 'season': 2, 'index': 1, 'title': 'New Season', 'markers': FINAL_CREDITS},
    {'rk': 1006, 'season_rk': 102, 'season': 2, 'index': 2, 'title': 'Last One', 'markers': FINAL_CREDITS},
]
FILM = {'ratingKey': '200', 'type': 'movie', 'title': 'Mock Film', 'year': 2024, 'duration': DURATION,
        'thumb': '/library/metadata/200/thumb/1', 'viewCount': 0, 'markers': [marker('credits', 0.9, 1.0, final=True)]}
BY_KEY = {str(ep['rk']): ep for ep in EPISODES} | {'200': FILM}


def episode(ep, details=False, markers=False):
    rk = ep['rk']
    item = {'ratingKey': str(rk), 'key': f'/library/metadata/{rk}', 'type': 'episode',
            'title': ep['title'], 'index': ep['index'], 'parentIndex': ep['season'],
            'parentRatingKey': str(ep['season_rk']), 'parentTitle': SEASON_TITLES[ep['season_rk']],
            'grandparentRatingKey': '100', 'grandparentTitle': SHOW['title'], 'grandparentThumb': SHOW['thumb'],
            'thumb': f'/library/metadata/{rk}/thumb/1', 'duration': DURATION, 'Media': media(rk, details)}
    for field in ('viewOffset', 'viewCount'):
        if ep.get(field):
            item[field] = ep[field]
    if markers:
        item['Marker'] = ep['markers']
    return item


def film(details=False, markers=False):
    item = {k: v for k, v in FILM.items() if k not in ('markers', 'viewCount', 'viewOffset')}
    for field in ('viewOffset', 'viewCount'):
        if FILM.get(field):
            item[field] = FILM[field]
    item['Media'] = media(200, details)
    if markers:
        item['Marker'] = FILM['markers']
    return item


def update_watch_state(path, q):
    ep = BY_KEY.get(q.get('ratingKey') or q.get('key', '').rsplit('/', 1)[-1])
    if not ep:
        return
    if path == '/:/scrobble':
        ep['viewCount'] = ep.get('viewCount', 0) + 1
        ep.pop('viewOffset', None)
    elif (path == '/:/progress' or q.get('state') == 'stopped') and int(q.get('time', 0)) < DURATION * 0.9:
        ep['viewOffset'] = int(q.get('time', 0))


def season(s):
    return {**s, 'parentRatingKey': '100', 'parentTitle': SHOW['title']}


def library(path, query):
    """The MediaContainer for a /library/metadata/... path, or None."""
    parts = path.strip('/').split('/')[2:]  # after library/metadata
    if not parts:
        return None
    key, rest = parts[0], parts[1:]
    markers = query.get('includeMarkers') == '1'
    episodes = [episode(ep) for ep in EPISODES]
    seasons = {s['ratingKey']: s for s in SEASONS}
    if key == '100':
        if rest == ['allLeaves']:
            return {'Metadata': episodes}
        if rest == ['children']:
            return {'Metadata': [season(s) | {'leafCount': sum(e['parentRatingKey'] == s['ratingKey'] for e in episodes)}
                                 for s in SEASONS]}
        if not rest:
            show = dict(SHOW)
            if query.get('includeOnDeck') == '1':
                on_deck = next((ep for ep in EPISODES if ep.get('viewOffset')), None) \
                    or next((ep for ep in EPISODES if ep['season'] and not ep.get('viewCount')), None)
                if on_deck:
                    show['OnDeck'] = {'Metadata': episode(on_deck)}
            return {'Metadata': [show]}
    if key in seasons:
        if rest == ['children']:
            return {'Metadata': [e for e in episodes if e['parentRatingKey'] == key]}
        if not rest:
            return {'Metadata': [season(seasons[key])]}
    if key == '200' and not rest:
        return {'Metadata': [film(details=True, markers=markers)]}
    if key in BY_KEY and not rest:
        return {'Metadata': [episode(BY_KEY[key], details=True, markers=markers)]}
    return None


def poster_png(seed):
    """A plain 2:3 PNG whose colour depends on seed, standing in for a poster."""
    width, height = 60, 90
    h = zlib.crc32(seed.encode())
    pixel = bytes(((h >> 16) & 0xFF, (h >> 8) & 0xFF, h & 0xFF))
    raw = b''.join(b'\x00' + pixel * width for _ in range(height))

    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


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
            update_watch_state(u.path, q)
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
            record({'path': u.path, 'token_ok': token == TOKEN, **{k: v for k, v in q.items() if k != 'X-Plex-Token'}})
            if token != TOKEN:
                return self.send_json(401, {})
            body = library(u.path, q)
            return self.send_json(200, {'MediaContainer': body}) if body else self.send_json(404, {})
        if u.path.startswith('/library/parts/'):
            return self.send_video(q, token)
        if u.path == '/photo/:/transcode':
            record({'path': u.path, 'token_ok': token == TOKEN, 'url': q.get('url')})
            if token != TOKEN:
                return self.send_json(401, {})
            data = poster_png(q.get('url', ''))
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
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
