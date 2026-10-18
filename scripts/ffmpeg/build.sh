#!/usr/bin/env bash
# Builds the trimmed ffmpeg + ffprobe that Spitifo ships.
#
#   scripts/ffmpeg/build.sh win64          -> out/win64/{ffmpeg,ffprobe}.exe
#   scripts/ffmpeg/build.sh android-arm64  -> out/android-arm64/{ffmpeg,ffprobe}
#   scripts/ffmpeg/build.sh linux-x64      -> same component list on the host, so CI
#                                             can run smoke.sh against what Android gets
#
# Why this exists: a stock ffmpeg is ~150 MB of mostly video codecs, and
# Spitifo only ever (1) converts audio to mp3/m4a, (2) pulls the audio stream
# out of a download, and (3) merges a video and an audio stream without
# re-encoding. `--disable-everything` plus an explicit allow-list keeps just
# that. The result is statically linked: two small executables, no DLLs.
#
# Needs a Linux host. Windows is cross-compiled with mingw-w64; Android with
# the NDK (ANDROID_NDK_HOME, or the pinned NDK is downloaded). Every download
# is checked against a pinned SHA-256. The output folder also gets BUILDINFO.txt
# (versions, sources, configure line) and the license texts, so anyone can
# rebuild the exact binaries: that is what the LGPL asks of us.
set -euo pipefail

TARGET="${1:?usage: build.sh win64|android-arm64|linux-x64}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="${FFMPEG_WORK:-$HOME/.cache/spitifo-ffmpeg}"
OUT="${FFMPEG_OUT:-$ROOT/out}/$TARGET"
JOBS="${JOBS:-$(nproc)}"

# ---- pins (bump the version and its hash together) -------------------------
FFMPEG_VERSION="9.0.2"
FFMPEG_SHA256="8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e"
FFMPEG_URL="https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
LAME_VERSION="3.100"
LAME_SHA256="ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e"
LAME_URL="https://sourceforge.net/projects/lame/files/lame/$LAME_VERSION/lame-$LAME_VERSION.tar.gz/download"
NDK_VERSION="r27c"
NDK_SHA256="${NDK_SHA256_PIN:-}"
NDK_URL="https://dl.google.com/android/repository/android-ndk-$NDK_VERSION-linux.zip"
ANDROID_API="${ANDROID_API:-30}"   # keep in step with minSdk in android/app/build.gradle.kts

# ---- what Spitifo needs from ffmpeg -----------------------------------------
# Inputs: what the sources serve (mp3, flac, ogg, m4a, wav, opus, webm, mp4).
DEMUXERS="mov,matroska,ogg,mp3,flac,wav,aac"
# Outputs: mp3, m4a (ipod), mp4 merge, opus/ogg extraction, mkv/webm fallback.
MUXERS="mp4,ipod,mov,mp3,ogg,opus,wav,matroska,webm,adts,null"
# Audio decoders for converting. Video is only ever stream-copied, with one
# catch found by smoke.sh: the mp4 muxer needs the pixel format to write a VP9
# stream (the `vpcC` box), and ffmpeg only learns it by decoding a frame. So
# the VP9 decoder stays in (a few hundred KB); H.264 needs nothing of the sort.
DECODERS="aac,aac_latm,mp3,mp3float,flac,vorbis,opus,alac,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_u8,vp9"
ENCODERS="libmp3lame,aac,pcm_s16le"
# Parsers and bitstream filters are what make `-c copy` work for video.
PARSERS="aac,aac_latm,mpegaudio,flac,vorbis,opus,h264,hevc,vp8,vp9,av1"
BSFS="aac_adtstoasc,vp9_superframe,vp9_superframe_split,h264_mp4toannexb,hevc_mp4toannexb,extract_extradata,av1_frame_merge,null"
PROTOCOLS="file,pipe"
FILTERS="aresample,aformat,anull,abuffer,abuffersink,null,buffer,buffersink,format"

log() { printf '\n==> %s\n' "$*"; }

fetch() { # url sha256 dest
  local url="$1" sha="$2" dest="$3"
  if [ ! -f "$dest" ]; then curl -fsSL --retry 3 -o "$dest.part" "$url" && mv "$dest.part" "$dest"; fi
  if [ -n "$sha" ]; then
    echo "$sha  $dest" | sha256sum -c - >/dev/null || { echo "checksum mismatch: $dest" >&2; rm -f "$dest"; exit 1; }
  else
    echo "warning: no pinned checksum for $dest: $(sha256sum "$dest" | cut -d' ' -f1)" >&2
  fi
}

mkdir -p "$WORK/src" "$OUT"
cd "$WORK"

log "sources"
fetch "$FFMPEG_URL" "$FFMPEG_SHA256" "src/ffmpeg-$FFMPEG_VERSION.tar.xz"
fetch "$LAME_URL" "$LAME_SHA256" "src/lame-$LAME_VERSION.tar.gz"

BUILD="$WORK/build-$TARGET"
DEPS="$BUILD/deps"
rm -rf "$BUILD"; mkdir -p "$BUILD" "$DEPS"
tar -xf "src/ffmpeg-$FFMPEG_VERSION.tar.xz" -C "$BUILD"
tar -xf "src/lame-$LAME_VERSION.tar.gz" -C "$BUILD"

