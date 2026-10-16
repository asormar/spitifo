# Builds the Windows installer: frontend, backend sidecar, ffmpeg, Tauri shell.
#
# Usage, from any directory:
#   powershell -ExecutionPolicy Bypass -File desktop\build.ps1 [-FfmpegDir C:\ffmpeg\bin] [-Dev]
#
# -Dev runs `tauri dev` instead of building the installer.
# Requirements: the repo's .venv with requirements.txt installed, Node, Rust
# (rustup, MSVC toolchain), Visual Studio C++ build tools and the Windows SDK.
param(
    [string]$FfmpegDir = $env:SPITIFO_FFMPEG_SOURCE,
    [switch]$Dev
)
$ErrorActionPreference = "Stop"

$desktop = $PSScriptRoot
$root = Split-Path $desktop -Parent
$python = Join-Path $root ".venv\Scripts\python.exe"

# Git for Windows ships a GNU `link` that shadows the MSVC linker.
$env:PATH = (@("$env:USERPROFILE\.cargo\bin") + ($env:PATH -split ";" |
    Where-Object { $_ -and $_ -notlike "*\Git\usr\bin*" -and $_ -notlike "*\Git\mingw64\bin*" })) -join ";"

function Step($name, [scriptblock]$block) {
    Write-Host "==> $name"
    & $block
    if ($LASTEXITCODE) { throw "$name failed (exit $LASTEXITCODE)" }
}

Step "frontend" { Push-Location "$root\frontend"; try { npm ci; npm run build } finally { Pop-Location } }

Step "backend sidecar" {
    & $python -m pip install --quiet pyinstaller
    & $python -m PyInstaller "$desktop\sidecar\spitifo-backend.spec" --noconfirm `
        --distpath "$desktop\sidecar\dist" --workpath "$desktop\sidecar\build"
}

Step "ffmpeg" {
    if (-not $FfmpegDir) {
        $found = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
        if (-not $found) { throw "ffmpeg not found: pass -FfmpegDir or put ffmpeg on PATH" }
        $FfmpegDir = Split-Path $found.Source -Parent
    }
    $target = Join-Path $desktop "ffmpeg"
    New-Item -ItemType Directory -Force $target | Out-Null
    foreach ($exe in "ffmpeg.exe", "ffprobe.exe") {
        Copy-Item (Join-Path $FfmpegDir $exe) $target -Force
    }
}

Step "tauri" {
    Push-Location $desktop
    try {
        npm ci
        if ($Dev) { npx tauri dev } else { npx tauri build }
    } finally { Pop-Location }
}

if (-not $Dev) {
    Get-ChildItem "$desktop\src-tauri\target\release\bundle\nsis\*.exe" |
        ForEach-Object { Write-Host "installer: $($_.FullName)" }
}
