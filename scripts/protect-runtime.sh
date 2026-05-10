#!/usr/bin/env sh
set -eu

runtime_path="${VERIFONE_SHRE_HOME:-${HOME}/.verifone-shre-cstoresku}"
mode="${1:-assert}"

mkdir -p "$runtime_path"
marker="$runtime_path/.runtime-protected"

if [ "$mode" = "allow-reset" ]; then
  if [ "${ALLOW_VERIFONE_RUNTIME_RESET:-}" != "I_UNDERSTAND_DELETE_LOCAL_DATA" ]; then
    echo "Runtime reset refused. Set ALLOW_VERIFONE_RUNTIME_RESET=I_UNDERSTAND_DELETE_LOCAL_DATA for support/admin reset." >&2
    exit 1
  fi
  echo "Runtime reset override accepted for $runtime_path"
  exit 0
fi

if [ ! -f "$marker" ] || [ "$mode" = "mark" ]; then
  {
    echo "protected=true"
    echo "createdAt=$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo "message=Installer updates must not delete this runtime directory. Use explicit support reset override only."
  } > "$marker"
fi

if [ ! -f "$marker" ]; then
  echo "Runtime protection marker missing at $marker" >&2
  exit 1
fi

echo "Runtime protected: $runtime_path"
