# Troubleshooting

BookReader not found
- Ensure the page is in `view=theater` and `/mode/2up`.
- Some IA items require borrowing before the reader appears; the capture script clicks Borrow in both the details page and inside the reader.

Login/borrow issues
- Increase delays (`IA_PAGE_DELAY_MS`, `IA_SPINNER_TIMEOUT_MS`). IA can be slow.
- If login flow changes, try again; the script tries multiple selectors.

Mid-sentence pauses in audio
- Ensure TXT generation uses `pandoc --wrap=none` (already used in `bin/ia2audio.sh`).
- As a fallback, the wrapper collapses single newlines to spaces while preserving blank-line paragraph breaks.

Starts at the wrong page
- Set `IA_RESUME=0` and `IA_START_PAGE=1` (default) to override IA’s resume.

End-of-book looping
- If a final back-cover loop occurs, stop the run; the script attempts to detect “no visual change after retries” and exits early.

Edge TTS fails to produce audio
- Check Python, ffmpeg, and that `epub2tts-edge` installed successfully.
- Try `EDGE_TTS_CONCURRENCY=2` on slow networks.
- Use `USE_SAY=1` on macOS for fallback via `say`.

