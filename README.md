# ia2audio — Internet Archive to Audiobook

Internet Archive → OCR (OpenAI Vision) → Markdown → TXT/EPUB → Edge TTS → M4B.

Features:
- Automates IA BookReader capture with Playwright (login/borrow flow, 2-up theater view).
- OCR via OpenAI Vision (gpt-4o) with concurrency/backoff to `content.json`.
- Exports clean Markdown and unwrapped TXT (no mid-sentence pauses in TTS).
- Synthesizes audiobook with Microsoft Edge TTS (via `aedocw/epub2tts-edge`), cover embed.
- Resume-safe: `SKIP_IA=1` to reuse captured pages/OCR and just regenerate text/audio.

Important: Respect the Internet Archive’s Terms of Service. Borrow books legitimately and do not bypass protections.

## Prerequisites

- Node.js >= 18 and pnpm
- Python 3.12+ with `venv`
- ffmpeg, pandoc, jq
- Playwright Chromium (`pnpm playwright:install`)
- OpenAI API key (for OCR)

macOS (Homebrew):
```
brew install ffmpeg pandoc jq python
```

Linux (apt-based):
```
sudo apt-get update && sudo apt-get install -y ffmpeg pandoc jq python3-venv
```

## Quickstart

1) Install dependencies:
```
pnpm install
pnpm playwright:install
```

2) Copy `.env.example` to `.env` and set variables:
- `IA_EMAIL`, `IA_PASSWORD` (IA account credentials)
- `OPENAI_API_KEY`
- `IA_ID` or `IA_URL`

3) Run the full pipeline (capture → OCR → export → TTS):
```
IA_ID=<internet_archive_id> bin/ia2audio.sh
```

To resume from existing outputs and only rebuild TXT/EPUB/audio:
```
SKIP_IA=1 IA_ID=<internet_archive_id> bin/ia2audio.sh
```

Outputs are written under `out/<IA_ID>/`, including `book.md`, `book.txt`, `book.epub`, and `audio/<IA_ID>.m4b` (or `.m4a`).

## Environment Variables

- IA: `IA_ID`, `IA_URL`, `IA_EMAIL`, `IA_PASSWORD`
- Capture: `IA_START_PAGE` (default 1), `IA_RESUME` (0/1), `IA_MAX_PAGES`, `IA_PAGE_DELAY_MS`, `IA_TILE_STABLE_MS`, `IA_SPINNER_TIMEOUT_MS`, `IA_MAX_RETRIES`
- OCR: `OPENAI_API_KEY`, `OCR_CONCURRENCY`, `OCR_MAX_RETRIES`
- TTS: `VOICE` (default `en-US-AndrewNeural`), `EDGE_TTS_CONCURRENCY`, `EDGE_TTS_RETRIES`, `EDGE_TTS_BACKOFF`
- Orchestration: `SKIP_IA=1` to reuse captured pages/OCR

See `.env.example` for a starter template.

## How it Works

1. Capture (`src/extract-ia-book.ts`)
   - Logs in and tries multiple ‘Borrow’ variants.
   - Forces 2-up + theater view to capture full spreads (inner element, no chrome).
   - Waits for spinners to vanish, images to load, and a tile-stability window.
   - Single-spread advance with verification to avoid double-turns.
   - Change detection (tile signature + SHA1) prevents duplicate screenshots.

2. OCR (`src/transcribe-book-content.ts`)
   - Sends each page image to OpenAI Vision (gpt-4o) with concurrency/backoff.
   - Creates `content.json` sorted by capture index then page.

3. Export (`src/export-book-markdown.ts`)
   - Builds `metadata.json` if missing; exports clean Markdown.
   - Folds single newlines, preserves paragraph breaks across spreads.

4. TTS (`bin/ia2audio.sh`)
   - Converts Markdown → TXT with `--wrap=none` (prevents mid-sentence pauses).
   - Runs Edge TTS via `epub2tts-edge` in a local virtualenv.
   - Embeds a cover image derived from the first page.

## Install Edge TTS locally

The wrapper will bootstrap `epub2tts-edge` automatically:
```
scripts/install_edge_tts.sh
```
It clones `https://github.com/aedocw/epub2tts-edge` and installs it into `.venv`.

## Troubleshooting

- Stuck spinner or missing BookReader: increase `IA_SPINNER_TIMEOUT_MS`; ensure `view=theater&mode=2up`.
- Double page turns: the capture loop verifies a single advance and retries.
- Mid-sentence pauses: ensured TXT is unwrapped (pandoc `--wrap=none`).
- Resume at wrong page: set `IA_RESUME=0` and `IA_START_PAGE=1` (default) to override IA resume.

## License

Apache-2.0. See LICENSE.

