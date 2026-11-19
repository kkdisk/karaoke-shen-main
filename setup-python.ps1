# Shared by the APP and AI setup scripts. Dot-source this file.
$ErrorActionPreference = 'Stop'
$env:PIP_CACHE_DIR = Join-Path $PSScriptRoot '.tools/pip-cache'

function Assert-Python314([string]$Executable) {
    & $Executable -c "import sys, sysconfig; assert sys.version_info[:2] == (3, 14), 'Python 3.14 required'; assert sys.maxsize > 2**32, '64-bit Python required'; assert not sysconfig.get_config_var('Py_GIL_DISABLED'), 'Use standard Python, not free-threaded Python'"
    if ($LASTEXITCODE -ne 0) { throw "Need standard 64-bit Python 3.14: $Executable" }
}

function Get-Python314([string]$PythonPath) {
    if ($PythonPath) {
        Assert-Python314 $PythonPath
        return $PythonPath
    }
    # A project-local uv installation can coexist with the system Python.
    $localPython = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '.tools/python') -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'cpython-3.14.*-windows-x86_64-none' } |
        Sort-Object { [version]($_.Name -replace '^cpython-([\d.]+)-.*$', '$1') } -Descending |
        ForEach-Object { Join-Path $_.FullName 'python.exe' } |
        Select-Object -First 1
    if ($localPython) {
        Assert-Python314 $localPython
        return $localPython
    }
    if (Get-Command py -ErrorAction SilentlyContinue) {
        try {
            $foundPython = & py -3.14 -c 'import sys; print(sys.executable)' 2>$null
        } catch {
            $foundPython = $null
        }
        if ($LASTEXITCODE -eq 0 -and $foundPython) {
            Assert-Python314 $foundPython
            return $foundPython
        }
    }
    throw 'Install standard 64-bit Python 3.14, or pass -PythonPath with its python.exe path.'
}

function Initialize-Python314Environment([string]$Name, [string]$PythonPath, [bool]$Recreate) {
    $basePython = Get-Python314 $PythonPath
    $environmentPath = Join-Path $PSScriptRoot $Name
    $environmentPython = Join-Path $environmentPath 'Scripts/python.exe'
    if (Test-Path -LiteralPath $environmentPath) {
        if ($Recreate) {
            $backupPath = "$environmentPath.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')"
            Move-Item -LiteralPath $environmentPath -Destination $backupPath
            Write-Host "Previous environment saved at $backupPath"
        } else {
            if (-not (Test-Path -LiteralPath $environmentPython)) {
                throw "Incomplete environment $Name. Re-run with -Recreate to save and rebuild it."
            }
            try {
                Assert-Python314 $environmentPython
            } catch {
                throw "$($_.Exception.Message). Existing $Name is not Python 3.14; re-run with -Recreate to back up and rebuild it."
            }
            return $environmentPython
        }
    }
    & $basePython -m venv $environmentPath
    if ($LASTEXITCODE -ne 0) { throw "Failed to create $Name" }
    Assert-Python314 $environmentPython
    return $environmentPython
}
