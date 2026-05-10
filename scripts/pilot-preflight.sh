#!/usr/bin/env bash
set -euo pipefail

port="${PORT:-5480}"
runtime_path="${VERIFONE_SHRE_HOME:-$HOME/.verifone-shre-cstoresku}"
require_docker="${REQUIRE_DOCKER:-false}"
cstoresku_image="${CSTORESKU_LEGACY_IMAGE:-varifone-service:latest}"
checks=()
blockers=0
warnings=0

add_check() {
  local id="$1" ok="$2" severity="$3" message="$4"
  checks+=("{\"id\":\"$id\",\"ok\":$ok,\"severity\":\"$severity\",\"message\":\"$message\"}")
  if [[ "$ok" != "true" ]]; then
    if [[ "$severity" == "critical" ]]; then blockers=$((blockers + 1)); else warnings=$((warnings + 1)); fi
  fi
}

if command -v node >/dev/null 2>&1; then
  node_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
  [[ "$node_major" -ge 20 ]] && add_check node_version true critical "Node.js $node_major is installed." || add_check node_version false critical "Node.js 20+ is required."
else
  add_check node_available false critical "Node.js is missing."
fi

command -v npm >/dev/null 2>&1 && add_check npm_available true critical "npm is installed." || add_check npm_available false critical "npm is missing."

mkdir -p "$runtime_path"
[[ -w "$runtime_path" ]] && add_check runtime_writable true critical "Runtime path is writable: $runtime_path" || add_check runtime_writable false critical "Runtime path is not writable: $runtime_path"

if command -v df >/dev/null 2>&1; then
  free_kb="$(df -Pk "$runtime_path" | awk 'NR==2 {print $4}')"
  [[ "${free_kb:-0}" -ge 5242880 ]] && add_check disk_space true critical "Runtime filesystem has at least 5 GB free." || add_check disk_space false critical "Runtime filesystem needs at least 5 GB free."
fi

if command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  add_check port_available false warning "Port $port is already listening; confirm it is the dashboard service."
else
  add_check port_available true warning "Port $port appears available."
fi

if command -v docker >/dev/null 2>&1; then
  add_check docker_cli true critical "$(docker --version)"
  docker compose version >/dev/null 2>&1 && add_check docker_compose true critical "$(docker compose version)" || add_check docker_compose false critical "Docker Compose plugin is not available."
  if [[ "${REQUIRE_CSTORESKU_IMAGE:-false}" == "true" ]]; then
    docker image inspect "$cstoresku_image" >/dev/null 2>&1 && add_check cstoresku_image true critical "CStoreSKU image is available: $cstoresku_image" || add_check cstoresku_image false critical "CStoreSKU image is missing: $cstoresku_image"
  fi
else
  if [[ "$require_docker" == "true" ]]; then add_check docker_cli false critical "Docker is required for CStoreSKU sidecar mode."; else add_check docker_cli false warning "Docker is not installed; sidecar mode will be unavailable."; fi
fi

printf '{"ok":%s,"pilotReady":%s,"blockers":%s,"warnings":%s,"runtimePath":"%s","checkedAt":"%s","checks":[%s]}\n' \
  "$([[ "$blockers" -eq 0 ]] && echo true || echo false)" \
  "$([[ "$blockers" -eq 0 ]] && echo true || echo false)" \
  "$blockers" "$warnings" "$runtime_path" "$(date -u +%FT%TZ)" "$(IFS=,; echo "${checks[*]}")"

[[ "$blockers" -eq 0 ]]
