# Builds the Windows installer: frontend, backend sidecar, ffmpeg, QuickJS,
# Tauri shell.
#
# Usage, from any directory:
#   powershell -ExecutionPolicy Bypass -File desktop\build.ps1 [-FfmpegDir C:\ffmpeg\bin] [-Python C:\python.exe] [-Dev]
#
# -Dev runs `tauri dev` instead of building the installer.
# -FfmpegDir must hold Spitifo's trimmed ffmpeg (ffmpeg.exe, ffprobe.exe and the
# license texts, see scripts/ffmpeg/build.sh); without it the script downloads
# the release pinned in scripts/ffmpeg/release.properties.
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

# Downloads Spitifo's own audio-only ffmpeg (built by .github/workflows/ffmpeg.yml,
# about 4 MB per executable, statically linked) once into desktop\.cache, checks
# it against the hash pinned in scripts/ffmpeg/release.properties and returns the
# folder that holds it.
function Get-AudioFfmpeg {
    $pins = @{}
    Get-Content (Join-Path $root "scripts\ffmpeg\release.properties") |
        Where-Object { $_ -match "^\s*([\w.-]+)\s*=\s*(.*?)\s*$" } |
        ForEach-Object { $pins[$Matches[1]] = $Matches[2] }
    $tag = $pins["tag"]
    $expected = $pins["win64.sha256"]
    if (-not $tag -or -not $expected) {
        throw "scripts\ffmpeg\release.properties has no published ffmpeg yet: run the ffmpeg workflow with a tag and fill it in, or pass -FfmpegDir."
    }
    $cache = Join-Path $desktop ".cache"
    $dir = Join-Path $cache "ffmpeg-audio-$tag-win64"
    if (Test-Path (Join-Path $dir "ffmpeg.exe")) { return $dir }

    New-Item -ItemType Directory -Force $cache | Out-Null
    $zip = Join-Path $cache "ffmpeg-audio-win64.zip"
    Invoke-WebRequest "https://github.com/asormar/spitifo/releases/download/$tag/ffmpeg-audio-win64.zip" -OutFile $zip -UseBasicParsing
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash
    if ($actual -ne $expected.ToUpper()) {
        Remove-Item $zip
        throw "ffmpeg checksum mismatch for ffmpeg-audio-win64.zip: got $actual, expected $expected"
    }
    Expand-Archive $zip -DestinationPath $dir -Force
    Remove-Item $zip
    return $dir
}

# Downloads QuickJS-ng once into desktop\.cache, checks it against the hash
# pinned below and returns the cached binary. yt-dlp runs it to solve YouTube's
# challenges; the backend learns its path from SPITIFO_QJS.
function Get-QuickJs {
    $version = "0.17.0"
    $name = "qjs-windows-x86_64.exe"
    # The release publishes no checksums file, so these hashes are the only
    # thing standing between the installer and a tampered or truncated asset.
    $sha256 = "2AEABF0092C3262D6B2609824418F7DD7ED1F1DF939F73B2B15645230CAC0D77"
    $cache = Join-Path $desktop ".cache"
    $exe = Join-Path $cache $name
    if (-not (Test-Path $exe)) {
        New-Item -ItemType Directory -Force $cache | Out-Null
        $base = "https://github.com/quickjs-ng/quickjs/releases/download/v$version"
        Invoke-WebRequest "$base/$name" -OutFile $exe -UseBasicParsing
    }
    $actual = (Get-FileHash $exe -Algorithm SHA256).Hash
    if ($actual -ne $sha256) {
        Remove-Item $exe
        throw "QuickJS checksum mismatch for $name ($actual)"
    }
    return $exe
}

Step "frontend" { Push-Location "$root\frontend"; try { npm ci; npm run build } finally { Pop-Location } }

Step "backend sidecar" {
    & $python -m pip install --quiet pyinstaller
    & $python -m PyInstaller "$desktop\sidecar\spitifo-backend.spec" --noconfirm `
        --distpath "$desktop\sidecar\dist" --workpath "$desktop\sidecar\build"
}

Step "ffmpeg" {
    if (-not $FfmpegDir) { $FfmpegDir = Get-AudioFfmpeg }
    # Two static executables plus the license texts that the LGPL asks us to
    # ship with them (BUILDINFO.txt says how to rebuild the binaries).
    $target = Join-Path $desktop "ffmpeg"
    if (Test-Path $target) { Remove-Item $target -Recurse -Force }
    New-Item -ItemType Directory $target | Out-Null
    foreach ($file in "ffmpeg.exe", "ffprobe.exe") {
        Copy-Item (Join-Path $FfmpegDir $file) $target
    }
    foreach ($file in "COPYING.LGPLv2.1", "COPYING.lame", "LICENSE.md", "BUILDINFO.txt") {
        $src = Join-Path $FfmpegDir $file
        if (Test-Path $src) { Copy-Item $src $target }
    }
}

Step "quickjs" {
    $qjs = Get-QuickJs
    # A second resource dir, mapped into the bundle next to ffmpeg's. Unlike
    # desktop\ffmpeg (fully generated, so it is wiped), this one holds a tracked
    # file - the .gitignore that keeps qjs.exe out of the repository - so only
    # the binary itself is replaced.
    $target = Join-Path $desktop "qjs"
    New-Item -ItemType Directory -Force $target | Out-Null
    Copy-Item $qjs (Join-Path $target "qjs.exe") -Force
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
