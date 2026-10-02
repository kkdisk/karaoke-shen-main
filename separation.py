"""Optional isolated Demucs worker; does not import torch into the desktop app."""
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import codecs
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import yt_dlp
from media_tools import ffmpeg_path, youtube_runtime_options

MODEL = os.environ.get('KARAOKE_AI_MODEL', 'htdemucs')
if MODEL not in ('htdemucs', 'htdemucs_ft'):
    MODEL = 'htdemucs'
MAX_DURATION = 900
ACTIVE_STATES = ('downloading', 'preparing', 'separating', 'muxing', 'cancelling')


class WorkerProgress:
    """Parse actual CLI reports, including CR-delimited tqdm updates."""
    def __init__(self, callback, duration=None, models=1):
        self.callback = callback
        self.duration = duration
        self.models = models
        self.model_index = 1
        self.last_percent = None
        self.pending = ''

    def feed(self, text, final=False):
        self.pending += text
        lines = re.split(r'[\r\n]', self.pending)
        self.pending = lines.pop()
        if final and self.pending:
            lines.append(self.pending)
            self.pending = ''
        for line in lines:
            self._line(line)
        self.pending = self.pending[-8192:]

    def _line(self, line):
        match = re.search(r'(\d+(?:\.\d+)?)%\|', line)
        if match:
            percent = min(100, float(match.group(1)))
            if 'seconds' in line:
                if self.last_percent == 100 and percent < 100:
                    self.model_index = min(self.models, self.model_index + 1)
                self.last_percent = percent
                overall = ((self.model_index - 1) * 100 + percent) / self.models
                self.callback(overall, f'模型 {self.model_index}/{self.models} · 分段處理 {percent:g}%')
            elif re.search(r'[KMGT]?B/s', line):
                self.callback(None, f'下載模型權重 {percent:g}%')
        if self.duration and line.startswith('out_time_us='):
            try:
                seconds = max(0, int(line.split('=', 1)[1]) / 1_000_000)
                percent = min(99, seconds / self.duration * 100)
                self.callback(percent, f'已處理 {seconds:.0f} / {self.duration:.0f} 秒音訊')
            except ValueError:
                pass


def valid_video_id(value):
    return isinstance(value, str) and re.fullmatch(r'[a-zA-Z0-9_-]{11}', value) is not None


def youtube_id(value):
    if not isinstance(value, str):
        raise ValueError('請輸入 YouTube 網址')
    url = urlparse(value)
    if url.scheme not in ('http', 'https') or url.username or url.password:
        raise ValueError('請輸入有效的 YouTube 網址')
    host = (url.hostname or '').lower()
    parts = url.path.strip('/').split('/')
    if host == 'youtu.be':
        video_id = parts[0]
    elif host in ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'):
        video_id = (parse_qs(url.query).get('v', [''])[0] if url.path == '/watch'
                    else parts[1] if len(parts) == 2 and parts[0] in ('shorts', 'embed', 'live') else '')
    else:
        video_id = ''
    if not valid_video_id(video_id):
        raise ValueError('僅支援 YouTube 單一影片網址')
    return video_id


