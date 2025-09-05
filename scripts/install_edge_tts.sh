#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
EDGE_DIR="${EDGE_DIR:-$ROOT/epub2tts-edge}"
PYENV_PY="${PYENV_PY:-3.12.6}"

mkdir -p "$EDGE_DIR"
if [ ! -d "$EDGE_DIR/.git" ]; then
  echo "==> Cloning aedocw/epub2tts-edge into $EDGE_DIR"
  git clone "https://github.com/aedocw/epub2tts-edge.git" "$EDGE_DIR" || true
else
  echo "==> Updating epub2tts-edge"
  git -C "$EDGE_DIR" pull --ff-only || true
fi

select_python() {
  local sys_py="python3"
  if command -v "$sys_py" >/dev/null 2>&1; then echo "$sys_py"; return 0; fi
  if command -v pyenv >/dev/null 2>&1; then
    pyenv install -s "$PYENV_PY"
    local root
    root="$(pyenv root)"
    local cand="$root/versions/$PYENV_PY/bin/python"
    if [ -x "$cand" ]; then echo "$cand"; return 0; fi
  fi
  echo "$sys_py"
}

pushd "$EDGE_DIR" >/dev/null
  PYBIN="$(select_python)"
  echo "[INFO] Using Python for epub2tts-edge venv: $($PYBIN --version 2>&1)"
  "$PYBIN" -m venv .venv
  source .venv/bin/activate
  pip install --upgrade pip
  pip install .
  edge-tts --help >/dev/null 2>&1 || true
  deactivate
popd >/dev/null

echo "==> epub2tts-edge ready at $EDGE_DIR"

