# Builds the Windows installer: frontend, backend sidecar, ffmpeg, Tauri shell.
#
# Usage, from any directory:
#   powershell -ExecutionPolicy Bypass -File desktop\build.ps1 [-FfmpegDir C:\ffmpeg\bin] [-Python C:\python.exe] [-Dev]
#
# -Dev runs `tauri dev` instead of building the installer.
# -FfmpegDir must hold a *shared* ffmpeg build (ffmpeg.exe, ffprobe.exe and
# their DLLs); without it the script downloads one.
# -Python overrides the interpreter used for the sidecar; it defaults to the
# repo's .venv (CI passes the setup-python one instead).
# Requirements: the repo's .venv with requirements.txt installed, Node, Rust
# (rustup, MSVC toolchain), Visual Studio C++ build tools and the Windows SDK.
param(
    [string]$FfmpegDir = $env:SPITIFO_FFMPEG_SOURCE,
    [string]$Python = "",
    [switch]$Dev
)
$ErrorActionPreference = "Stop"

$desktop = $PSScriptRoot
$root = Split-Path $desktop -Parent
if (-not $Python) { $Python = Join-Path $root ".venv\Scripts\python.exe" }
$python = $Python

# Git for Windows ships a GNU `link` that shadows the MSVC linker.
$env:PATH = (@("$env:USERPROFILE\.cargo\bin") + ($env:PATH -split ";" |
    Where-Object { $_ -and $_ -notlike "*\Git\usr\bin*" -and $_ -notlike "*\Git\mingw64\bin*" })) -join ";"

function Step($name, [scriptblock]$block) {
    Write-Host "==> $name"
    & $block
    if ($LASTEXITCODE) { throw "$name failed (exit $LASTEXITCODE)" }
}

# Downloads BtbN's LGPL shared ffmpeg build once into desktop\.cache, checks it
# against the release's checksums and returns its bin directory.
function Get-SharedFfmpeg {
    $name = "ffmpeg-n9.0-latest-win64-lgpl-shared-9.0"
    $base = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest"
    $cache = Join-Path $desktop ".cache"
    $bin = Join-Path $cache "$name\bin"
    if (Test-Path (Join-Path $bin "ffmpeg.exe")) { return $bin }

    New-Item -ItemType Directory -Force $cache | Out-Null
    $zip = Join-Path $cache "$name.zip"
    Invoke-WebRequest "$base/$name.zip" -OutFile $zip -UseBasicParsing
    # Saved to a file: GitHub serves it as octet-stream, so .Content is bytes.
    $sumsFile = Join-Path $cache "checksums.sha256"
    Invoke-WebRequest "$base/checksums.sha256" -OutFile $sumsFile -UseBasicParsing
    $expected = (Get-Content $sumsFile | Where-Object { $_ -match "\s$name\.zip$" }) -replace "\s.*$", ""
    Remove-Item $sumsFile
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash
    if (-not $expected -or $actual -ne $expected.ToUpper()) {
        Remove-Item $zip
        throw "ffmpeg checksum mismatch for $name.zip"
    }
    Expand-Archive $zip -DestinationPath $cache -Force
    Remove-Item $zip
    return $bin
}

Step "frontend" { Push-Location "$root\frontend"; try { npm ci; npm run build } finally { Pop-Location } }

Step "backend sidecar" {
    & $python -m pip install --quiet pyinstaller
    & $python -m PyInstaller "$desktop\sidecar\spitifo-backend.spec" --noconfirm `
        --distpath "$desktop\sidecar\dist" --workpath "$desktop\sidecar\build"
}

Step "ffmpeg" {
    if (-not $FfmpegDir) { $FfmpegDir = Get-SharedFfmpeg }
    # A shared build: ffmpeg.exe and ffprobe.exe are small and load the same
    # DLLs, so the libraries ship once instead of twice as in a static build.
    $target = Join-Path $desktop "ffmpeg"
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    New-Item -ItemType Directory $target | Out-Null
    foreach ($exe in "ffmpeg.exe", "ffprobe.exe") {
        Copy-Item (Join-Path $FfmpegDir $exe) $target
    }
    Copy-Item (Join-Path $FfmpegDir "*.dll") $target
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
