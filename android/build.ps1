# Builds the Android APK: the React frontend, then the app (Chaquopy backend +
# WebView), then prints the APK path and size.
#
# Usage, from any directory:
#   powershell -ExecutionPolicy Bypass -File android\build.ps1 [-Debug]
#
# -Debug builds assembleDebug, which is signed with the shared debug keystore
# (no setup needed). Without -Debug, assembleRelease signs with
# android\keystore.properties and fails with instructions if that file is
# missing. Nothing here ever creates a keystore or a password.
#
# -FfmpegDir uses a local build of the trimmed ffmpeg (a folder holding `ffmpeg`
# and `ffprobe`, see scripts/ffmpeg/build.sh) instead of the release pinned in
# scripts/ffmpeg/release.properties.
#
# Requirements: JDK 17+, Android SDK platform 34 and build-tools 34.0.0
# (sdk.dir in android\local.properties), Python 3.12 for Chaquopy
# (spitifo.buildPython in android\local.properties, or SPITIFO_BUILD_PYTHON),
# and Node.
param(
    [switch]$Debug,
    [string]$FfmpegDir = $env:SPITIFO_FFMPEG_SOURCE
)

$ErrorActionPreference = "Stop"

$android = $PSScriptRoot
$root = Split-Path $android -Parent

function Step($name, [scriptblock]$block) {
    Write-Host "==> $name"
    & $block
    if ($LASTEXITCODE) { throw "$name failed (exit $LASTEXITCODE)" }
}

# The APK serves frontend/dist as an asset, and the Gradle build fails if it is
# missing, so this is not optional even for a quick rebuild.
Step "frontend" {
    Push-Location "$root\frontend"
    try { npm ci; npm run build } finally { Pop-Location }
}

Step "apk" {
    Push-Location $android
    try {
        $gradleArgs = @()
        if ($FfmpegDir) { $gradleArgs += "-PffmpegDir=$FfmpegDir" }
        if ($Debug) { .\gradlew.bat assembleDebug @gradleArgs } else { .\gradlew.bat assembleRelease @gradleArgs }
    } finally { Pop-Location }
}

if ($Debug) {
    $apk = Join-Path $android "app\build\outputs\apk\debug\app-debug.apk"
} else {
    $apk = Join-Path $android "app\build\outputs\apk\release\app-release.apk"
}

if (-not (Test-Path $apk)) { throw "APK not found at $apk" }
$info = Get-Item $apk
Write-Host ("apk: {0} ({1:N1} MB)" -f $info.FullName, ($info.Length / 1MB))
