param(
    [string]$PythonPath,
    [switch]$Recreate
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
. (Join-Path $PSScriptRoot 'setup-python.ps1')
$appPython = Initialize-Python314Environment '.venv' $PythonPath $Recreate.IsPresent
& $appPython -m pip install --upgrade pip setuptools wheel
if ($LASTEXITCODE -ne 0) { throw 'Failed to update pip' }
& $appPython -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Failed to install APP dependencies' }
& $appPython -m pip check
if ($LASTEXITCODE -ne 0) { throw 'APP dependency check failed' }
Write-Output 'APP Python 3.14 environment ready. Run .\start.ps1'
