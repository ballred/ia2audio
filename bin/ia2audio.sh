#!/usr/bin/env bash
# ia2audio — Internet Archive → TXT (→ EPUB fallback) → TTS
# Platform: macOS/Linux. Requires Node >= 18, Playwright, ffmpeg, pandoc, Python 3.12+.

set -euo pipefail
IFS=$'\n\t'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
IA_DIR="$ROOT"
EDGE_DIR="${EDGE_DIR:-$ROOT/epub2tts-edge}"

# ==== ENV ====
SKIP_IA="${SKIP_IA:-0}"
IA_ID="${IA_ID:-}"
IA_URL="${IA_URL:-}"
VOICE="${VOICE:-en-US-AndrewNeural}"
MAC_VOICE="${MAC_VOICE:-Samantha}"
USE_SAY="${USE_SAY:-0}"

# Edge TTS stability
EDGE_TTS_CONCURRENCY="${EDGE_TTS_CONCURRENCY:-4}"
EDGE_TTS_RETRIES="${EDGE_TTS_RETRIES:-8}"
EDGE_TTS_BACKOFF="${EDGE_TTS_BACKOFF:-6}"

extract_id_from_url() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import urlparse
u = urlparse(sys.argv[1])
parts = [p for p in u.path.split('/') if p]
try:
  i = parts.index('details')
  print(parts[i+1])
except Exception:
  print("")
PY
}

if [ -z "$IA_ID" ] && [ -n "$IA_URL" ]; then
  IA_ID="$(extract_id_from_url "$IA_URL")"
fi

if [ -z "$IA_ID" ] && [ "$SKIP_IA" != "1" ]; then
  echo "Set IA_ID=... or IA_URL=..." >&2; exit 1
fi

need() { command -v "$1" >/dev/null 2>&1; }

ensure_node() {
  if ! need node; then echo "Node.js >= 18 required" >&2; exit 1; fi
  local maj; maj=$(node -v | sed -E 's/^v([0-9]+).*/\1/')
  if [ "${maj}" -lt 18 ]; then echo "Node.js >= 18 required; found $(node -v)" >&2; exit 1; fi
  if ! need pnpm; then if need corepack; then corepack enable && corepack prepare pnpm@latest --activate; else echo "Install pnpm (https://pnpm.io)" >&2; exit 1; fi; fi
}

install_edge_tts() {
  "$ROOT/scripts/install_edge_tts.sh"
}

run_ia_pipeline() {
  pushd "$IA_DIR" >/dev/null
    pnpm install
    npx playwright install chromium >/dev/null 2>&1 || true

    # Clean previous run artifacts to avoid duplicates
    OUT_DIR="$IA_DIR/out/$IA_ID"
    rm -rf "$OUT_DIR/pages" 2>/dev/null || true
    rm -f "$OUT_DIR/metadata.json" "$OUT_DIR/content.json" 2>/dev/null || true

    IA_ID="$IA_ID" IA_URL="$IA_URL" IA_EMAIL="$IA_EMAIL" IA_PASSWORD="$IA_PASSWORD" pnpm capture
    BOOK_ID="$IA_ID" pnpm ocr
    BOOK_ID="$IA_ID" pnpm export
  popd >/dev/null
}

