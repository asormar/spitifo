#!/usr/bin/env bash
# Regenerates the tiny media samples that scripts/ffmpeg/smoke.sh feeds to the
# trimmed ffmpeg. Needs a FULL ffmpeg (libx264, libvpx, libopus, libvorbis...),
# e.g. the distro one. The outputs are committed, so this only has to run when
# a case is added.
set -euo pipefail
OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/tests/data/ffmpeg"
FF="${FFMPEG_FULL:-ffmpeg}"
mkdir -p "$OUT"
cd "$OUT"
rm -f ./*
common=(-hide_banner -loglevel error -y)
tone=(-f lavfi -i "sine=frequency=440:duration=1:sample_rate=22050")
"$FF" "${common[@]}" "${tone[@]}" -ac 1 tone.wav
"$FF" "${common[@]}" "${tone[@]}" -ac 1 -c:a flac tone.flac
"$FF" "${common[@]}" "${tone[@]}" -ac 1 -c:a libvorbis -q:a 2 tone.ogg
"$FF" "${common[@]}" "${tone[@]}" -ac 1 -c:a libopus -b:a 32k tone.opus
"$FF" "${common[@]}" "${tone[@]}" -ac 1 -c:a libmp3lame -q:a 6 tone.mp3
"$FF" "${common[@]}" "${tone[@]}" -ac 1 -c:a aac -b:a 48k tone.m4a
"$FF" "${common[@]}" "${tone[@]}" -ac 1 -c:a libopus -b:a 32k tone.webm
video=(-f lavfi -i "testsrc=duration=1:size=160x90:rate=10")
"$FF" "${common[@]}" "${video[@]}" -c:v libx264 -preset ultrafast -crf 40 -pix_fmt yuv420p video-h264.mp4
"$FF" "${common[@]}" "${video[@]}" -c:v libvpx-vp9 -b:v 50k -deadline realtime -cpu-used 8 video-vp9.webm
ls -la
