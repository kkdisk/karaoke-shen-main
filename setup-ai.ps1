param(
    [string]$PythonPath,
    [switch]$Recreate,
    [ValidateSet('auto', 'cu128', 'cpu')]
    [string]$TorchBackend = 'auto'
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
. (Join-Path $PSScriptRoot 'setup-python.ps1')

# CUDA 12.8 wheels need an NVIDIA driver >= 570.65 (Windows) and a Volta (7.0) or newer GPU.
$MinDriver = [version]'570.65'
$MinComputeCapability = [version]'7.0'

function Get-TorchBackend {
    $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if (-not $smi) {
        Write-Output 'No NVIDIA GPU driver found (nvidia-smi); installing CPU PyTorch.'
        return 'cpu'
    }
    # Windows PowerShell 5.1 turns native stderr into a terminating error under 'Stop'.
    $ErrorActionPreference = 'Continue'
    $rows = $null
    foreach ($fields in 'name,driver_version,compute_cap', 'name,driver_version') {
        # Older drivers do not know compute_cap; the second query drops it.
        try { $rows = & $smi.Source "--query-gpu=$fields" --format=csv,noheader 2>$null } catch { $rows = $null }
        if ($LASTEXITCODE -eq 0 -and $rows) { break }
        $rows = $null
    }
    if (-not $rows) {
        Write-Output 'nvidia-smi could not list a GPU; installing CPU PyTorch.'
        return 'cpu'
    }
    foreach ($row in @($rows)) {
        $name, $driver, $capability = ($row -split ',') | ForEach-Object { $_.Trim() }
        $driverVersion = $null
        if (-not [version]::TryParse($driver, [ref]$driverVersion) -or $driverVersion -lt $MinDriver) {
            Write-Output "Found $name, but driver $driver is older than $MinDriver. Update the NVIDIA driver for GPU acceleration; installing CPU PyTorch."
            continue
        }
        $capabilityVersion = $null
        if ($capability -and [version]::TryParse($capability, [ref]$capabilityVersion) -and $capabilityVersion -lt $MinComputeCapability) {
            Write-Output "Found $name (compute capability $capability), which CUDA 12.8 PyTorch does not support; installing CPU PyTorch."
            continue
        }
        Write-Output "Found $name (driver $driver); installing CUDA 12.8 PyTorch."
        return 'cu128'
    }
    return 'cpu'
}

if ($TorchBackend -eq 'auto') {
    $detection = @(Get-TorchBackend)
    $detection | Select-Object -SkipLast 1 | Write-Output
    $TorchBackend = $detection[-1]
}

$aiPython = Initialize-Python314Environment '.venv-ai' $PythonPath $Recreate.IsPresent
& $aiPython -m pip install --upgrade pip setuptools wheel
if ($LASTEXITCODE -ne 0) { throw 'Failed to update pip' }
& $aiPython -m pip install --upgrade "torch==2.10.0+$TorchBackend" "torchaudio==2.10.0+$TorchBackend" --index-url "https://download.pytorch.org/whl/$TorchBackend"
if ($LASTEXITCODE -ne 0) { throw "Failed to install PyTorch ($TorchBackend)" }
& $aiPython -m pip install -r requirements-ai.txt
if ($LASTEXITCODE -ne 0) { throw 'Failed to install AI dependencies' }
& $aiPython -m pip check
if ($LASTEXITCODE -ne 0) { throw 'AI dependency check failed' }

if ($TorchBackend -eq 'cu128') {
    # Single quotes only inside the Python code: PowerShell 5.1 strips embedded double quotes from native arguments.
    & $aiPython -c "import torch; torch.ones(1, device='cuda').add_(1).item(); print('CUDA OK:', torch.cuda.get_device_name(0))"
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'CUDA PyTorch is installed but cannot use the GPU; the APP will fall back to CPU. Re-run with -TorchBackend cpu to save disk space.'
    }
}
Write-Output "AI Python 3.14 environment ready ($TorchBackend). Restart the APP to prepare accompaniment."
