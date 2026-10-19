#!/usr/bin/env bash
# Runs every ffmpeg/ffprobe operation Spitifo relies on against the trimmed
# build and fails on the first one that does not work. The command lines are
# the ones the app and yt-dlp use (backend/app/downloader.py ENCODERS, yt-dlp's
# FFmpegExtractAudio and Merger), so a component missing from the allow-list in
# build.sh shows up here, in CI, and not in somebody's download.
#
#   scripts/ffmpeg/smoke.sh path/to/ffmpeg[.exe] path/to/ffprobe[.exe]
#
# Works in Git Bash on Windows and on Linux. Inputs are the committed samples
# in tests/data/ffmpeg (scripts/ffmpeg/gen-fixtures.sh makes them).
set -uo pipefail

FF="$(cd "$(dirname "${1:?usage: smoke.sh ffmpeg ffprobe}")" && pwd)/$(basename "$1")"
FP="$(cd "$(dirname "${2:?usage: smoke.sh ffmpeg ffprobe}")" && pwd)/$(basename "$2")"
FIX="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../tests/data/ffmpeg" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp "$FIX"/* "$TMP"/
cd "$TMP"

fails=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; fails=$((fails + 1)); }

# run NAME OUTPUT EXPECTED_CODEC_OR_EMPTY ffmpeg-args...
# Runs ffmpeg, then ffprobe on OUTPUT: it must parse, and the first stream (or
# any stream if the output has several) must carry EXPECTED_CODEC.
run() {
  local name="$1" out="$2" codec="$3"; shift 3
  rm -f "$out"
  if ! "$FF" -hide_banner -loglevel error -y "$@" "$out" 2>"$TMP/err.txt"; then
    fail "$name (ffmpeg: $(head -c 200 "$TMP/err.txt" | tr '\n' ' '))"; return
  fi
  local streams
  if ! streams="$("$FP" -v error -show_entries stream=codec_name -of csv=p=0 "$out" 2>&1 | tr -d '\r')"; then
    fail "$name (ffprobe could not read the output)"; return
  fi
  if [ -n "$codec" ] && ! grep -qx "$codec" <<<"$streams"; then
    fail "$name (expected codec $codec, got: $(tr '\n' ' ' <<<"$streams"))"; return
  fi
  local dur
  dur="$("$FP" -v error -show_entries format=duration -of csv=p=0 "$out" | tr -d '\r')"
  awk -v d="$dur" 'BEGIN { exit !(d > 0.5 && d < 1.6) }' || { fail "$name (duration $dur)"; return; }
  pass "$name"
}

echo "convert to mp3 (downloader.py: libmp3lame -q:a 2)"
for src in tone.wav tone.flac tone.ogg tone.opus tone.mp3 tone.m4a tone.webm; do
  run "$src -> mp3" "out-${src//./_}.mp3" mp3 -i "$src" -vn -codec:a libmp3lame -q:a 2
done

echo "convert to m4a (downloader.py: aac 256k + faststart)"
for src in tone.wav tone.flac tone.ogg tone.opus tone.mp3 tone.m4a tone.webm; do
  run "$src -> m4a" "out-${src//./_}.m4a" aac -i "$src" -vn -codec:a aac -b:a 256k -movflags +faststart
done

echo "extract the audio stream untouched (yt-dlp 'original')"
run "webm opus -> .opus" out-copy.opus opus -i tone.webm -vn -acodec copy
run "m4a aac -> .m4a" out-copy.m4a aac -i tone.m4a -vn -acodec copy
run "ogg vorbis -> .ogg" out-copy.ogg vorbis -i tone.ogg -vn -acodec copy
run "mp3 -> .mp3" out-copy.mp3 mp3 -i tone.mp3 -vn -acodec copy

echo "merge video and audio without re-encoding (yt-dlp Merger)"
run "h264 + aac -> mp4" out-h264-aac.mp4 h264 -i video-h264.mp4 -i tone.m4a -c copy -map 0:v:0 -map 1:a:0 -movflags +faststart
run "vp9 + opus -> mp4" out-vp9-opus.mp4 vp9 -i video-vp9.webm -i tone.webm -c copy -map 0:v:0 -map 1:a:0 -movflags +faststart
run "vp9 + opus -> mkv" out-vp9-opus.mkv vp9 -i video-vp9.webm -i tone.webm -c copy -map 0:v:0 -map 1:a:0
run "vp9 + aac -> mp4" out-vp9-aac.mp4 vp9 -i video-vp9.webm -i tone.m4a -c copy -map 0:v:0 -map 1:a:0 -movflags +faststart
run "video only mp4 copy" out-video-only.mp4 h264 -i video-h264.mp4 -c copy -an

echo "ffprobe, the way yt-dlp calls it"
for f in tone.m4a tone.webm tone.opus video-h264.mp4 video-vp9.webm; do
  if "$FP" -hide_banner -show_streams -show_format -of json "$f" >/dev/null 2>&1; then pass "ffprobe $f"; else fail "ffprobe $f"; fi
done

echo "size"
ls -l "$FF" "$FP" | awk '{ printf "  %8.1f MB  %s\n", $5 / 1048576, $NF }'

if [ "$fails" -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
