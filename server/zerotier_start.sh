#!/usr/bin/env bash
# Bring up the ZeroTier overlay to the remote H20 engine — idempotent:
#   • daemon down            → systemctl start zerotier-one, wait for ONLINE
#   • network not joined     → zerotier-cli join $NWID (one-shot; membership
#                              persists under /var/lib/zerotier-one/networks.d)
#   • joined, awaiting IP    → wait for status OK + managed IP from Central
#   • already connected      → report "already-connected" and verify L3
# Root is required (zerotier-cli reads /var/lib/zerotier-one/authtoken.secret);
# the script self-elevates via sudo, so run it from an interactive terminal.
# Companion: zerotier_stop.sh. NOTE: this machine's node ID and Central
# authorization persist across leave/join, so the managed IP is stable.
set -uo pipefail

if [ "$(id -u)" -ne 0 ]; then
  exec sudo bash "$0" "$@"
fi

NWID="${ZEROTIER_NWID:-2873fd00f2cc42ff}"   # private network, org kdeng
H20_IP="${H20_ZT_IP:-10.188.8.105}"          # H20's managed IP on $NWID
TIMEOUT="${1:-60}"

zt_info()    { zerotier-cli info 2>/dev/null; }
# listnetworks format: 200 listnetworks <nwid> <name> <mac> <status> <type> <dev> <ips>
# <name> may be empty/contain spaces → locate "OK" by scanning fields; IP is $NF ("-" when none).
zt_nwid_ip() { zerotier-cli listnetworks 2>/dev/null | awk -v n="$NWID" '$3==n { ok=0; for (i=4;i<=NF;i++) if ($i=="OK") ok=1; if (ok && $NF ~ /^[0-9]/) { print $NF; exit } }'; }

# 1) daemon
if ! systemctl is-active --quiet zerotier-one; then
  systemctl start zerotier-one || { echo "FAILED systemctl start zerotier-one"; exit 1; }
fi
for _ in $(seq 1 30); do
  zt_info | grep -q "ONLINE" && break
  sleep 1
done
zt_info | grep -q "ONLINE" || { echo "FAILED zerotier-one did not reach ONLINE — journalctl -u zerotier-one"; exit 1; }

# 2) membership
if [ -z "$(zt_nwid_ip)" ]; then
  zerotier-cli listnetworks 2>/dev/null | awk -v n="$NWID" '$3==n {found=1} END {exit !found}' \
    || zerotier-cli join "$NWID" >/dev/null
  for _ in $(seq 1 "$TIMEOUT"); do
    [ -n "$(zt_nwid_ip)" ] && break
    sleep 1
  done
fi

MY_IP="$(zt_nwid_ip)"
if [ -z "$MY_IP" ]; then
  echo "FAILED no managed IP on $NWID within ${TIMEOUT}s — check Central auth (my.zerotier.com → Members)"
  zerotier-cli listnetworks
  exit 1
fi
echo "connected nwid=$NWID local_ip=${MY_IP%%/*} node=$(zt_info | awk '{print $3}')"

# 3) verify path to the H20 (L3 always; TCP 8188 only if its engine is up)
if ping -c 2 -W 3 "$H20_IP" >/dev/null 2>&1; then
  echo "h20 overlay ping: OK ($H20_IP)"
else
  echo "h20 overlay ping: UNREACHABLE ($H20_IP) — H20 offline or its zerotier-one down"
fi
if curl -s -m 5 -o /dev/null "http://$H20_IP:8188/system_stats"; then
  echo "h20 comfy api: UP (http://$H20_IP:8188)"
else
  echo "h20 comfy api: DOWN — start it on H20 via JumpServer: /root/comfy/start.sh"
fi
