$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$appPython = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $appPython)) {
    throw '請先依 README.md 建立 .venv 並安裝 requirements.txt'
}
Set-Location -LiteralPath $projectRoot
& $appPython -X utf8 (Join-Path $projectRoot 'main.py')
