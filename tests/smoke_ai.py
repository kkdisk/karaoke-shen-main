"""Explicit integration check: downloads model and separates 3 seconds of synthetic audio.

Run using the desktop Python. Output remains under tests/.smoke (ignored).
This checks the pipeline, not perceptual vocal-removal quality.
"""
import json
import math
import struct
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from separation import SeparationService, MODEL, WorkerProgress

folder = Path(__file__).resolve().parent / '.smoke'
folder.mkdir(exist_ok=True)
service = SeparationService(folder)
if not service.capabilities()['available']:
    raise RuntimeError(service.capabilities()['message'])
with wave.open(str(folder / 'input.wav'), 'wb') as wav:
    wav.setnchannels(2)
    wav.setsampwidth(2)
    wav.setframerate(44100)
    frames = bytearray()
    for n in range(3 * 44100):
        time = n / 44100
        center = 0.15 * math.sin(2 * math.pi * 440 * time)
        left = center + 0.1 * math.sin(2 * math.pi * 110 * time)
        right = center + 0.1 * math.sin(2 * math.pi * 165 * time)
        frames.extend(struct.pack('<hh', int(left * 32767), int(right * 32767)))
    wav.writeframes(frames)
separation_reports = []
service._run([service.python, str(Path(__file__).resolve().parents[1] / 'ai_worker.py'), '-n', MODEL, '--two-stems=vocals',
              '--device', 'cpu', '--shifts', '1', '-o', str(folder / 'stems'),
              str(folder / 'input.wav')], folder, 600,
             progress=WorkerProgress(lambda percent, detail: separation_reports.append((percent, detail)),
                                     models=4 if MODEL == 'htdemucs_ft' else 1))
assert any(percent == 100 for percent, detail in separation_reports), separation_reports
stem = folder / 'stems' / MODEL / 'input' / 'no_vocals.wav'
assert stem.stat().st_size > 0
service._run([service.ffmpeg, '-y', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=25',
              '-i', str(folder / 'input.wav'), '-t', '3', '-c:v', 'libx264', '-c:a', 'aac',
              str(folder / 'original.mp4')], folder, 60)
mux_reports = []
service._run([service.ffmpeg, '-y', '-nostdin', '-i', str(folder / 'original.mp4'), '-i', str(stem),
              '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac',
              '-movflags', '+faststart', '-shortest', '-progress', 'pipe:1', '-nostats',
              str(folder / 'karaoke.mp4')], folder, 60,
             progress=WorkerProgress(lambda percent, detail: mux_reports.append((percent, detail)), duration=3))
assert mux_reports, 'No real FFmpeg progress received'
with wave.open(str(stem), 'rb') as wav:
    assert wav.getnchannels() == 2
    assert abs(wav.getnframes() / wav.getframerate() - 3) < 0.1
print(json.dumps({'result': 'OK', 'model': MODEL, 'stereo': True,
                  'separation_progress_reports': len(separation_reports), 'mux_progress_reports': len(mux_reports),
                  'karaoke_bytes': (folder / 'karaoke.mp4').stat().st_size}))
