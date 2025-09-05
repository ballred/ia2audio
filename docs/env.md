# Environment Variables

Core
- IA_ID: Internet Archive identifier (preferred)
- IA_URL: IA details URL (optional; used to derive IA_ID)
- IA_EMAIL, IA_PASSWORD: IA account credentials used for login/borrow
- OPENAI_API_KEY: Used by OCR (OpenAI Vision)

Capture Controls
- IA_START_PAGE: 1-based start page (default 1)
- IA_RESUME: 1 to keep IA’s resume page, 0 to enforce IA_START_PAGE (default 0)
- IA_MAX_PAGES: 0 for full book, otherwise limit (per spread in 2-up)
- IA_PAGE_DELAY_MS: Additional delay after stability checks (default 1200)
- IA_TILE_STABLE_MS: Delay to consider tiles “stable” before screenshot (default 800)
- IA_SPINNER_TIMEOUT_MS: Max wait for spinner disappearance (default 45000)
- IA_MAX_RETRIES: Retries for verifying page turns (default 10)

OCR
- OCR_CONCURRENCY: Parallel OCR requests (default 6)
- OCR_MAX_RETRIES: Max retries per page (default 30)

TTS
- VOICE: Edge TTS voice (default en-US-AndrewNeural)
- EDGE_TTS_CONCURRENCY: Parallel TTS requests (default 4)
- EDGE_TTS_RETRIES: Max retries per sentence (default 8)
- EDGE_TTS_BACKOFF: Base seconds for linear backoff (default 6)

Orchestration
- SKIP_IA: 1 to reuse existing out/<IA_ID> (skip capture+OCR), still rebuilds Markdown/TXT/EPUB and runs TTS

