#!/usr/bin/env bash
# Tear down the ZeroTier overlay connection — idempotent:
#   • already left + daemon stopped → report "already-stopped" and exit 0
#   • otherwise → zerotier-cli leave $NWID (drops the current connection and
#     managed IP), then systemctl stop zerotier-one
# Leaving does NOT revoke anything: the node identity (identity.secret) and
# the Central-side authorization persist, so zerotier_start.sh re-joins and
# receives the SAME managed IP without admin action.
# Root required; self-elevates via sudo — run from an interactive terminal.
set -uo pipefail

if [ "$(id -u)" -ne 0 ]; then
  exec sudo bash "$0" "$@"
fi

NWID="${ZEROTIER_NWID:-2873fd00f2cc42ff}"   # private network, org kdeng

daemon_active() { systemctl is-active --quiet zerotier-one; }
# listnetworks format: 200 listnetworks <nwid> <name> <mac> <status> <type> <dev> <ips>
# <name> may be empty/contain spaces → locate "OK" by scanning fields; IP is $NF ("-" when none).
zt_ip()         { zerotier-cli listnetworks 2>/dev/null | awk -v n="$NWID" '$3==n { ok=0; for (i=4;i<=NF;i++) if ($i=="OK") ok=1; if (ok && $NF ~ /^[0-9]/) { print $NF; exit } }'; }

if ! daemon_active && [ -z "$(zt_ip)" ]; then
  echo "already-stopped nwid=$NWID daemon=zerotier-one"
  exit 0
fi

if daemon_active; then
  IP="$(zt_ip)"
  if [ -n "$IP" ]; then
    zerotier-cli leave "$NWID" >/dev/null 2>&1 || true
    echo "left nwid=$NWID (released ${IP%%/*})"
  else
    zerotier-cli leave "$NWID" >/dev/null 2>&1 || true
    echo "left nwid=$NWID (no managed IP was assigned)"
  fi
  systemctl stop zerotier-one || { echo "FAILED systemctl stop zerotier-one"; exit 1; }
fi

# verify: daemon inactive and no zt interface carries a managed IPv4
for _ in $(seq 1 10); do
  daemon_active || break
  sleep 0.5
done
if daemon_active; then
  echo "FAILED zerotier-one still active — journalctl -u zerotier-one"
  exit 1
fi
if ip -4 -br addr show 2>/dev/null | awk '$1 ~ /^zt/ && $3 ~ /^[0-9]/ {found=1} END {exit !found}'; then
  echo "FAILED a zt interface still carries a managed IP"
  exit 1
fi
echo "disconnected nwid=$NWID daemon=stopped — reconnect with zerotier_start.sh"
