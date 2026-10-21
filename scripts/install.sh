#!/usr/bin/env bash
# getproperty-edge installer — run as root on the gateway (Debian/Raspberry Pi OS, arm64).
#
#   sudo ./install.sh --binary ./getproperty-edge-0.1.0-linux-arm64 [--api-url https://device.getproperty.co]
#                     [--mqtt-ws-fallback on|off]   (on: only where the building blocks 8883 AND the platform
#                                                    admin enabled this gateway's WebSocket fallback, D-239)
#
# Creates the service user, directories and permissions, installs the binary into A/B slot "a",
# the OTA guard, the systemd unit, udev rules (RS485 adapters, GPIO, LEDs), NTP and the hardware
# watchdog. Idempotent. The provisioning code is NOT written to disk: the installer types it on the
# LAN status page (http://<gateway>:8080) — see docs/RUNBOOK-FIELD.md.
#
# Test mode: --root DIR installs under DIR without touching users, ownership or systemd.
set -euo pipefail

ROOT=""
BINARY=""
# the device host on Collective's platform (Caddy DEVICE_HOST with the gateway client-certificate check, D-230)
API_URL="https://device.getproperty.co"
TZ_NAME="Asia/Bangkok"
NO_SYSTEMD=0
SVC_USER="gpedge"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MQTT_WS_FALLBACK="off"

usage() { sed -n '2,14p' "$0"; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --binary) BINARY="$2"; shift 2 ;;
    --api-url) API_URL="$2"; shift 2 ;;
    --tz) TZ_NAME="$2"; shift 2 ;;
    --mqtt-ws-fallback) MQTT_WS_FALLBACK="$2"; shift 2 ;;
    --root) ROOT="$2"; NO_SYSTEMD=1; shift 2 ;;
    --no-systemd) NO_SYSTEMD=1; shift ;;
    -h | --help) usage 0 ;;
    *) echo "unknown option $1" >&2; usage 1 ;;
  esac
done

[ -n "$BINARY" ] && [ -f "$BINARY" ] || { echo "--binary <file> is required" >&2; exit 1; }
case "$API_URL" in https://*) ;; *) echo "--api-url must be https://" >&2; exit 1 ;; esac
case "$MQTT_WS_FALLBACK" in on | off) ;; *) echo "--mqtt-ws-fallback must be on | off" >&2; exit 1 ;; esac
if [ -z "$ROOT" ] && [ "$(id -u)" -ne 0 ]; then echo "run as root (or use --root for a test install)" >&2; exit 1; fi

OPT="$ROOT/opt/getproperty-edge"
STATE="$ROOT/var/lib/getproperty-edge"
ETC="$ROOT/etc/getproperty-edge"
SYSTEMD_DIR="$ROOT/etc/systemd/system"
UDEV_DIR="$ROOT/etc/udev/rules.d"

own() { [ -z "$ROOT" ] && chown "$@" || true; }

echo "==> service user"
if [ -z "$ROOT" ]; then
  getent group gpio > /dev/null || groupadd --system gpio
  getent group dialout > /dev/null || groupadd --system dialout
  if ! id "$SVC_USER" > /dev/null 2>&1; then
    useradd --system --home-dir /var/lib/getproperty-edge --no-create-home --shell /usr/sbin/nologin \
      --groups dialout,gpio "$SVC_USER"
  else
    usermod -a -G dialout,gpio "$SVC_USER"
  fi
fi

echo "==> directories"
install -d -m 0755 "$OPT"
install -d -m 0755 "$OPT/slots"
own "$SVC_USER:$SVC_USER" "$OPT/slots"
for s in a b; do install -d -m 0755 "$OPT/slots/$s"; own "$SVC_USER:$SVC_USER" "$OPT/slots/$s"; done
install -d -m 0700 "$STATE"
own "$SVC_USER:$SVC_USER" "$STATE"
install -d -m 0750 "$ETC"
own "root:$SVC_USER" "$ETC"

echo "==> binary into slot a"
ACTIVE="a"
if [ -L "$OPT/slots/current" ]; then ACTIVE="$(readlink "$OPT/slots/current")"; fi
install -m 0755 "$BINARY" "$OPT/slots/$ACTIVE/getproperty-edge"
own "$SVC_USER:$SVC_USER" "$OPT/slots/$ACTIVE/getproperty-edge"
if [ ! -L "$OPT/slots/current" ]; then
  ln -s "$ACTIVE" "$OPT/slots/current"
  own -h "$SVC_USER:$SVC_USER" "$OPT/slots/current"
