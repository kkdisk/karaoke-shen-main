"""Local YouTube karaoke app with optional AI accompaniment."""
import logging
import os
import re
import subprocess
import tempfile
import time
from collections import OrderedDict
from pathlib import Path

import eel
import requests
import yt_dlp
from gevent import get_hub
from bottle import HTTPError, request, response, static_file
from separation import SeparationService, valid_video_id, youtube_id
from media_tools import ffmpeg_path, youtube_runtime_options
from security import LocalOnlyMiddleware, LocalWebSocketServer, RedactingFormatter, safe_rpc

FFMPEG = ffmpeg_path()
HAS_FFMPEG = FFMPEG is not None
SEARCH_OPTS = {'quiet': True, 'extract_flat': True, 'socket_timeout': 15, 'noplaylist': True,
               'logger': logging.getLogger('karaoke'), 'source_address': '0.0.0.0'}
SEARCH_OPTS.update(youtube_runtime_options())
STREAM_OPTS = {
    'format': ('bestvideo[ext=mp4][vcodec^=avc1][height<=1080]+bestaudio/best'
               if HAS_FFMPEG else 'best[ext=mp4][vcodec!=none][acodec!=none]'),
    'quiet': True, 'noplaylist': True, 'socket_timeout': 20,
    'ffmpeg_location': FFMPEG,
    'logger': logging.getLogger('karaoke'),
    'source_address': '0.0.0.0',
}
STREAM_OPTS.update(youtube_runtime_options())
CACHE_ROOT = Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'ShenKaraoke' / 'cache'
ai_service = SeparationService(CACHE_ROOT)
_info_cache = OrderedDict()
log = logging.getLogger('karaoke')


def _video_item(info):
    video_id = info.get('id')
    if not valid_video_id(video_id):
        raise ValueError('不是有效的 YouTube 單一影片')
    thumbs = info.get('thumbnails') or []
    return {'id': video_id, 'title': info.get('title') or video_id,
            'thumbnail': info.get('thumbnail') or (thumbs[-1].get('url') if thumbs else ''),
            'url': f'https://www.youtube.com/watch?v={video_id}'}


@eel.expose
@safe_rpc
def search_youtube(query):
    if not isinstance(query, str) or not 0 < len(query.strip()) <= 300:
        raise ValueError('請輸入 1–300 字的搜尋內容')
    data = get_hub().threadpool.apply(_extract_search, (f'ytsearch20:{query.strip()}',))
    return [_video_item(entry) for entry in (data or {}).get('entries', [])
            if entry and valid_video_id(entry.get('id'))]


@eel.expose
@safe_rpc
def get_video_info(url):
    video_id = youtube_id(url)
    info = get_hub().threadpool.apply(_extract_search, (f'https://www.youtube.com/watch?v={video_id}',))
    return _video_item(info or {})


def _extract_search(url):
    with yt_dlp.YoutubeDL(SEARCH_OPTS) as ydl:
        return ydl.extract_info(url, download=False)


@eel.expose
@safe_rpc
def get_stream_url(video_id):
    if not valid_video_id(video_id):
        raise ValueError('無效的影片 ID')
    return f'/proxy_stream?v={video_id}'


@eel.expose
@safe_rpc
def get_quality_info():
    return {'has_ffmpeg': HAS_FFMPEG, 'ai': get_hub().threadpool.apply(ai_service.capabilities),
            'max_quality': '最高 1080p' if HAS_FFMPEG else '來源提供的合併 MP4'}


@eel.expose
@safe_rpc
def prepare_accompaniment(video_id):
    return get_hub().threadpool.apply(ai_service.start, (video_id,))


@eel.expose
@safe_rpc
def accompaniment_status(video_id):
    return ai_service.status(video_id)


@eel.expose
@safe_rpc
def cancel_accompaniment(video_id):
    return ai_service.cancel(video_id)


def _find_best_dash_streams(formats):
    videos = [f for f in formats if str(f.get('vcodec', '')).startswith(('avc1', 'h264'))
              and f.get('acodec') in (None, 'none') and f.get('ext') == 'mp4'
              and f.get('protocol') in (None, 'https', 'http') and f.get('url')
              and 0 < (f.get('height') or 0) <= 1080 and not f.get('has_drm')]
    audios = [f for f in formats if f.get('acodec') not in (None, 'none')
              and f.get('vcodec') in (None, 'none') and f.get('url')
              and f.get('protocol') in (None, 'https', 'http') and not f.get('has_drm')]
    if not videos or not audios:
        return None, None
    return (max(videos, key=lambda f: (f.get('height') or 0, f.get('tbr') or 0)),
            max(audios, key=lambda f: f.get('abr') or f.get('tbr') or 0))


def _ffmpeg_input(url, headers):
    header_text = ''.join(f'{name}: {value}\r\n' for name, value in (headers or {}).items()
                          if '\r' not in str(name) + str(value) and '\n' not in str(name) + str(value))
    options = ['-rw_timeout', '20000000']
    if header_text:
        options += ['-headers', header_text]
    return options + ['-i', url]


