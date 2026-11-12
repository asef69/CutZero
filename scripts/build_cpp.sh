#!/usr/bin/env bash
# Thin wrapper so `bash scripts/build_cpp.sh` works from any directory.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
uv run --project "$ROOT/backend" python "$ROOT/scripts/build_cpp.py" "$@"
