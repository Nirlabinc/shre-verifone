#!/usr/bin/env sh
set -eu

ACTION="${1:-check}"
HOSTS_PATH="/etc/hosts"
BEGIN="# BEGIN Verifone Commander Shre CStoreSKU local aliases"
END="# END Verifone Commander Shre CStoreSKU local aliases"
ALIASES="${ALIASES:-cstoresku cstoresku.local}"

remove_block() {
  awk -v begin="$BEGIN" -v end="$END" '
    $0 == begin { skip=1; next }
    $0 == end { skip=0; next }
    skip != 1 { print }
  ' "$HOSTS_PATH"
}

case "$ACTION" in
  check)
    if grep -qF "$BEGIN" "$HOSTS_PATH" && grep -qF "$END" "$HOSTS_PATH"; then
      echo "Installed: true"
    else
      echo "Installed: false"
    fi
    echo "URLs:"
    for alias in $ALIASES; do echo "  http://$alias:5480"; done
    ;;
  install)
    tmp="$(mktemp)"
    remove_block > "$tmp"
    {
      printf "\n%s\n" "$BEGIN"
      printf "127.0.0.1 %s\n" "$ALIASES"
      printf "::1 %s\n" "$ALIASES"
      printf "%s\n" "$END"
    } >> "$tmp"
    sudo cp "$tmp" "$HOSTS_PATH"
    rm -f "$tmp"
    echo "Installed local aliases: $ALIASES"
    ;;
  remove)
    tmp="$(mktemp)"
    remove_block > "$tmp"
    sudo cp "$tmp" "$HOSTS_PATH"
    rm -f "$tmp"
    echo "Removed local aliases: $ALIASES"
    ;;
  *)
    echo "Usage: $0 check|install|remove" >&2
    exit 2
    ;;
esac
