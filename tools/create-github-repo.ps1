# Commits everything and pushes to a private GitHub repo.
#   powershell -ExecutionPolicy Bypass -File ./tools/create-github-repo.ps1 [-Name songwriting-studio] [-Owner zarlino-audio]
#
# Uses the GitHub REST API (there is no gh CLI on this machine). The token is read
# from the executive-os .dev.vars (or -Token / $env:GITHUB_TOKEN) and is never printed.

param(
    [string]$Owner = "zarlino-audio",
    [string]$Name = "songwriting-studio",
    [string]$Token = "",
    [string]$Message = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $Token) {
    if ($env:GITHUB_TOKEN) {
        $Token = $env:GITHUB_TOKEN
    } else {
        $candidates = @(
            "C:\Users\khrit\Desktop\zarlino-executive-os\.dev.vars",
            (Join-Path $root ".dev.vars")
        )
        foreach ($candidate in $candidates) {
            if (Test-Path $candidate) {
                $line = (Get-Content $candidate | Select-String '^GITHUB_TOKEN=' | Select-Object -First 1)
                if ($line) { $Token = ($line.Line -replace '^GITHUB_TOKEN=', '').Trim(); break }
            }
        }
    }
}
if (-not $Token) { throw "no GitHub token found (set GITHUB_TOKEN or pass -Token)" }

$headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent"           = "zarlino-songwriting-studio"
}

# --- repository -------------------------------------------------------------
$repoExists = $true
try {
    Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Name" -Headers $headers -Method Get | Out-Null
} catch {
    $repoExists = $false
}

if ($repoExists) {
    Write-Host "repository $Owner/$Name already exists" -ForegroundColor DarkGray
} else {
    Write-Host "creating private repository $Owner/$Name" -ForegroundColor Cyan
    $body = @{
        name        = $Name
        private     = $true
        description = "Cloudflare-native beat-to-songwriting studio (AI Songwriting Studio)"
    } | ConvertTo-Json
    Invoke-RestMethod -Uri "https://api.github.com/user/repos" -Headers $headers -Method Post -Body $body | Out-Null
    Write-Host "created" -ForegroundColor Green
}

# --- git --------------------------------------------------------------------
if (-not (Test-Path (Join-Path $root ".git"))) {
    git init -q
    git branch -M main
    Write-Host "initialised git repository" -ForegroundColor Cyan
}

if (-not (git config user.email)) { git config user.email "zarlino001@gmail.com" }
if (-not (git config user.name)) { git config user.name "Zarlino" }

git add -A
if (-not $Message) {
    $Message = "feat: AI Songwriting Studio - Cloudflare-native beat-to-songwriting MVP"
}
$staged = git diff --cached --name-only
if ($staged) {
    git commit -q -m $Message
    Write-Host "committed $(( $staged | Measure-Object ).Count) files" -ForegroundColor Cyan
} else {
    Write-Host "nothing new to commit" -ForegroundColor DarkGray
}

# --- push -------------------------------------------------------------------
$remote = git remote
if ($remote -notcontains "origin") {
    git remote add origin "https://x-access-token:$Token@github.com/$Owner/$Name.git"
} else {
    git remote set-url origin "https://x-access-token:$Token@github.com/$Owner/$Name.git"
}
git push -u origin main

# Keep the token out of .git/config once the push succeeded.
git remote set-url origin "https://github.com/$Owner/$Name.git"
Write-Host ""
Write-Host "pushed to https://github.com/$Owner/$Name (private)" -ForegroundColor Green
git log --oneline -n 3
