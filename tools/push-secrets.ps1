# Pushes every secret from .dev.vars to the deployed Worker.
#   powershell -ExecutionPolicy Bypass -File ./tools/push-secrets.ps1 [-Worker zarlino-songwriting-studio]
#
# Values are piped straight from the file to wrangler and never printed.

param(
    [string]$Worker = "zarlino-songwriting-studio",
    [string]$DevVars = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $DevVars) { $DevVars = Join-Path $root ".dev.vars" }

if (-not (Test-Path $DevVars)) {
    throw "missing $DevVars - copy .dev.vars.example and fill it in first"
}

$wrangler = Join-Path $root "node_modules\.bin\wrangler.cmd"
if (-not (Test-Path $wrangler)) { throw "wrangler not installed - run npm install first" }

$env:CI = "1"
$names = @()
foreach ($line in Get-Content $DevVars) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#")) { continue }
    $index = $trimmed.IndexOf("=")
    if ($index -lt 1) { continue }
    $name = $trimmed.Substring(0, $index).Trim()
    $value = $trimmed.Substring($index + 1).Trim()
    if (-not $value) {
        Write-Host "skipping $name (empty)" -ForegroundColor DarkGray
        continue
    }
    Write-Host "setting $name" -ForegroundColor Cyan
    $value | & $wrangler secret put $name --name $Worker | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "failed to set $name" }
    $names += $name
}

Write-Host ""
Write-Host ("secrets set on {0}: {1}" -f $Worker, ($names -join ", ")) -ForegroundColor Green

Push-Location $root
try {
    & $wrangler secret list --name $Worker
} finally {
    Pop-Location
}
