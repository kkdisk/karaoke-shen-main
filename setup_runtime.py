"""Install portable official Deno on Windows; verify GitHub's asset SHA-256."""
import hashlib
import io
import json
import zipfile
import time
from pathlib import Path

import requests


def install(mirror=False):
    root = Path(__file__).resolve().parent / '.tools'
    root.mkdir(exist_ok=True)
    result = requests.get('https://api.github.com/repos/denoland/deno/releases/latest', timeout=30)
    result.raise_for_status()
    release = result.json()
    asset = next(item for item in release['assets'] if item['name'] == 'deno-x86_64-pc-windows-msvc.zip')
    digest = asset.get('digest') or ''
    if not digest.startswith('sha256:'):
        raise RuntimeError('Release does not provide a SHA-256 digest; install Deno manually')
    source = (f"https://dl.deno.land/release/{release['tag_name']}/{asset['name']}"
              if mirror else asset['browser_download_url'])
    print('Downloading', source, flush=True)
    data = bytearray()
    started = time.monotonic()
    with requests.get(source, stream=True, timeout=(15, 30)) as result:
        result.raise_for_status()
        for chunk in result.iter_content(1024 * 1024):
            data.extend(chunk)
            if len(data) > asset['size'] or time.monotonic() - started > 180:
                raise RuntimeError('Download exceeded expected size or time limit')
            print(f'{len(data) // 1024**2} MB / {asset["size"] // 1024**2} MB', flush=True)
    if hashlib.sha256(data).hexdigest() != digest.split(':', 1)[1]:
        raise RuntimeError('Deno archive checksum mismatch')
    # Extract exactly one known member, never arbitrary archive paths.
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        (root / 'deno.exe').write_bytes(archive.read('deno.exe'))
    (root / 'runtime.json').write_text(json.dumps({'version': release['tag_name'], 'digest': digest}))
    print('Deno installed:', release['tag_name'])


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--mirror', action='store_true', help='Use official dl.deno.land mirror; GitHub digest still required')
    install(parser.parse_args().mirror)
