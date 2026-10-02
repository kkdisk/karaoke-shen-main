"""Validate actual Eel HTTP + WebSocket startup without opening a browser."""
import argparse
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

import requests
from websockets.sync.client import connect

parser = argparse.ArgumentParser()
parser.add_argument('--exe')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
command = ([str(Path(args.exe).resolve())] if args.exe else [sys.executable, '-X', 'utf8', str(root / 'main.py')])
command += ['--headless', '--port', str(port)]
process = subprocess.Popen(command, cwd=root, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
try:
    base = f'http://localhost:{port}'
    deadline = time.monotonic() + 45
    while True:
        if process.poll() is not None:
            raise RuntimeError(f'Application exited with {process.returncode}')
        try:
            page = requests.get(base + '/index.html', timeout=1)
            if page.status_code == 200:
                break
        except requests.RequestException:
            pass
        if time.monotonic() > deadline:
            raise RuntimeError('Server startup timed out')
        time.sleep(0.2)
    assert 'prepare-ai-btn' in page.text
    assert page.headers['Referrer-Policy'] == 'no-referrer'
    assert page.headers['X-Frame-Options'] == 'DENY'
    for headers in ({'Origin': 'https://attacker.example'}, {'Host': 'attacker.example'},
                    {'Sec-Fetch-Site': 'cross-site'}):
        assert requests.get(base + '/index.html', headers=headers, timeout=5).status_code == 403
    try:
        with connect(f'ws://localhost:{port}/eel?page=index.html',
                     origin='https://attacker.example', open_timeout=5):
            raise AssertionError('Cross-origin WebSocket was accepted')
    except Exception as exc:
        assert getattr(getattr(exc, 'response', None), 'status_code', None) == 403, exc
    assert requests.get(base + '/script.js', timeout=5).status_code == 200
    bridge = requests.get(base + '/eel.js', timeout=5)
    assert 'prepare_accompaniment' in bridge.text
    assert requests.get(base + '/proxy_stream?v=bad', timeout=5).status_code == 400
    with connect(f'ws://localhost:{port}/eel?page=index.html', open_timeout=10) as ws:
        ws.send(json.dumps({'call': 1, 'name': 'get_quality_info', 'args': []}))
        result = json.loads(ws.recv(timeout=40))
        assert result['status'] == 'ok', result
        assert result['value']['has_ffmpeg'], result
        assert result['value']['ai']['available'], result
        ws.send(json.dumps({'call': 2, 'name': 'get_stream_url', 'args': ['dQw4w9WgXcQ']}))
        result = json.loads(ws.recv(timeout=5))
        assert result['value'] == '/proxy_stream?v=dQw4w9WgXcQ'
        ws.send(json.dumps({'call': 3, 'name': 'get_stream_url', 'args': ['invalid']}))
        result = json.loads(ws.recv(timeout=5))
        assert result['status'] == 'ok' and 'error' in result['value'], result
        assert 'traceback' not in result, result
    print('Eel HTTP/WebSocket startup, FFmpeg and AI capability: OK')
finally:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
