#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/fnm:$PATH"
if command -v fnm >/dev/null 2>&1; then eval "$(fnm env --shell bash)"; fi
exec python3 "$(dirname "${BASH_SOURCE[0]}")/skill_setup.py" "$@"