def _stream_ffmpeg_mux(video_url, audio_url, video_headers=None, audio_headers=None):
    cmd = [FFMPEG, '-nostdin'] + _ffmpeg_input(video_url, video_headers) + _ffmpeg_input(audio_url, audio_headers)
    cmd += ['-map', '0:v:0', '-map', '1:a:0',
           '-c:v', 'copy', '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov',
           '-f', 'mp4', '-loglevel', 'error', 'pipe:1']
    with tempfile.TemporaryFile() as errors:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errors,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            while True:
                chunk = get_hub().threadpool.apply(proc.stdout.read1, (64 * 1024,))
                if not chunk:
                    break
                yield chunk
        finally:
            if proc.poll() is None:
                proc.terminate()
            try:
                get_hub().threadpool.apply(proc.wait, (), {'timeout': 5})
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            proc.stdout.close()
            errors.seek(0)
            detail = errors.read(8192).decode('utf-8', errors='replace')
            if detail:
                log.warning('FFmpeg: %s', re.sub(r'https?://\S+', '[stream URL]', detail))


def _upstream_chunks(upstream):
    try:
        iterator = upstream.iter_content(chunk_size=64 * 1024)
        while True:
            chunk = get_hub().threadpool.apply(next, (iterator, None))
            if chunk is None:
                break
            if chunk:
                yield chunk
    finally:
        upstream.close()


def _stream_info(video_id):
    now = time.monotonic()
    cached = _info_cache.get(video_id)
    if cached and now - cached[0] < 300:
        _info_cache.move_to_end(video_id)
        return cached[1]
    with yt_dlp.YoutubeDL(STREAM_OPTS) as ydl:
        info = ydl.extract_info(f'https://www.youtube.com/watch?v={video_id}', download=False)
    _info_cache[video_id] = (now, info)
    while len(_info_cache) > 32:
        _info_cache.popitem(last=False)
    return info


@eel.btl.route('/proxy_stream')
def proxy_stream():
    video_id = request.query.get('v')
    if not valid_video_id(video_id):
        return HTTPError(400, 'Invalid video id')
    try:
        info = get_hub().threadpool.apply(_stream_info, (video_id,))
        formats = info.get('formats') or []
        merged = [f for f in formats if f.get('ext') == 'mp4'
                  and str(f.get('vcodec', '')).startswith(('avc1', 'h264'))
                  and f.get('acodec') not in (None, 'none') and f.get('url')
                  and f.get('protocol') in (None, 'http', 'https') and not f.get('has_drm')]
        best = max(merged, key=lambda f: f.get('height') or 0, default=None)
        video, audio = _find_best_dash_streams(formats) if HAS_FFMPEG else (None, None)
        response.content_type = 'video/mp4'
        if video and audio and (video.get('height') or 0) > ((best or {}).get('height') or 0):
            response.set_header('Accept-Ranges', 'none')
            return _stream_ffmpeg_mux(video['url'], audio['url'],
                                      video.get('http_headers'), audio.get('http_headers'))
        if not best:
            return HTTPError(422, 'No browser-compatible format available')
        headers = dict(best.get('http_headers') or {})
        if request.headers.get('Range'):
            headers['Range'] = request.headers['Range']
        upstream = get_hub().threadpool.apply(requests.get, (best['url'],),
                                            {'headers': headers, 'stream': True, 'timeout': (10, 30)})
        if upstream.status_code not in (200, 206, 416):
            upstream.close()
            _info_cache.pop(video_id, None)
            return HTTPError(502, 'Upstream stream failed; retry playback')
        response.status = upstream.status_code
        response.set_header('Accept-Ranges', upstream.headers.get('Accept-Ranges', 'bytes'))
        for header in ('Content-Length', 'Content-Range'):
            if header in upstream.headers:
                response.set_header(header, upstream.headers[header])
        return _upstream_chunks(upstream)
    except Exception:
        _info_cache.pop(video_id, None)
        log.exception('Stream failed: %s', video_id)
        return HTTPError(502, 'Unable to prepare stream')


@eel.btl.route('/accompaniment/<video_id>/<kind>')
def accompaniment_file(video_id, kind):
    if not valid_video_id(video_id) or kind not in ('original', 'karaoke'):
        return HTTPError(400, 'Invalid media request')
    if ai_service.status(video_id)['state'] != 'ready':
        return HTTPError(404, 'Accompaniment is not ready')
    return static_file(f'{kind}.mp4', root=str(CACHE_ROOT / video_id), mimetype='video/mp4')


def main(browser_mode='chrome', port=8000):
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=str(CACHE_ROOT.parent / 'karaoke.log'), level=logging.INFO,
                        format='%(asctime)s %(levelname)s %(message)s')
    for handler in logging.getLogger().handlers:
        handler.setFormatter(RedactingFormatter('%(asctime)s %(levelname)s %(message)s'))
    eel.init(str(Path(__file__).resolve().parent / 'web'))
    application = eel.btl.default_app()
    # Eel selects this adapter internally; the replacement checks before the
    # WebSocket handshake, in addition to the HTTP application middleware.
    eel.wbs.GeventWebSocketServer = LocalWebSocketServer
    try:
        eel.start('index.html', size=(1200, 900), host='localhost', port=port, mode=browser_mode,
                  app=LocalOnlyMiddleware(application, port))
    except (SystemExit, KeyboardInterrupt):
        pass
    except Exception:
        log.exception('Application startup failed')
        raise
    finally:
        ai_service.close()


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--headless', action='store_true', help='Start local service without opening a browser')
    parser.add_argument('--port', type=int, default=8000)
    arguments = parser.parse_args()
    main(browser_mode=None if arguments.headless else 'chrome', port=arguments.port)
