# -*- mode: python ; coding: utf-8 -*-


from PyInstaller.utils.hooks import collect_all
ffmpeg_datas, ffmpeg_binaries, ffmpeg_imports = collect_all('imageio_ffmpeg')
ejs_datas, ejs_binaries, ejs_imports = collect_all('yt_dlp_ejs')

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=ffmpeg_binaries + ejs_binaries,
    datas=[('web', 'web'), ('ai_worker.py', '.')] + ffmpeg_datas + ejs_datas,
    hiddenimports=ffmpeg_imports + ejs_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='karaoke-shen',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
