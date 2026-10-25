"""Minimal Plex Media Server stand-in for testing the IINA plugin without a real server.

Serves a small TV show whose episodes all play the same video file at /library/parts/
paths (with HTTP range support, so IINA can seek), plus the library lookups the plugin
makes: episode details with intro and credits markers, a season's episodes, a show's
seasons, and thumbnails. Every progress call (/:/timeline, /:/progress, /:/scrobble) and
lookup is appended to a JSON-lines log, and so is every video request ("media", with the
byte offset it starts at), so you can see when a seek made IINA re-download.

The show (markers are placed relative to the video's length; shown here for 40 s):

    4242  S01E01  intro 5-12 s, final credits 30-40 s      Up Next with countdown
    4243  S01E02  no markers                               Up Next in the last seconds
    4244  S01E03  resume point 15 s, intro 2-8 s,          Skip Intro, Skip Credits,
                  mid credits 20-26 s, final credits 34 s  then Up Next (next season)
    4245  S02E01  final credits 32-40 s, last episode      nothing to play next

Progress calls update the episodes' watch state, as on a real server.

Usage:
    ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=24 -f lavfi -i sine=frequency=440 \\
        -f lavfi -i sine=frequency=660 -t 40 -map 0 -map 1 -map 2 \\
        -c:v libx264 -pix_fmt yuv420p -c:a aac \\
        -metadata:s:a:0 language=eng -metadata:s:a:1 language=jpn test.mkv
    python3 tools/mock-pms.py test.mkv 32411 calls.jsonl
    open 'iina://open?url=http%3A%2F%2F127.0.0.1%3A32411%2Flibrary%2Fparts%2F4242%2F1%2Ffile.mkv%3FX-Plex-Token%3Dtok123%26plexRatingKey%3D4242&mpv_start=none'
    tail -f calls.jsonl

Expect "playing" reports every 10 s, "paused" plus /:/progress when you pause,
/:/scrobble past 90% or at the final credits, and "stopped" when the episode ends or you
close the window. The next episode is added to IINA's playlist and plays when one ends.
Tracks come from the file (ffprobe), so a file with several audio or subtitle tracks
tests that the next episode keeps the languages you switched to.
"""
import json
import os
import re
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

VIDEO = sys.argv[1]
PORT = int(sys.argv[2])
LOG = sys.argv[3]
TOKEN = 'tok123'
T0 = time.time()

SHOW, SEASON1, SEASON2 = '100', '101', '102'


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


EPISODES = {
    '4242': {'season': SEASON1, 'parentIndex': 1, 'index': 1, 'title': 'Pilot',
             'markers': [marker('intro', 0.125, 0.3), marker('credits', 0.75, 1.0, final=True)]},
    '4243': {'season': SEASON1, 'parentIndex': 1, 'index': 2, 'title': 'No Markers', 'markers': []},
    '4244': {'season': SEASON1, 'parentIndex': 1, 'index': 3, 'title': 'Mid-Credits Scene',
             'viewOffset': at(0.375),
             'markers': [marker('intro', 0.05, 0.2), marker('credits', 0.5, 0.65),
                         marker('credits', 0.85, 1.0, final=True)]},
    '4245': {'season': SEASON2, 'parentIndex': 2, 'index': 1, 'title': 'Last One',
             'markers': [marker('credits', 0.8, 1.0, final=True)]},
}
SEASONS = {SEASON1: {'index': 1, 'title': 'Season 1'}, SEASON2: {'index': 2, 'title': 'Season 2'}}


def episode(key, details):
    ep = EPISODES[key]
    item = {'ratingKey': key, 'key': f'/library/metadata/{key}', 'type': 'episode', 'title': ep['title'],
            'index': ep['index'], 'parentIndex': ep['parentIndex'], 'parentRatingKey': ep['season'],
            'parentTitle': SEASONS[ep['season']]['title'], 'grandparentRatingKey': SHOW,
            'grandparentTitle': 'Test Show', 'duration': DURATION, 'thumb': f'/library/metadata/{key}/thumb/1'}
    for field in ('viewOffset', 'viewCount'):
        if ep.get(field):
            item[field] = ep[field]
    part = {'id': int(key), 'key': f'/library/parts/{key}/1/file.mkv', 'duration': DURATION}
    if details:
        part['Stream'] = STREAMS  # like Plex, only in an item's own details
    item['Media'] = [{'id': int(key), 'duration': DURATION, 'width': 1280, 'height': 720, 'Part': [part]}]
    return item


