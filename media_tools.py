"""Prefer system FFmpeg, with a packaged binary as the fallback."""
import shutil
import sys
from pathlib import Path


def ffmpeg_path():
    installed = shutil.which('ffmpeg')
    if installed:
        return installed
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        return None


def youtube_runtime_options():
    """Use the local portable runtime, otherwise yt-dlp's default Deno lookup."""
    base = Path(sys.executable).parent if getattr(sys, 'frozen', False) else Path(__file__).resolve().parent
    portable = base / '.tools' / 'deno.exe'
    if portable.is_file():
        return {'js_runtimes': {'deno': {'path': str(portable)}}}
    return {}