fi
# root-owned and outside the writable slots dir: the agent cannot alter its own guard
install -m 0755 "$HERE/ota-guard.sh" "$OPT/ota-guard.sh"

echo "==> configuration (no secrets)"
umask 027
cat > "$ETC/agent.env" << CONF
# getproperty-edge — non-secret settings; meters and buses come from the cloud config
# device host (bootstrap, token, renewal, readings fallback); the broker URL comes with the bootstrap answer
GP_API_URL=$API_URL
# MQTT 5 + mTLS + device JWT on outbound TCP 8883 (protocol 1.2). on = also allow the WebSocket fallback on 443
# (device JWT only, no client certificate, D-239) — used only if the platform admin enabled it for this gateway
GP_MQTT_WS_FALLBACK=$MQTT_WS_FALLBACK
GP_TZ=$TZ_NAME
GP_DRIVER_MODE=hardware
GP_STATUS_PORT=8080
GP_LOG_LEVEL=info
CONF
own "root:$SVC_USER" "$ETC/agent.env"
umask 022

echo "==> udev rules (RS485 adapters, GPIO, LEDs)"
install -d -m 0755 "$UDEV_DIR"
cat > "$UDEV_DIR/60-getproperty-edge.rules" << 'RULES'
# USB-RS485 adapters: FTDI FT232R/FT230X, WCH CH340/CH341, SiLabs CP210x → dialout + stable alias
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6001|6015", GROUP="dialout", MODE="0660", SYMLINK+="getproperty-rs485-%n"
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523|5523", GROUP="dialout", MODE="0660", SYMLINK+="getproperty-rs485-%n"
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="ea60", GROUP="dialout", MODE="0660", SYMLINK+="getproperty-rs485-%n"
# GPIO character devices (pulse inputs)
SUBSYSTEM=="gpio", KERNEL=="gpiochip*", GROUP="gpio", MODE="0660"
# status LED brightness writable by the gpio group (identify command)
SUBSYSTEM=="leds", ACTION=="add", RUN+="/bin/chgrp gpio /sys%p/brightness", RUN+="/bin/chmod g+w /sys%p/brightness"
RULES

echo "==> time sync (NTP) and hardware watchdog"
install -d -m 0755 "$ROOT/etc/systemd/timesyncd.conf.d" "$ROOT/etc/systemd/system.conf.d" "$ROOT/etc/systemd/journald.conf.d"
cat > "$ROOT/etc/systemd/timesyncd.conf.d/getproperty.conf" << 'NTP'
[Time]
NTP=0.th.pool.ntp.org 1.th.pool.ntp.org 2.th.pool.ntp.org
FallbackNTP=time.google.com time.cloudflare.com
NTP
cat > "$ROOT/etc/systemd/system.conf.d/getproperty-watchdog.conf" << 'WD'
[Manager]
# systemd pets the SoC watchdog; a hung kernel reboots the gateway
RuntimeWatchdogSec=30
RebootWatchdogSec=10min
WD
cat > "$ROOT/etc/systemd/journald.conf.d/getproperty.conf" << 'J'
[Journal]
# SD-card friendly: bounded persistent journal (upload_logs reads it)
Storage=persistent
SystemMaxUse=200M
J

echo "==> systemd unit"
install -d -m 0755 "$SYSTEMD_DIR"
install -m 0644 "$HERE/../systemd/getproperty-edge.service" "$SYSTEMD_DIR/getproperty-edge.service" 2> /dev/null \
  || install -m 0644 "$HERE/getproperty-edge.service" "$SYSTEMD_DIR/getproperty-edge.service"

if [ "$NO_SYSTEMD" -eq 0 ]; then
  command -v gpiomon > /dev/null || echo "WARNING: gpiomon not found — install 'gpiod' for pulse meters" >&2
  timedatectl set-timezone "$TZ_NAME" || true
  udevadm control --reload-rules && udevadm trigger || true
  systemctl daemon-reload
  systemctl enable --now systemd-timesyncd || true
  systemctl enable getproperty-edge
  systemctl restart getproperty-edge
  echo "==> done: open http://$(hostname -I 2> /dev/null | awk '{print $1}'):8080 and enter the provisioning code"
else
  echo "==> done (files only under ${ROOT:-/})"
fi
