#!/usr/bin/env bash
#
# haze_encode.sh
# ---------------
# Re-encodes a video reproducing the traits observed in the "working" sample
# vs. the one that got recompressed by TikTok:
#
#   1. High internal frame multiplier (default 19x) while keeping the
#      container's declared display frame rate at your target FPS.
#   2. Hard CBR: maxrate == bitrate, no VBV buffer headroom.
#   3. No faststart -> moov atom left at the END of the file (matches the
#      working sample's mdat offset of 48 vs. 36599 in the recompressed one).
#   4. Custom encoder tag written into the video track metadata.
#
# NOTE: TikTok (and other platforms) don't publish their re-encode/skip
# logic, and it changes over time. This script reproduces the measurable
# differences between your two samples -- it is not a guaranteed bypass.
# Treat it as a starting point to test and iterate on, not a magic switch.
#
# Usage:
#   ./haze_encode.sh -i input.mp4 -o output.mp4 -w 1080 -h 1920 -f 60 \
#                     [-m 19] [-b 16M] [-t "My Method - example.com"]
#
# Options:
#   -i  input file                (required)
#   -o  output file                (required)
#   -w  output width               (required, e.g. 1080)
#   -h  output height              (required, e.g. 1920)
#   -f  target DISPLAY frame rate  (required, e.g. 60)
#   -m  internal frame multiplier  (default 19 - matches the sample ratio)
#   -b  target video bitrate       (default 16M)
#   -t  encoder tag string embedded in track metadata
#   -a  audio bitrate              (default 256k)
#
set -euo pipefail

MULT=19
BITRATE="16M"
AUDIO_BITRATE="256k"
TAG="Custom Method - example.com"

usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed -n '/^Usage:/,/^$/p'
  exit 1
}

while getopts "i:o:w:h:f:m:b:t:a:" opt; do
  case "$opt" in
    i) INPUT="$OPTARG" ;;
    o) OUTPUT="$OPTARG" ;;
    w) WIDTH="$OPTARG" ;;
    h) HEIGHT="$OPTARG" ;;
    f) FPS="$OPTARG" ;;
    m) MULT="$OPTARG" ;;
    b) BITRATE="$OPTARG" ;;
    t) TAG="$OPTARG" ;;
    a) AUDIO_BITRATE="$OPTARG" ;;
    *) usage ;;
  esac
done

: "${INPUT:?-i input file required}"
: "${OUTPUT:?-o output file required}"
: "${WIDTH:?-w width required}"
: "${HEIGHT:?-h height required}"
: "${FPS:?-f target display fps required}"

if [[ ! -f "$INPUT" ]]; then
  echo "Input file not found: $INPUT" >&2
  exit 1
fi

INTERNAL_FPS=$(( FPS * MULT ))

echo "== haze_encode =="
echo "Input:            $INPUT"
echo "Output:           $OUTPUT"
echo "Resolution:       ${WIDTH}x${HEIGHT}"
echo "Display FPS:      $FPS"
echo "Internal FPS:     $INTERNAL_FPS  (multiplier x$MULT)"
echo "Video bitrate:    $BITRATE (hard CBR, maxrate=bitrate)"
echo "Encoder tag:      $TAG"
echo "================="

# Step 1: build an intermediate stream at INTERNAL_FPS by duplicating frames
#         (fps filter with round=up performs frame-hold duplication, which
#         is what a straightforward "multiply the frame count" pass looks
#         like -- swap in minterpolate here if you want motion-interpolated
#         frames instead of hard duplicates).
# Step 2: encode straight to the internal fps with hard CBR / no VBV headroom,
#         embed the tag, and mux WITHOUT +faststart so moov stays at the end.

ffmpeg -y -i "$INPUT" \
  -vf "scale=${WIDTH}:${HEIGHT}:flags=lanczos,fps=${INTERNAL_FPS}:round=up" \
  -c:v libx264 -profile:v high -level 4.0 -pix_fmt yuv420p \
  -b:v "$BITRATE" -maxrate "$BITRATE" \
  -g $(( INTERNAL_FPS * 2 )) \
  -c:a aac -b:a "$AUDIO_BITRATE" -ar 48000 -ac 2 \
  -metadata:s:v:0 encoder="$TAG" \
  -metadata:s:v:0 handler_name="VideoHandler" \
  -metadata encoder="$TAG" \
  -movflags +use_metadata_tags \
  "$OUTPUT"

echo ""
echo "Done. Note the container will still report frame timing based on the"
echo "actual encoded frames -- verify with:"
echo "  ffprobe -v error -select_streams v:0 -show_entries stream=nb_frames,avg_frame_rate,r_frame_rate -of default=noprint_wrappers=1 \"$OUTPUT\""