def record(entry):
    entry['t'] = round(time.time() - T0, 1)
    with open(LOG, 'a') as f:
        f.write(json.dumps(entry) + '\n')


def update_watch_state(path, q):
    ep = EPISODES.get(q.get('ratingKey') or q.get('key', '').rsplit('/', 1)[-1])
    if not ep:
        return
    if path == '/:/scrobble':
        ep['viewCount'] = ep.get('viewCount', 0) + 1
        ep.pop('viewOffset', None)
    elif (path == '/:/progress' or q.get('state') == 'stopped') and int(q.get('time', 0)) < DURATION * 0.9:
        ep['viewOffset'] = int(q.get('time', 0))


def thumbnail(label):
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270">'
           '<defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#2b3a55"/>'
           '<stop offset="1" stop-color="#7a4b2a"/></linearGradient></defs>'
           '<rect width="480" height="270" fill="url(#g)"/>'
           f'<text x="240" y="150" fill="#fff" font-family="Helvetica" font-size="44" text-anchor="middle">{label}</text>'
           '</svg>')
    return svg.encode()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def send_body(self, code, data, content_type):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, code, body):
        self.send_body(code, json.dumps(body).encode(), 'application/json')

    def send_items(self, items):
        self.send_json(200, {'MediaContainer': {'size': len(items), 'Metadata': items}})

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        token_ok = q.pop('X-Plex-Token', None) == TOKEN
        if u.path in ('/:/timeline', '/:/progress', '/:/scrobble'):
            record({'path': u.path, 'token_ok': token_ok,
                    'client': self.headers.get('X-Plex-Client-Identifier'),
                    'product': self.headers.get('X-Plex-Product'), **q})
            update_watch_state(u.path, q)
            return self.send_json(200, {})
        if u.path.startswith('/library/metadata/') or u.path.startswith('/photo/'):
            record({'path': u.path, 'token_ok': token_ok, **q})
            if not token_ok:
                return self.send_json(401, {})
        m = re.fullmatch(r'/library/metadata/(\d+)(/children)?', u.path)
        if m:
            key, children = m.groups()
            if key in EPISODES and not children:
                item = episode(key, details=True)
                if q.get('includeMarkers') == '1':
                    item['Marker'] = EPISODES[key]['markers']
                return self.send_items([item])
            if key in SEASONS and children:
                return self.send_items([episode(k, details=False) for k, ep in EPISODES.items() if ep['season'] == key])
            if key == SHOW and children:
                return self.send_items([{'ratingKey': k, 'type': 'season', 'index': s['index'], 'title': s['title'],
                                         'leafCount': sum(ep['season'] == k for ep in EPISODES.values())}
                                        for k, s in SEASONS.items()])
            return self.send_json(404, {})
        if u.path == '/photo/:/transcode':
            key = re.search(r'/library/metadata/(\d+)/', q.get('url', ''))
            ep = EPISODES.get(key.group(1)) if key else None
            label = f"S{ep['parentIndex']:02d}E{ep['index']:02d}" if ep else '?'
            return self.send_body(200, thumbnail(label), 'image/svg+xml')
        if u.path.startswith('/library/parts/'):
            size = os.path.getsize(VIDEO)
            start, end = 0, size - 1
            rng = self.headers.get('Range')
            if rng and rng.startswith('bytes='):
                a, _, b = rng[6:].partition('-')
                start = int(a) if a else size - int(b)
                end = int(b) if a and b else size - 1
            # Each new request means IINA (re)started reading at this offset, e.g. after
            # a seek outside its buffer.
            record({'path': 'media', 'part': u.path, 'token_ok': token_ok,
                    'from_byte': start, 'from_pct': round(100 * start / size, 1)})
            self.send_response(206 if rng else 200)
            self.send_header('Content-Type', 'video/x-matroska')
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(end - start + 1))
            if rng:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
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
                except (BrokenPipeError, ConnectionResetError):
                    pass
            return
        self.send_json(404, {})


ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
