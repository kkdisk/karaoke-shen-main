"""Protect the loopback web service and keep diagnostics out of browser RPC."""
import functools
import logging
import re

from bottle import ServerAdapter
from gevent import pywsgi
from geventwebsocket.handler import WebSocketHandler


class LocalOnlyMiddleware:
    def __init__(self, application, port):
        self.application = application
        self.hosts = {f'localhost:{port}', f'127.0.0.1:{port}', f'[::1]:{port}'}
        self.origins = {f'http://{host}' for host in self.hosts}

    def allowed(self, environ):
        host = environ.get('HTTP_HOST', '').lower()
        origin = environ.get('HTTP_ORIGIN')
        fetch_site = environ.get('HTTP_SEC_FETCH_SITE', '')
        return host in self.hosts and (not origin or origin in self.origins) and fetch_site != 'cross-site'

    def __call__(self, environ, start_response):
        if not self.allowed(environ):
            start_response('403 Forbidden', [('Content-Type', 'text/plain; charset=utf-8'),
                                             ('Cache-Control', 'no-store')])
            return [b'Only local application requests are allowed']

        def secure_start(status, headers, exc_info=None):
            headers += [('X-Content-Type-Options', 'nosniff'), ('Referrer-Policy', 'no-referrer'),
                        ('X-Frame-Options', 'DENY'), ('Cache-Control', 'no-store')]
            return start_response(status, headers, exc_info)
        return self.application(environ, secure_start)


class LocalWebSocketServer(ServerAdapter):
    def run(self, application):
        server = pywsgi.WSGIServer((self.host, self.port), application,
                                  handler_class=WebSocketHandler, log=None)
        # gevent upgrades before calling WSGI middleware. Invalid requests must
        # take the normal HTTP path so the middleware returns 403 before upgrade.
        server.pre_start_hook = lambda handler: not application.allowed(handler.environ)
        server.serve_forever()


def safe_rpc(function):
    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except Exception as exc:
            logging.getLogger('karaoke').error('RPC %s failed (%s)', function.__name__, type(exc).__name__)
            # Returning an error envelope avoids Eel's automatic traceback disclosure.
            return {'error': '操作失敗，請確認輸入及網路狀態；詳細資訊請查看本機日誌。'}
    return wrapped


def redact_diagnostic(text):
    text = re.sub(r'https?://[^\s\'"<>]+', '[URL]', text)
    text = re.sub(r'(?i)\b[A-Z]:[\\/][^\r\n\'"<>]+', '[local path]', text)
    text = re.sub(r'(?i)\b(authorization|cookie|api[_-]?key|token|password)\s*[:=]\s*[^\s,;]+',
                  r'\1=[redacted]', text)
    return text


class RedactingFormatter(logging.Formatter):
    def format(self, record):
        return redact_diagnostic(super().format(record))
