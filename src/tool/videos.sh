#!/bin/sh
# videos.sh — re-render all poem videos from a project copy (default: this folder). Usage: sh tool/videos.sh [project-dir]
D=${1:-.}; P=$(cd "$(dirname "$0")/.." && pwd); cd "$D" || exit 1
one() { t=$(awk -v k=$1 '/^# /{i++; if(i==k+1){sub(/^# /,""); sub(/ \|.*/,""); gsub(/ · /,"_"); print; exit}}' "$P/poems.txt")
  echo "== $1 $t $2"; arch -arm64 node --experimental-websocket tool/video.js --file "$P/poems.txt" --only $1 --style $2 --band full --port 8791 \
    --out "$P/out/video_${t}$([ $2 = song ] && echo _song).mp4" 2>&1 | grep -E "wrote|rror|timed out" | tail -2; }
for k in 0 1 2 3 4 10 11 12; do one $k tang; done      # Tang poems
for k in 5 6 7 8 9; do one $k song; done                # Song ci
arch -arm64 node --experimental-websocket tool/video.js --poem 2 --band full --port 8791 --out "$P/out/芙蓉樓送辛漸.mp4" 2>&1 | grep -E "wrote|rror" | tail -1
rm -rf tool/.chrome-video
