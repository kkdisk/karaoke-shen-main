import unittest
import hashlib
import tempfile
from pathlib import Path
from unittest.mock import Mock

from security import LocalOnlyMiddleware, redact_diagnostic, safe_rpc
from ai_worker import verified_checkpoint


class SecurityTests(unittest.TestCase):
    def test_rebinding_and_cross_origin_are_rejected(self):
        called = []
        app = LocalOnlyMiddleware(lambda env, start: called.append(env), 8000)
        for extra in ({'HTTP_HOST': 'evil.example:8000'},
                      {'HTTP_ORIGIN': 'https://evil.example'},
                      {'HTTP_ORIGIN': 'null'}, {'HTTP_SEC_FETCH_SITE': 'cross-site'}):
            status = []
            app({'HTTP_HOST': 'localhost:8000', **extra}, lambda code, headers: status.append(code))
            self.assertEqual(status, ['403 Forbidden'])
        self.assertEqual(called, [])

    def test_valid_local_origin_and_headers(self):
        result = {}
        def application(env, start):
            start('200 OK', [('Content-Type', 'text/plain')])
            return [b'ok']
        def start(status, headers, exc_info=None):
            result.update(dict(headers))
        app = LocalOnlyMiddleware(application, 8000)
        self.assertEqual(app({'HTTP_HOST': 'localhost:8000', 'HTTP_ORIGIN': 'http://localhost:8000'}, start), [b'ok'])
        self.assertEqual(result['Referrer-Policy'], 'no-referrer')
        self.assertEqual(result['X-Frame-Options'], 'DENY')

    def test_rpc_errors_do_not_disclose_diagnostics(self):
        @safe_rpc
        def failing():
            raise ValueError('C:\\Users\\Private\\cache https://example.test/?token=secret')
        with self.assertLogs('karaoke', 'ERROR') as captured:
            result = failing()
        self.assertEqual(set(result), {'error'})
        self.assertNotIn('Private', str(result) + str(captured.output))
        self.assertNotIn('secret', str(result) + str(captured.output))

    def test_log_redaction(self):
        value = redact_diagnostic('https://example.test/?token=secret\nC:\\Users\\Private\\cache\npassword=secret')
        self.assertNotIn('secret', value)
        self.assertNotIn('Private', value)

    def test_cached_model_is_verified_every_time(self):
        content = b'official checkpoint test fixture'
        checksum = hashlib.sha256(content).hexdigest()[:8]
        name = f'955717e8-{checksum}.th'
        url = f'https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/{name}'
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder)
            target = cache / name
            target.write_bytes(content)
            download = Mock()
            self.assertEqual(verified_checkpoint(url, cache, download), target)
            download.assert_not_called()
            target.write_bytes(b'tampered checkpoint')
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                verified_checkpoint(url, cache, download)

    def test_untrusted_model_source_is_rejected(self):
        download = Mock()
        with self.assertRaisesRegex(ValueError, 'Unsupported model source'):
            verified_checkpoint('https://evil.example/model.th', Path('.'), download)
        download.assert_not_called()


if __name__ == '__main__':
    unittest.main()