prepare_text_and_epub() {
  local OUT_DIR="$IA_DIR/out/$IA_ID"
  [ -f "$OUT_DIR/book.md" ] || { echo "Missing $OUT_DIR/book.md" >&2; exit 1; }

  # Markdown → plain text (disable wrapping)
  set +e
  pandoc -f markdown -t plain --wrap=none "$OUT_DIR/book.md" -o "$OUT_DIR/book.txt"
  RC=$?
  set -e
  if [ $RC -ne 0 ]; then
    pandoc -f markdown -t plain "$OUT_DIR/book.md" -o "$OUT_DIR/book.txt"
    awk 'BEGIN{blank=1} { if ($0=="") { if (!blank) { printf("\n\n"); blank=1 } } else { gsub(/^\s+|\s+$/,"",$0); printf("%s%s", blank?"":" ", $0); blank=0 } } END{ if (!blank) printf("\n") }' "$OUT_DIR/book.txt" > "$OUT_DIR/.book.txt.tmp" && mv "$OUT_DIR/.book.txt.tmp" "$OUT_DIR/book.txt"
  fi

  if [ -f "$OUT_DIR/metadata.json" ]; then
    local TITLE AUTHOR
    TITLE=$(jq -r '.meta.title // empty' "$OUT_DIR/metadata.json" 2>/dev/null || echo "")
    AUTHOR=$(jq -r '(.meta.author // ((.meta.authorList // []) | join(", "))) // empty' "$OUT_DIR/metadata.json" 2>/dev/null || echo "")
    { [ -n "$TITLE" ] && echo "Title: $TITLE"; [ -n "$AUTHOR" ] && echo "Author: $AUTHOR"; echo; } > "$OUT_DIR/header.txt"
    cat "$OUT_DIR/header.txt" "$OUT_DIR/book.txt" > "$OUT_DIR/book_for_tts.txt"
  else
    cp "$OUT_DIR/book.txt" "$OUT_DIR/book_for_tts.txt"
  fi

  local TITLE_META AUTHOR_META
  TITLE_META="$(jq -r '.meta.title // "Untitled"' "$OUT_DIR/metadata.json" 2>/dev/null || echo "Untitled")"
  AUTHOR_META="$(jq -r '((.meta.author // ((.meta.authorList // []) | join(", "))) // "")' "$OUT_DIR/metadata.json" 2>/dev/null || echo "")"
  pandoc "$OUT_DIR/book.md" -o "$OUT_DIR/book.epub" --metadata=title:"$TITLE_META" ${AUTHOR_META:+--metadata=author:"$AUTHOR_META"} || true

  if [ -d "$OUT_DIR/pages" ]; then
    local FIRST_PNG
    FIRST_PNG=$(ls "$OUT_DIR/pages"/*.png 2>/dev/null | sort | head -n1 || true)
    if [ -n "$FIRST_PNG" ]; then
      ffmpeg -y -loglevel error -i "$FIRST_PNG" -vf scale='min(1400,iw)':-2 -q:v 2 "$OUT_DIR/cover.jpg" >/dev/null 2>&1 || true
    fi
  fi
}

synthesize_edge_tts_from_txt() {
  local OUT_DIR="$IA_DIR/out/$IA_ID"
  local TXT="$OUT_DIR/book_for_tts.txt"
  [ -f "$TXT" ] || return 1

  pushd "$OUT_DIR" >/dev/null
    source "$EDGE_DIR/.venv/bin/activate"
    set +e
    local COVER_OPT; COVER_OPT=""; [ -f "$OUT_DIR/cover.jpg" ] && COVER_OPT="--cover $OUT_DIR/cover.jpg"
    EDGE_TTS_CONCURRENCY="$EDGE_TTS_CONCURRENCY" EDGE_TTS_RETRIES="$EDGE_TTS_RETRIES" EDGE_TTS_BACKOFF="$EDGE_TTS_BACKOFF" \
      python "$EDGE_DIR/epub2tts_edge/epub2tts_edge.py" "$TXT" --speaker "$VOICE" $COVER_OPT
    local rc=$?
    set -e
    deactivate || true
  popd >/dev/null

  finalize_audio_output "$OUT_DIR" "$IA_ID" || return $rc
}

synthesize_edge_tts_from_epub() {
  local OUT_DIR="$IA_DIR/out/$IA_ID"
  local EPUB="$OUT_DIR/book.epub"
  [ -f "$EPUB" ] || return 1

  pushd "$OUT_DIR" >/dev/null
    source "$EDGE_DIR/.venv/bin/activate"
    set +e
    local COVER_OPT; COVER_OPT=""; [ -f "$OUT_DIR/cover.jpg" ] && COVER_OPT="--cover $OUT_DIR/cover.jpg"
    EDGE_TTS_CONCURRENCY="$EDGE_TTS_CONCURRENCY" EDGE_TTS_RETRIES="$EDGE_TTS_RETRIES" EDGE_TTS_BACKOFF="$EDGE_TTS_BACKOFF" \
      python "$EDGE_DIR/epub2tts_edge/epub2tts_edge.py" "$EPUB" --speaker "$VOICE" $COVER_OPT
    local rc=$?
    set -e
    deactivate || true
  popd >/dev/null

  finalize_audio_output "$OUT_DIR" "$IA_ID" || return $rc
}

finalize_audio_output() {
  local OUT_DIR="$1" DEST="$2"
  mkdir -p "$OUT_DIR/audio"
  echo "==> Stage: Finalize audio (validate/mux)"

  local have_m4b have_m4a
  have_m4b=$(ls -t "$OUT_DIR"/*.m4b 2>/dev/null | head -n1 || true)
  have_m4a=$(ls -t "$OUT_DIR"/*.m4a 2>/dev/null | head -n1 || true)

  if [ -n "$have_m4b" ]; then
    ffmpeg -v error -hide_banner -i "$have_m4b" -t 1 -f s16le - >/dev/null 2>&1 || have_m4b=""
  fi
  if [ -z "$have_m4b" ] && [ -n "$have_m4a" ]; then
    if [ -f "$OUT_DIR/FFMETADATAFILE" ]; then
      ffmpeg -y -i "$have_m4a" -i "$OUT_DIR/FFMETADATAFILE" -map_metadata 1 -codec aac -movflags +faststart "$OUT_DIR/rebuilt.m4b" >/dev/null 2>&1 || true
    else
      ffmpeg -y -i "$have_m4a" -codec aac -movflags +faststart "$OUT_DIR/rebuilt.m4b" >/dev/null 2>&1 || true
    fi
    [ -f "$OUT_DIR/rebuilt.m4b" ] && have_m4b="$OUT_DIR/rebuilt.m4b"
  fi

  local final_src ext
  if [ -n "$have_m4b" ]; then final_src="$have_m4b"; ext="m4b"; elif [ -n "$have_m4a" ]; then final_src="$have_m4a"; ext="m4a"; else return 1; fi
  mv -f "$final_src" "$OUT_DIR/audio/${DEST}.$ext"
  echo "==> Audiobook: $OUT_DIR/audio/${DEST}.$ext"

  if [ -f "$OUT_DIR/cover.jpg" ]; then
    echo "==> Embedding cover art"
    "$EDGE_DIR/.venv/bin/python" - "$OUT_DIR/audio/${DEST}.$ext" "$OUT_DIR/cover.jpg" <<'PY'
import sys
from mutagen.mp4 import MP4, MP4Cover
audio_path, cover_path = sys.argv[1], sys.argv[2]
mp4 = MP4(audio_path)
with open(cover_path, 'rb') as f:
    data = f.read()
mp4['covr'] = [MP4Cover(data)]
mp4.save()
print('Cover embedded via mutagen')
PY
  fi

  rm -f "$OUT_DIR"/part*.flac "$OUT_DIR"/pgraphs*.flac "$OUT_DIR"/sntnc*.mp3 2>/dev/null || true
  rm -f "$OUT_DIR"/filelist.txt "$OUT_DIR"/FFMETADATAFILE 2>/dev/null || true
  find "$OUT_DIR" -maxdepth 1 -type f \( -name '*.m4a' -o -name '*.m4b' \) -not -path "$OUT_DIR/audio/*" -delete 2>/dev/null || true
  return 0
}

fallback_mac_say() {
  local OUT_DIR="$IA_DIR/out/$IA_ID"
  local TXT="$OUT_DIR/book_for_tts.txt"
  [ -f "$TXT" ] || { echo "Missing text for fallback TTS." >&2; return 1; }
  mkdir -p "$OUT_DIR/audio"
  echo "Edge TTS failed or not available. Falling back to macOS 'say' ($MAC_VOICE)…"
  say -v "$MAC_VOICE" -o "$OUT_DIR/audio/${IA_ID}.aiff" -f "$TXT"
  ffmpeg -y -i "$OUT_DIR/audio/${IA_ID}.aiff" -c:a aac -b:a 128k "$OUT_DIR/audio/${IA_ID}.m4a" >/dev/null 2>&1
  rm -f "$OUT_DIR/audio/${IA_ID}.aiff"
  echo "==> Fallback audio: $OUT_DIR/audio/${IA_ID}.m4a"
}

echo "==> IA_ID=$IA_ID VOICE=$VOICE ROOT=$ROOT"
ensure_node

echo "==> Stage: Edge TTS setup"
install_edge_tts

if [ "$SKIP_IA" != "1" ]; then
  : "${IA_EMAIL:?Set IA_EMAIL=...}"
  : "${IA_PASSWORD:?Set IA_PASSWORD=...}"
  : "${OPENAI_API_KEY:?Set OPENAI_API_KEY=...}"
  echo "==> Stage: IA capture + OCR + Markdown"
  run_ia_pipeline
else
  echo "[INFO] SKIP_IA=1: skipping capture/OCR; using existing outputs"
  OUT_DIR_CHECK="$IA_DIR/out/$IA_ID"
  if [ ! -d "$OUT_DIR_CHECK" ]; then
    echo "[ERROR] SKIP_IA=1 but missing $OUT_DIR_CHECK" >&2
    exit 1
  fi
  pushd "$IA_DIR" >/dev/null
    pnpm install
    BOOK_ID="$IA_ID" pnpm export || true
  popd >/dev/null
fi

echo "==> Stage: Prepare text + EPUB"
prepare_text_and_epub

echo "==> Stage: TXT synthesis via Edge TTS (voice=$VOICE, conc=$EDGE_TTS_CONCURRENCY, retries=$EDGE_TTS_RETRIES, backoff=${EDGE_TTS_BACKOFF}s)"
if ! synthesize_edge_tts_from_txt; then
  OUT_DIR_CHECK="$IA_DIR/out/$IA_ID/audio"
  if ls "$OUT_DIR_CHECK/${IA_ID}."* >/dev/null 2>&1; then
    echo "[INFO] TXT synthesis reported failure but final audio exists; skipping EPUB fallback."
  else
    echo "[INFO] TXT→Edge TTS path didn’t produce audio; trying EPUB→Edge TTS…"
    echo "==> Stage: EPUB fallback synthesis via Edge TTS"
    if ! synthesize_edge_tts_from_epub; then
      if [ "$USE_SAY" = "1" ]; then
        fallback_mac_say || { echo "No audio produced." >&2; exit 1; }
      else
        echo "No audio produced. Re-run with USE_SAY=1 for macOS fallback, or check logs." >&2
        exit 1
      fi
    fi
  fi
fi

echo "==> Stage: Done"