class SeparationService:
    def __init__(self, root):
        self.root = Path(root)
        self.jobs = {}
        self.lock = threading.Lock()
        self.cancel_event = threading.Event()
        self.process = None
        base = Path(sys.executable).parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent
        relative_python = 'Scripts/python.exe' if os.name == 'nt' else 'bin/python'
        local = base / '.venv-ai' / relative_python
        if not local.is_file() and getattr(sys, 'frozen', False):
            local = base.parent / '.venv-ai' / relative_python
        self.python = os.environ.get('KARAOKE_AI_PYTHON') or (
            str(local) if local.is_file() else sys.executable if not getattr(sys, 'frozen', False) else '')
        self.ffmpeg = ffmpeg_path()
        self._capability = None

    def capabilities(self):
        if self._capability is not None:
            return dict(self._capability)
        ready = False
        message = '需安裝 FFmpeg 與 AI 環境，詳見 README.md'
        if self.ffmpeg and self.python:
            try:
                result = subprocess.run([self.python, '-c',
                                        'import demucs, torch, torchaudio, soundfile; '
                                        'assert tuple(map(int, torch.__version__.split("+")[0].split(".")[:2])) >= (2, 10)'],
                                        capture_output=True, timeout=30,
                                        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                ready = result.returncode == 0
            except (OSError, subprocess.TimeoutExpired):
                pass
        self._capability = {'available': ready, 'model': MODEL,
                            'message': 'AI 就緒；首次使用會下載模型，CPU 處理可能需要數分鐘' if ready else message}
        return dict(self._capability)

    def _ready(self, video_id):
        folder = self.root / video_id
        try:
            manifest = json.loads((folder / 'ready.json').read_text())
            return isinstance(manifest, dict) and manifest.get('model') == MODEL and all(
                (folder / name).is_file() and (folder / name).stat().st_size > 0
                for name in ('original.mp4', 'karaoke.mp4'))
        except (OSError, ValueError):
            return False

    def status(self, video_id):
        if not valid_video_id(video_id):
            raise ValueError('無效的影片 ID')
        with self.lock:
            if self._ready(video_id):
                job = self.jobs.get(video_id, {})
                return {'state': 'ready', 'message': 'AI 伴奏已完成，可保留立體聲伴奏播放',
                        'progress': 100, 'elapsed_seconds': self._elapsed(job),
                        'original': f'/accompaniment/{video_id}/original',
                        'karaoke': f'/accompaniment/{video_id}/karaoke'}
            job = self.jobs.get(video_id, {'state': 'idle', 'message': '尚未製作 AI 伴奏'})
            if job['state'] == 'ready':
                return {'state': 'idle', 'message': '伴奏快取已移除或損壞，請重新製作'}
            return {**{key: value for key, value in job.items() if key not in ('started_at', 'ended_at')},
                    'elapsed_seconds': self._elapsed(job)}

    @staticmethod
    def _elapsed(job):
        started = job.get('started_at')
        if started is None:
            return None
        return round(max(0, job.get('ended_at', time.monotonic()) - started))

    def start(self, video_id):
        current = self.status(video_id)
        if current['state'] == 'ready':
            return current
        if not self.capabilities()['available']:
            return {'state': 'unavailable', 'message': self.capabilities()['message']}
        with self.lock:
            if any(job['state'] in ACTIVE_STATES for job in self.jobs.values()):
                return {'state': 'busy', 'message': '已有歌曲正在處理，請完成後再試'}
            self.cancel_event.clear()
            if len(self.jobs) > 100:
                self.jobs.clear()
            self.jobs[video_id] = {'state': 'downloading', 'message': '正在下載音樂影片…',
                                   'started_at': time.monotonic(), 'progress': None,
                                   'detail': '正在解析來源與取得下載資訊'}
        threading.Thread(target=self._worker, args=(video_id,), daemon=True).start()
        return self.status(video_id)

    def _set(self, video_id, state, message):
        with self.lock:
            previous = self.jobs.get(video_id, {})
            self.jobs[video_id] = {'state': state, 'message': message,
                                   'started_at': previous.get('started_at', time.monotonic()),
                                   'progress': 100 if state == 'ready' else None, 'detail': ''}
            if state not in ACTIVE_STATES:
                self.jobs[video_id]['ended_at'] = time.monotonic()

    def _progress(self, video_id, state, percent, detail):
        with self.lock:
            job = self.jobs.get(video_id)
            if job and job['state'] == state:
                job.update(progress=None if percent is None else round(max(0, min(100, percent)), 1),
                           detail=detail)

    def cancel(self, video_id):
        if not valid_video_id(video_id):
            raise ValueError('無效的影片 ID')
        with self.lock:
            if self.jobs.get(video_id, {}).get('state') in ACTIVE_STATES:
                self.cancel_event.set()
                self.jobs[video_id].update(state='cancelling', message='正在取消製作…', detail='', progress=None)
        return self.status(video_id)

    def close(self):
        self.cancel_event.set()
        with self.lock:
            process = self.process
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def _run(self, command, folder, timeout, progress=None):
        environment = os.environ.copy()
        environment.setdefault('TORCH_HOME', str(self.root / '.models'))
        environment['PYTHONUNBUFFERED'] = '1'
        environment['PYTHONIOENCODING'] = 'utf-8'
        with (folder / 'worker.log').open('ab') as output, (folder / 'worker.log').open('rb') as reader:
            start_offset = output.tell()
            decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
            reader.seek(start_offset)

            def report(final=False):
                if progress:
                    progress.feed(decoder.decode(reader.read(), final=final), final=final)
            if self.cancel_event.is_set():
                raise RuntimeError('已取消')
            process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT,
                                       env=environment, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            with self.lock:
                self.process = process
            deadline = time.monotonic() + timeout
            try:
                while process.poll() is None:
                    if self.cancel_event.wait(0.2):
                        raise RuntimeError('已取消')
                    if time.monotonic() > deadline:
                        raise subprocess.TimeoutExpired(command, timeout)
                    report()
                report(final=True)
                if process.returncode:
                    raise subprocess.CalledProcessError(process.returncode, command)
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
                with self.lock:
                    self.process = None

    def _worker(self, video_id):
        folder = self.root / video_id
        failure = None
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            used = sum(p.stat().st_size for p in self.root.rglob('*') if p.is_file())
            if used > 2 * 1024**3:
                raise ValueError('伴奏快取已超過 2GB；請依 README 清理快取後再試')
            folder.mkdir(exist_ok=True)
            if shutil.disk_usage(folder).free < 2 * 1024**3:
                raise ValueError('製作伴奏需要至少 2GB 可用空間')

            def limit(info, *, incomplete=False):
                if info.get('is_live') or (info.get('duration') or 0) > MAX_DURATION:
                    return 'AI 伴奏僅支援 15 分鐘以內的非直播影片'

            download_files = []
            download_total = 1

            def progress(data):
                if self.cancel_event.is_set():
                    raise RuntimeError('已取消')
                if data.get('status') not in ('downloading', 'finished'):
                    return
                filename = data.get('filename') or ''
                if filename not in download_files:
                    download_files.append(filename)
                total = data.get('total_bytes') or data.get('total_bytes_estimate')
                percent = (100 if data['status'] == 'finished' else
                           min(100, (data.get('downloaded_bytes') or 0) / total * 100) if total else None)
                detail = f'影音軌 {len(download_files)}/{download_total}'
                speed = data.get('speed')
                if speed:
                    detail += f' · {speed / 1024**2:.1f} MB/s'
                eta = data.get('eta')
                if eta is not None:
                    detail += f' · 此軌預估剩餘 {round(eta)} 秒'
                self._progress(video_id, 'downloading', percent, detail)

            options = {'format': 'bestvideo[ext=mp4][vcodec^=avc1][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]',
                       'outtmpl': str(folder / 'original.%(ext)s'), 'merge_output_format': 'mp4',
                       'noplaylist': True, 'socket_timeout': 20, 'retries': 2,
                       'max_filesize': 500 * 1024**2, 'match_filter': limit, 'quiet': True,
                       'ffmpeg_location': self.ffmpeg}
            options['source_address'] = '0.0.0.0'
            options['logger'] = logging.getLogger('karaoke')
            options['progress_hooks'] = [progress]
            options.update(youtube_runtime_options())
            with yt_dlp.YoutubeDL(options) as ydl:
                info = ydl.extract_info(f'https://www.youtube.com/watch?v={video_id}', download=False)
                reason = limit(info or {})
                if reason:
                    raise ValueError(reason)
                download_total = len((info or {}).get('requested_formats') or []) or 1
                ydl.download([f'https://www.youtube.com/watch?v={video_id}'])
            original = folder / 'original.mp4'
            if not original.exists():
                raise ValueError('未能下載可用影片')
            # Explicit WAV decoding avoids torchaudio codec differences on Windows.
            duration = (info or {}).get('duration')
            self._set(video_id, 'preparing', '正在準備 AI 分離用的音訊…')
            self._run([self.ffmpeg, '-y', '-nostdin', '-i', str(original), '-vn',
                       '-ar', '44100', '-ac', '2', '-progress', 'pipe:1', '-nostats',
                       str(folder / 'input.wav')], folder, 300,
                      WorkerProgress(lambda percent, detail: self._progress(video_id, 'preparing', percent, detail), duration=duration))
            self._set(video_id, 'separating', 'AI 正在分離人聲與伴奏…首次使用會下載模型')
            self._progress(video_id, 'separating', None, '正在載入模型；第一個分段完成後會顯示百分比')
            self._run([self.python, str(Path(__file__).resolve().parent / 'ai_worker.py'), '-n', MODEL, '--two-stems=vocals',
                       '--device', 'cpu', '--shifts', '1', '-o', str(folder / 'stems'),
                       str(folder / 'input.wav')], folder, 3600,
                      WorkerProgress(lambda percent, detail: self._progress(video_id, 'separating', percent, detail),
                                     models=4 if MODEL == 'htdemucs_ft' else 1))
            stem = folder / 'stems' / MODEL / 'input' / 'no_vocals.wav'
            self._set(video_id, 'muxing', '正在合成可拖曳進度的歡唱影片…')
            self._run([self.ffmpeg, '-y', '-nostdin', '-i', str(original), '-i', str(stem),
                       '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac',
                       '-b:a', '256k', '-movflags', '+faststart', '-shortest',
                       '-progress', 'pipe:1', '-nostats', str(folder / 'karaoke.mp4')], folder, 300,
                      WorkerProgress(lambda percent, detail: self._progress(video_id, 'muxing', percent, detail), duration=duration))
            if self.cancel_event.is_set():
                raise RuntimeError('已取消')
            (folder / 'ready.tmp').write_text(json.dumps({'model': MODEL}), encoding='utf-8')
            (folder / 'ready.tmp').replace(folder / 'ready.json')
            self._set(video_id, 'ready', 'AI 伴奏已完成')
        except Exception as exc:
            logging.getLogger('karaoke').exception('AI separation failed: %s', video_id)
            public_messages = {'伴奏快取已超過 2GB；請依 README 清理快取後再試',
                               '製作伴奏需要至少 2GB 可用空間', 'AI 伴奏僅支援 15 分鐘以內的非直播影片',
                               '未能下載可用影片'}
            public_error = str(exc) if isinstance(exc, ValueError) and str(exc) in public_messages else '無法完成伴奏製作'
            failure = ('cancelled', '已取消，可稍後重新製作') if self.cancel_event.is_set() else (
                'error', f'製作失敗：{public_error}。可繼續快速歡唱；詳見本機日誌')
        finally:
            if valid_video_id(video_id) and folder.parent.resolve() == self.root.resolve():
                (folder / 'input.wav').unlink(missing_ok=True)
                shutil.rmtree(folder / 'stems', ignore_errors=True)
            if failure:
                self._set(video_id, *failure)
