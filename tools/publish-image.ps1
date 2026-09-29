# Build the analysis container image and publish it to the Cloudflare registry.
#   powershell -ExecutionPolicy Bypass -File ./tools/publish-image.ps1 -Tag 0.4.0
#
# Works without Docker: the image is assembled in Python (base layers from Docker Hub
# + one layer with the wheels and app source) and pushed over HTTPS. Registry
# credentials are minted through the Cloudflare API using the local wrangler login.

param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [string]$Image = "zarlino-songwriting-analysis",
    [string]$Wheels = "",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$python = Join-Path $root "analysis\.venv\Scripts\python.exe"
if (-not (Test-Path $python)) { $python = Join-Path $root "analysis/.venv/bin/python" }
if (-not (Test-Path $python)) { throw "analysis venv missing - run 'npm run analysis:setup' first" }

$tool = Join-Path $PSScriptRoot "publish_container_image.py"
$arguments = @($tool, "--tag", $Tag, "--image", $Image)
if ($Wheels) { $arguments += @("--keep-wheels", $Wheels) }
if ($DryRun) { $arguments += "--dry-run" }

# Refreshing the wrangler session first keeps the API token valid for the registry call.
Push-Location $root
try {
    & "node_modules\.bin\wrangler.cmd" whoami *> $null
} catch {
    Write-Host "wrangler whoami failed - continuing with the existing credentials" -ForegroundColor DarkYellow
} finally {
    Pop-Location
}

& $python @arguments
exit $LASTEXITCODE
