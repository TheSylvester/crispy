# bundle-runtime.ps1 — Assemble runtime/ directory with portable Node.js + crispy-code
#
# Usage: pwsh scripts/bundle-runtime.ps1
# Run from the tauri/ directory, or the script will cd there automatically.

$ErrorActionPreference = "Stop"

$NODE_VERSION = "22.16.0"

# Resolve paths relative to this script
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path "$ScriptDir\..\..").Path
$TauriDir = (Resolve-Path "$ScriptDir\..").Path
Set-Location $TauriDir

# Detect architecture
$Arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "x64" }

$NodeDist = "node-v$NODE_VERSION-win-$Arch"
$NodeUrl = "https://nodejs.org/dist/v$NODE_VERSION/$NodeDist.zip"

$RuntimeDir = "src-tauri\runtime"

# ---- Step 0: Sync version from root package.json ----
$RootVersion = (Get-Content "$RepoRoot\package.json" | ConvertFrom-Json).version

Write-Host "=== Crispy Runtime Bundler ===" -ForegroundColor Cyan
Write-Host "Platform: win-$Arch"
Write-Host "Node.js:  v$NODE_VERSION"
Write-Host "Version:  $RootVersion (from root package.json)"
Write-Host ""

# Patch Tauri configs to match root version (safety net)
# Uses regex replacement to preserve original JSON formatting
foreach ($ConfigFile in @("$TauriDir\package.json", "$TauriDir\src-tauri\tauri.conf.json")) {
    $content = Get-Content $ConfigFile -Raw
    $currentVersion = ($content | ConvertFrom-Json).version
    if ($currentVersion -ne $RootVersion) {
        Write-Host "    Patching $ConfigFile`: $currentVersion -> $RootVersion"
        $content = $content -replace """version"":\s*""[^""]+""", """version"": ""$RootVersion"""
        Set-Content -Path $ConfigFile -Value $content -NoNewline
    }
}

# Skip if runtime/ already exists, looks valid, AND version matches
if ((Test-Path "$RuntimeDir\node.exe") -and (Test-Path "$RuntimeDir\crispy\dist")) {
    $CachedVersion = try { (Get-Content "$RuntimeDir\crispy\package.json" | ConvertFrom-Json).version } catch { "" }
    if ($CachedVersion -eq $RootVersion) {
        Write-Host "runtime/ already exists at v$RootVersion - skipping. Delete src-tauri\runtime\ to rebuild."
        exit 0
    } else {
        Write-Host "runtime/ version mismatch ($CachedVersion -> $RootVersion), rebuilding..."
        Remove-Item -Recurse -Force $RuntimeDir
    }
}

# Clean previous partial builds
if (Test-Path $RuntimeDir) { Remove-Item -Recurse -Force $RuntimeDir }
New-Item -ItemType Directory -Path "$RuntimeDir\crispy" -Force | Out-Null

# ---- Step 1: Download portable Node.js ----
Write-Host ">>> Downloading Node.js v$NODE_VERSION for win-$Arch..." -ForegroundColor Yellow

$CacheDir = Join-Path $env:TEMP "crispy-bundle-cache"
New-Item -ItemType Directory -Path $CacheDir -Force | Out-Null
$NodeArchive = Join-Path $CacheDir "$NodeDist.zip"

if (-not (Test-Path $NodeArchive)) {
    Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeArchive -UseBasicParsing
} else {
    Write-Host "    (cached at $NodeArchive)"
}

Write-Host ">>> Extracting Node.js binary..."
$TempExtract = Join-Path $CacheDir "node-extract"
if (Test-Path $TempExtract) { Remove-Item -Recurse -Force $TempExtract }
Expand-Archive -Path $NodeArchive -DestinationPath $TempExtract -Force
Copy-Item "$TempExtract\$NodeDist\node.exe" "$RuntimeDir\node.exe"
Remove-Item -Recurse -Force $TempExtract

$NodeSize = (Get-Item "$RuntimeDir\node.exe").Length / 1MB
Write-Host "    Node.js binary: $([math]::Round($NodeSize, 1))MB"

# ---- Step 2: Copy crispy-code ----
Write-Host ">>> Copying crispy-code from local build..." -ForegroundColor Yellow

if (-not (Test-Path "$RepoRoot\dist")) {
    Write-Host "ERROR: $RepoRoot\dist not found. Run 'npm run build' in the repo root first." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path "$RepoRoot\dist\crispy-cli.js")) {
    Write-Host "ERROR: $RepoRoot\dist\crispy-cli.js not found. Run 'npm run build' in the repo root first." -ForegroundColor Red
    exit 1
}

