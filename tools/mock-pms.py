"""Minimal Plex Media Server stand-in for testing the IINA plugin without a real server.

Serves one video file at a /library/parts/ path (with HTTP range support, so IINA can
seek) and appends every progress call the plugin makes (/:/timeline, /:/progress,
/:/scrobble) to a JSON-lines log. Every video request is logged too ("media", with the
byte offset it starts at), so you can see when a seek made IINA re-download.

Usage:
    ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=24 -f lavfi -i sine -t 40 \\
        -c:v libx264 -pix_fmt yuv420p -c:a aac test.mkv
    python3 tools/mock-pms.py test.mkv 32411 calls.jsonl
    open 'iina://open?url=http%3A%2F%2F127.0.0.1%3A32411%2Flibrary%2Fparts%2F1%2F1%2Ffile.mkv%3FX-Plex-Token%3Dtok123%26plexRatingKey%3D4242&mpv_start=5'
    tail -f calls.jsonl

Expect "playing" reports every 10 s, "paused" plus /:/progress when you pause,
/:/scrobble past 90%, and "stopped" when you close the window.
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
T0 = time.time()


def record(entry):
    entry['t'] = round(time.time() - T0, 1)
    with open(LOG, 'a') as f:
        f.write(json.dumps(entry) + '\n')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def send_json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path in ('/:/timeline', '/:/progress', '/:/scrobble'):
            record({'path': u.path, 'token_ok': q.pop('X-Plex-Token', None) == TOKEN,
                    'client': self.headers.get('X-Plex-Client-Identifier'),
                    'product': self.headers.get('X-Plex-Product'), **q})
            return self.send_json(200, {})
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
            record({'path': 'media', 'token_ok': q.get('X-Plex-Token') == TOKEN,
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
