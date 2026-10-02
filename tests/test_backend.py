import io
import json
import tempfile
import unittest
import threading
import sys
from pathlib import Path
from unittest.mock import Mock, patch

import bottle
import main
from separation import SeparationService, WorkerProgress, youtube_id, valid_video_id

VIDEO = 'dQw4w9WgXcQ'


def call_route(path, query='', extra=None):
    environ = {'REQUEST_METHOD': 'GET', 'PATH_INFO': path, 'QUERY_STRING': query,
               'SERVER_NAME': 'localhost', 'SERVER_PORT': '8000', 'SERVER_PROTOCOL': 'HTTP/1.1',
               'wsgi.url_scheme': 'http', 'wsgi.input': io.BytesIO(), 'wsgi.errors': io.StringIO()}
    environ.update(extra or {})
    result = {}
    def start(status, headers, exc_info=None):
        result.update(status=status, headers=dict(headers))
    chunks = bottle.default_app()(environ, start)
    try:
        result['body'] = b''.join(chunks)
    finally:
        if hasattr(chunks, 'close'):
            chunks.close()
    return result


class BackendTests(unittest.TestCase):
    def test_demucs_progress_handles_cr_partial_lines_and_model_download(self):
        callback = Mock()
        parser = WorkerProgress(callback)
        parser.feed(' 25%|##| 20.0M/80.2M [00:01<00:03, 20MB/s]\r 4')
        callback.assert_called_once_with(None, '下載模型權重 25%')
        parser.feed('0%|####| 40/100 [00:10<00:15, 4seconds/s]\r')
        callback.assert_called_with(40, '模型 1/1 · 分段處理 40%')

    def test_finetuned_progress_aggregates_four_models_without_duplicate_completion(self):
        callback = Mock()
        parser = WorkerProgress(callback, models=4)
        parser.feed('100%|###| 100/100 [00:10<00:00, 10seconds/s]\r'
                    '100%|###| 100/100 [00:10<00:00, 10seconds/s]\n'
                    '0%| | 0/100 [00:00<?, ?seconds/s]\r'
                    '50%|###| 50/100 [00:05<00:05, 10seconds/s]\r')
        callback.assert_called_with(37.5, '模型 2/4 · 分段處理 50%')

    def test_ffmpeg_progress_is_from_actual_media_time_and_capped_before_finish(self):
        callback = Mock()
        parser = WorkerProgress(callback, duration=100)
        parser.feed('out_time_us=50000000\n')
        callback.assert_called_with(50, '已處理 50 / 100 秒音訊')
        parser.feed('out_time_us=N/A\nout_time_us=100000000', final=True)
        callback.assert_called_with(99, '已處理 100 / 100 秒音訊')

    def test_elapsed_freezes_at_completion_and_cancel_ignores_late_updates(self):
        with tempfile.TemporaryDirectory() as root:
            service = SeparationService(root)
            with patch('separation.time.monotonic', return_value=10):
                service._set(VIDEO, 'separating', 'working')
            service._progress(VIDEO, 'separating', 30, 'segment')
            with patch('separation.time.monotonic', return_value=20):
                self.assertEqual(service.status(VIDEO)['elapsed_seconds'], 10)
            service.cancel(VIDEO)
            service._progress(VIDEO, 'separating', 99, 'late report')
            self.assertIsNone(service.status(VIDEO)['progress'])
            self.assertEqual(service.status(VIDEO)['state'], 'cancelling')
            with patch('separation.time.monotonic', return_value=30):
                service._set(VIDEO, 'cancelled', 'cancelled')
            with patch('separation.time.monotonic', return_value=60):
                self.assertEqual(service.status(VIDEO)['elapsed_seconds'], 20)

    def test_running_process_reports_progress_before_it_exits(self):
        with tempfile.TemporaryDirectory() as root:
            service = SeparationService(root)
            reports = []
            def report(percent, detail):
                reports.append(percent)
                self.assertIsNotNone(service.process)
                if percent == 50:
                    self.assertIsNone(service.process.poll())
            parser = WorkerProgress(report)
            service._run([sys.executable, '-u', '-c',
                          "import time; print('50%|###| 50/100 [00:01<00:01, 50seconds/s]', flush=True); time.sleep(0.5); print('100%|###| 100/100 [00:02<00:00, 50seconds/s]', flush=True)"],
                         Path(root), 5, progress=parser)
            self.assertIn(50, reports)
            self.assertIn(100, reports)

    def test_url_validation(self):
        for url in (f'https://youtu.be/{VIDEO}', f'https://www.youtube.com/watch?v={VIDEO}&list=abc',
                    f'https://www.youtube.com/shorts/{VIDEO}'):
            self.assertEqual(youtube_id(url), VIDEO)
        for url in (f'https://youtube.com.evil.test/watch?v={VIDEO}',
                    f'https://evil.test/youtube.com/watch?v={VIDEO}', 'file:///etc/passwd',
                    f'https://youtube.com@evil.test/watch?v={VIDEO}', 'https://youtube.com/playlist?list=abc'):
            with self.assertRaises(ValueError):
                youtube_id(url)
        self.assertFalse(valid_video_id(VIDEO + '\n'))
        self.assertFalse(valid_video_id('../secret'))

    def test_dash_selection_compatible_and_missing_metadata(self):
        formats = [dict(vcodec='vp9', acodec='none', ext='webm', height=1080, url='vp9'),
                   dict(vcodec='avc1', acodec='none', ext='mp4', height=None, url='unknown'),
                   dict(vcodec='avc1', acodec='none', ext='mp4', height=720, url='h264'),
                   dict(vcodec='none', acodec='mp4a', abr=None, tbr=None, url='audio')]
        video, audio = main._find_best_dash_streams(formats)
        self.assertEqual(video['url'], 'h264')
        self.assertEqual(audio['url'], 'audio')
        self.assertEqual(main._find_best_dash_streams(formats[:2]), (None, None))

    def test_upstream_closed_on_disconnect(self):
        upstream = Mock()
        upstream.iter_content.return_value = iter([b'first', b'second'])
        stream = main._upstream_chunks(upstream)
        self.assertEqual(next(stream), b'first')
        stream.close()
        upstream.close.assert_called_once()

    def test_ffmpeg_terminated_on_disconnect(self):
        process = Mock(stdout=io.BytesIO(b'video'))
        process.poll.return_value = None
        with patch('main.subprocess.Popen', return_value=process):
            stream = main._stream_ffmpeg_mux('video', 'audio')
            self.assertEqual(next(stream), b'video')
            stream.close()
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=5)
        self.assertTrue(process.stdout.closed)

    def test_ffmpeg_preserves_source_headers_without_header_injection(self):
        args = main._ffmpeg_input('https://example.test', {'User-Agent': 'TestAgent',
                                                         'Injected': 'value\r\nOther: bad'})
        self.assertIn('User-Agent: TestAgent\r\n', args)
        self.assertNotIn('Other: bad', ''.join(args))

    def test_invalid_proxy_returns_400(self):
        self.assertTrue(call_route('/proxy_stream', 'v=bad')['status'].startswith('400'))

    def test_proxy_forwards_ranges_and_closes_upstream(self):
        fmt = dict(ext='mp4', vcodec='avc1', acodec='mp4a', url='https://example.test/video', height=360)
        upstream = Mock(status_code=206, headers={'Content-Range': 'bytes 2-4/10', 'Content-Length': '3'})
        upstream.iter_content.return_value = iter([b'abc'])
        with patch('main._stream_info', return_value={'formats': [fmt]}), patch('main.requests.get', return_value=upstream) as get:
            result = call_route('/proxy_stream', f'v={VIDEO}', {'HTTP_RANGE': 'bytes=2-4'})
        self.assertTrue(result['status'].startswith('206'))
        self.assertEqual(result['headers']['Content-Range'], 'bytes 2-4/10')
        self.assertEqual(result['body'], b'abc')
        self.assertEqual(get.call_args.kwargs['headers']['Range'], 'bytes=2-4')
        upstream.close.assert_called_once()

    def test_cache_does_not_reextract_for_range_requests(self):
        main._info_cache.clear()
        with patch('main.yt_dlp.YoutubeDL') as factory:
            factory.return_value.__enter__.return_value.extract_info.return_value = {'formats': []}
            main._stream_info(VIDEO)
            main._stream_info(VIDEO)
            factory.assert_called_once()
        main._info_cache.clear()

    def test_ai_manifest_requires_both_nonempty_files(self):
        with tempfile.TemporaryDirectory() as root:
            service = SeparationService(root)
            folder = Path(root) / VIDEO
            folder.mkdir()
            (folder / 'ready.json').write_text(json.dumps({'model': 'htdemucs'}))
            (folder / 'original.mp4').write_bytes(b'video')
            self.assertEqual(service.status(VIDEO)['state'], 'idle')
            (folder / 'karaoke.mp4').write_bytes(b'accompaniment')
            self.assertEqual(service.status(VIDEO)['state'], 'ready')
            self.assertEqual(service.start(VIDEO)['state'], 'ready')

    def test_ai_deduplicates_active_jobs(self):
        with tempfile.TemporaryDirectory() as root:
            service = SeparationService(root)
            service._capability = {'available': True}
            service._set(VIDEO, 'separating', 'working')
            with patch('separation.threading.Thread') as thread:
                self.assertEqual(service.start(VIDEO)['state'], 'busy')
                thread.assert_not_called()

    def test_cancel_stops_worker_process(self):
        with tempfile.TemporaryDirectory() as root:
            service = SeparationService(root)
            timer = threading.Timer(0.1, service.cancel_event.set)
            timer.start()
            try:
                with self.assertRaisesRegex(RuntimeError, '已取消'):
                    service._run([sys.executable, '-c', 'import time; time.sleep(30)'], Path(root), 40)
            finally:
                timer.cancel()
            self.assertIsNone(service.process)

    def test_removed_ready_cache_becomes_idle(self):
        with tempfile.TemporaryDirectory() as root:
            service = SeparationService(root)
            service._set(VIDEO, 'ready', 'ready')
            self.assertEqual(service.status(VIDEO)['state'], 'idle')

    def test_cached_media_range_and_path_validation(self):
        with tempfile.TemporaryDirectory() as root:
            service = SeparationService(root)
            folder = Path(root) / VIDEO
            folder.mkdir()
            (folder / 'ready.json').write_text(json.dumps({'model': 'htdemucs'}))
            (folder / 'original.mp4').write_bytes(b'original')
            (folder / 'karaoke.mp4').write_bytes(b'0123456789')
            with patch('main.CACHE_ROOT', Path(root)), patch('main.ai_service', service):
                result = call_route(f'/accompaniment/{VIDEO}/karaoke', extra={'HTTP_RANGE': 'bytes=2-4'})
                self.assertTrue(result['status'].startswith('206'))
                self.assertEqual(result['body'], b'234')
                self.assertTrue(call_route(f'/accompaniment/{VIDEO}/worker.log')['status'].startswith('400'))


if __name__ == '__main__':
    unittest.main()