Copy-Item -Recurse "$RepoRoot\dist" "$RuntimeDir\crispy\dist"
Copy-Item "$RepoRoot\package.json" "$RuntimeDir\crispy\"
if (Test-Path "$RepoRoot\package-lock.json") {
    Copy-Item "$RepoRoot\package-lock.json" "$RuntimeDir\crispy\"
}

# Fix line endings on scripts with shebangs.
# npm pack on Windows produces tarballs that inherit CRLF line endings,
# which breaks #!/usr/bin/env shebangs when extracted in WSL.
Write-Host ">>> Normalizing script line endings for WSL compatibility..."
$ShebangScripts = @(
    "$RuntimeDir\crispy\dist\crispy-dispatch.js",
    "$RuntimeDir\crispy\dist\crispy-cli.js",
    "$RuntimeDir\crispy\dist\recall.js",
    "$RuntimeDir\crispy\dist\crispy-agent.js",
    "$RuntimeDir\crispy\dist\crispy-plugin\scripts\crispy-session"
)
foreach ($f in $ShebangScripts) {
    if (Test-Path $f) {
        $content = [System.IO.File]::ReadAllText($f)
        $content = $content -replace "`r`n", "`n"
        [System.IO.File]::WriteAllText($f, $content)
    }
}

# ---- Step 3: Install production dependencies ----
Write-Host ">>> Installing production dependencies (this may take a moment)..." -ForegroundColor Yellow

Push-Location "$RuntimeDir\crispy"
npm install --omit=dev --omit=optional --ignore-scripts 2>&1 | Select-Object -Last 3
Pop-Location

# Safety net - remove optional deps if they slipped through
$OptionalDeps = @(
    "$RuntimeDir\crispy\node_modules\onnxruntime-node",
    "$RuntimeDir\crispy\node_modules\sharp",
    "$RuntimeDir\crispy\node_modules\@huggingface"
)
foreach ($dep in $OptionalDeps) {
    if (Test-Path $dep) { Remove-Item -Recurse -Force $dep }
}

# ---- Step 4: Create WSL install tarball ----
# npm pack creates a portable .tgz that can be installed in WSL via
# `npm install --prefix ~/.crispy <tarball>` — gets correct Linux native deps.
Write-Host ">>> Creating WSL install tarball..." -ForegroundColor Yellow

$PackDest = (Resolve-Path "$TauriDir\$RuntimeDir").Path
Push-Location "$RepoRoot"
# Use cmd /c to prevent PowerShell from treating npm's stderr warnings as errors.
# npm pack writes the tarball filename to stdout on its last line.
$TarballName = (cmd /c "npm pack --pack-destination `"$PackDest`" 2>nul" | Select-Object -Last 1)
if ($TarballName) { $TarballName = $TarballName.Trim() }
Pop-Location

if ($TarballName -and (Test-Path "$PackDest\$TarballName")) {
    Write-Host "    Tarball: $TarballName"
} else {
    Write-Host "    WARNING: Failed to create tarball (WSL auto-provision won't work)" -ForegroundColor Yellow
    Write-Host "    Tried: npm pack --pack-destination $PackDest"
}

# ---- Step 5: Report sizes ----
Write-Host ""
Write-Host "=== Bundle Summary ===" -ForegroundColor Cyan

function Get-DirSize($path) {
    $size = (Get-ChildItem -Recurse -File $path | Measure-Object -Property Length -Sum).Sum / 1MB
    return "$([math]::Round($size, 1))MB"
}

Write-Host "Node.js binary: $([math]::Round((Get-Item "$RuntimeDir\node.exe").Length / 1MB, 1))MB"
Write-Host "crispy dist/:   $(Get-DirSize "$RuntimeDir\crispy\dist")"
Write-Host "node_modules/:  $(Get-DirSize "$RuntimeDir\crispy\node_modules")"
Write-Host "Total runtime/: $(Get-DirSize $RuntimeDir)"
Write-Host ""

# Verify no voice/optional deps
$hasOptional = $false
foreach ($dep in $OptionalDeps) {
    if (Test-Path $dep) {
        Write-Host "WARNING: Optional dependency found: $dep" -ForegroundColor Red
        $hasOptional = $true
    }
}
if ($hasOptional) {
    Write-Host "WARNING: Optional dependencies found in bundle! They should be excluded." -ForegroundColor Red
    exit 1
}

Write-Host "=== Done ===" -ForegroundColor Green
