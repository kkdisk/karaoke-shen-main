$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath '.venv-ai\Scripts\python.exe')) {
    python -m venv .venv-ai
    if ($LASTEXITCODE -ne 0) { throw '需要 Python 3.10 或 3.11' }
}
& '.venv-ai\Scripts\python.exe' -m pip install --upgrade pip setuptools
if ($LASTEXITCODE -ne 0) { throw 'pip 更新失敗' }
& '.venv-ai\Scripts\python.exe' -m pip install torch==2.10.0 torchaudio==2.10.0 --index-url https://download.pytorch.org/whl/cpu
if ($LASTEXITCODE -ne 0) { throw 'CPU 版 PyTorch 安裝失敗' }
& '.venv-ai\Scripts\python.exe' -m pip install -r requirements-ai.txt
if ($LASTEXITCODE -ne 0) { throw 'AI 環境安裝失敗' }
Write-Output 'AI 環境已就緒。重新啟動 APP 後可製作 AI 伴奏。'
