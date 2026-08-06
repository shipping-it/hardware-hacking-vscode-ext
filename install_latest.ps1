<#
.SYNOPSIS
    Build, package, and install the latest Hardware Hacker extension into VS Code.

.DESCRIPTION
    Runs the full local release path so you don't have to remember the steps:
        npm install (only if node_modules is missing)  ->
        npm run package (produces hardware-hacker-<version>.vsix)  ->
        code --install-extension <vsix> --force

    After it finishes, just reload / relaunch VS Code to pick up the new build.

.PARAMETER CodeCommand
    The VS Code CLI to install into. Defaults to "code"; use "code-insiders"
    for the Insiders build.

.PARAMETER SkipInstall
    Skip "npm install" even if node_modules is missing (faster if you know deps
    are already there).

.EXAMPLE
    .\install_latest.ps1

.EXAMPLE
    .\install_latest.ps1 -CodeCommand code-insiders
#>

[CmdletBinding()]
param(
    [string]$CodeCommand = "code",
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

# Run everything from the folder this script lives in (the project root).
Push-Location $PSScriptRoot
try {
    # --- Helper: run a native command and fail loudly on a non-zero exit -----
    function Invoke-Checked {
        param([Parameter(Mandatory)][string]$File, [string[]]$Arguments)
        Write-Host ">> $File $($Arguments -join ' ')" -ForegroundColor Cyan
        & $File @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "'$File $($Arguments -join ' ')' failed with exit code $LASTEXITCODE."
        }
    }

    # --- Preflight: make sure the tools we need are on PATH ------------------
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "npm was not found on PATH. Install Node.js (https://nodejs.org) and reopen the terminal."
    }
    if (-not (Get-Command $CodeCommand -ErrorAction SilentlyContinue)) {
        throw "'$CodeCommand' CLI was not found on PATH. In VS Code run " +
              "'Shell Command: Install ''code'' command in PATH', then reopen the terminal."
    }

    # --- Install dependencies only when needed ------------------------------
    if ($SkipInstall) {
        Write-Host "Skipping npm install (-SkipInstall)." -ForegroundColor DarkGray
    }
    elseif (-not (Test-Path (Join-Path $PSScriptRoot "node_modules"))) {
        Write-Host "node_modules missing - installing dependencies..." -ForegroundColor Yellow
        Invoke-Checked -File "npm" -Arguments @("install")
    }
    else {
        Write-Host "Dependencies already present - skipping npm install." -ForegroundColor DarkGray
    }

    # --- Package into a .vsix (vsce also rebuilds dist/ via vscode:prepublish)
    Invoke-Checked -File "npm" -Arguments @("run", "package")

    # --- Locate the .vsix we just built -------------------------------------
    # Prefer the exact name from package.json; fall back to the newest .vsix.
    $pkg = Get-Content (Join-Path $PSScriptRoot "package.json") -Raw | ConvertFrom-Json
    $expected = Join-Path $PSScriptRoot ("{0}-{1}.vsix" -f $pkg.name, $pkg.version)

    if (Test-Path $expected) {
        $vsix = Get-Item $expected
    }
    else {
        $vsix = Get-ChildItem -Path $PSScriptRoot -Filter "*.vsix" |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1
    }
    if (-not $vsix) {
        throw "No .vsix was produced by 'npm run package'. Check the output above."
    }

    # --- Install it (--force replaces any existing install of this extension)
    Invoke-Checked -File $CodeCommand -Arguments @("--install-extension", $vsix.FullName, "--force")

    Write-Host ""
    Write-Host "Installed $($vsix.Name) (v$($pkg.version))." -ForegroundColor Green
    Write-Host "Now relaunch VS Code (or run 'Developer: Reload Window') to load the new build." -ForegroundColor Green
}
finally {
    Pop-Location
}