# ---- toolchain per target ----------------------------------------------------
case "$TARGET" in
  win64)
    HOST="x86_64-w64-mingw32"
    LAME_CONF=(--host="$HOST")
    FF_TARGET=(--target-os=mingw32 --arch=x86_64 --enable-cross-compile
               --cross-prefix="$HOST-" --disable-pthreads --enable-w32threads
               --extra-ldflags="-static -static-libgcc")
    STRIP="$HOST-strip"
    EXE=".exe"
    ;;
  android-arm64)
    if [ -z "${ANDROID_NDK_HOME:-}" ]; then
      fetch "$NDK_URL" "$NDK_SHA256" "src/android-ndk-$NDK_VERSION-linux.zip"
      [ -d "$WORK/ndk/android-ndk-$NDK_VERSION" ] || { mkdir -p "$WORK/ndk"; unzip -q "src/android-ndk-$NDK_VERSION-linux.zip" -d "$WORK/ndk"; }
      ANDROID_NDK_HOME="$WORK/ndk/android-ndk-$NDK_VERSION"
    fi
    TC="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
    CC="$TC/aarch64-linux-android$ANDROID_API-clang"
    LAME_CONF=(--host=aarch64-linux-android CC="$CC" AR="$TC/llvm-ar" RANLIB="$TC/llvm-ranlib" STRIP="$TC/llvm-strip" --with-pic)
    FF_TARGET=(--target-os=android --arch=aarch64 --enable-cross-compile
               --cc="$CC" --ar="$TC/llvm-ar" --nm="$TC/llvm-nm" --ranlib="$TC/llvm-ranlib" --strip="$TC/llvm-strip"
               --enable-pic --extra-cflags="-fPIE" --extra-ldflags="-pie -Wl,-z,max-page-size=16384")
    STRIP="$TC/llvm-strip"
    EXE=""
    ;;
  linux-x64)
    LAME_CONF=()
    FF_TARGET=()
    STRIP="strip"
    EXE=""
    ;;
  *) echo "unknown target: $TARGET" >&2; exit 2 ;;
esac

# ---- LAME (the mp3 encoder; LGPL) ----------------------------------------------
log "lame $LAME_VERSION ($TARGET)"
( cd "$BUILD/lame-$LAME_VERSION"
  ./configure --prefix="$DEPS" "${LAME_CONF[@]}" --disable-shared --enable-static \
    --disable-frontend --disable-decoder --disable-gtktest >"$BUILD/lame.log" 2>&1
  make -j"$JOBS" >>"$BUILD/lame.log" 2>&1 && make install >>"$BUILD/lame.log" 2>&1 )   || { tail -40 "$BUILD/lame.log"; exit 1; }

# ---- ffmpeg ----------------------------------------------------------------------
log "ffmpeg $FFMPEG_VERSION ($TARGET)"
CONFIGURE=(
  --prefix="$BUILD/ffinstall"
  --disable-everything --disable-autodetect --disable-doc --disable-debug
  --disable-network --disable-ffplay --disable-swscale
  --enable-ffmpeg --enable-ffprobe --enable-small
  --enable-libmp3lame
  --enable-demuxer="$DEMUXERS" --enable-muxer="$MUXERS"
  --enable-decoder="$DECODERS" --enable-encoder="$ENCODERS"
  --enable-parser="$PARSERS" --enable-bsf="$BSFS"
  --enable-protocol="$PROTOCOLS" --enable-filter="$FILTERS"
  --extra-cflags="-I$DEPS/include" --extra-ldflags="-L$DEPS/lib"
  "${FF_TARGET[@]}"
)
( cd "$BUILD/ffmpeg-$FFMPEG_VERSION"
  ./configure "${CONFIGURE[@]}" >"$BUILD/configure.log" 2>&1 || { tail -40 "$BUILD/configure.log"; exit 1; }
  make -j"$JOBS" "ffmpeg$EXE" "ffprobe$EXE" >"$BUILD/make.log" 2>&1 || { tail -40 "$BUILD/make.log"; exit 1; } )

# ---- package ---------------------------------------------------------------------
log "package -> $OUT"
rm -rf "$OUT"; mkdir -p "$OUT"
for b in ffmpeg ffprobe; do
  cp "$BUILD/ffmpeg-$FFMPEG_VERSION/$b$EXE" "$OUT/$b$EXE"
  "$STRIP" --strip-unneeded "$OUT/$b$EXE"
done
cp "$BUILD/ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv2.1" "$BUILD/ffmpeg-$FFMPEG_VERSION/LICENSE.md" "$OUT/"
cp "$BUILD/lame-$LAME_VERSION/COPYING" "$OUT/COPYING.lame"
{
  echo "Spitifo trimmed ffmpeg ($TARGET)"
  echo "ffmpeg $FFMPEG_VERSION  $FFMPEG_URL  sha256 $FFMPEG_SHA256"
  echo "lame   $LAME_VERSION  $LAME_URL  sha256 $LAME_SHA256"
  echo "build script: scripts/ffmpeg/build.sh in https://github.com/asormar/spitifo"
  echo "configure: ./configure ${CONFIGURE[*]}"
  echo "LGPL v2.1: rebuild these binaries from the sources above with that script."
} >"$OUT/BUILDINFO.txt"
ls -la "$OUT"
