#!/bin/sh
# getproperty-edge OTA guard — systemd ExecStartPre (runs as the service user before every start).
# If a freshly installed slot is on trial (<state>/ota/pending.env) and it has already been started
# 3 times or its deadline passed without the agent committing it (health published), point
# <root>/slots/current back at the previous slot and leave rolled-back.env for the old agent to report.
set -eu
ROOT="${GP_OTA_ROOT:-/opt/getproperty-edge}"
STATE="${GP_STATE_DIR:-/var/lib/getproperty-edge}"
P="$STATE/ota/pending.env"
[ -f "$P" ] || exit 0

get() { sed -n "s/^$1=\([A-Za-z0-9._:+-]*\)\$/\1/p" "$P" | head -n 1; }
PREV="$(get PREVIOUS)"
VERSION="$(get VERSION)"
FROM="$(get FROM_VERSION)"
DEADLINE="$(get DEADLINE)"
ATTEMPTS="$(get ATTEMPTS)"

case "$PREV" in
  a | b) ;;
  *)
    echo "ota-guard: unreadable pending trial — ignoring it" >&2
    rm -f "$P"
    exit 0
    ;;
esac

ATTEMPTS=$((${ATTEMPTS:-0} + 1))
NOW="$(date +%s)"
if [ "$ATTEMPTS" -gt 3 ] || [ "$NOW" -gt "${DEADLINE:-0}" ]; then
  ln -sfn "$PREV" "$ROOT/slots/.current.guard"
  mv -Tf "$ROOT/slots/.current.guard" "$ROOT/slots/current"
  umask 077
  printf 'VERSION=%s\nFROM_VERSION=%s\nREASON=guard_start_%s\n' "$VERSION" "$FROM" "$ATTEMPTS" > "$STATE/ota/rolled-back.env"
  rm -f "$P"
  echo "ota-guard: $VERSION did not pass its health gate — rolled back to slot $PREV" >&2
  exit 0
fi

sed "s/^ATTEMPTS=.*/ATTEMPTS=$ATTEMPTS/" "$P" > "$P.tmp"
mv -f "$P.tmp" "$P"
exit 0
