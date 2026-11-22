#!/usr/bin/env bash
# One-shot: install ZeroTier (already done), join YOUR OWN overlay network
# (2873fd00f2cc42ff, org "kdeng"), and print both node addresses to authorize.
#
# You are the admin of this network, so authorize BOTH members in Central:
#   local  9c7fc34643   and   H20  3e8f2d44bc
# Then pass the H20's newly-assigned managed IP to verify:
#   bash zt_install.sh <H20_new_ZT_IP>
#
# Run:  bash /home/robot/dsh_movie/extension/zerotier/zt_install.sh [H20_ZT_IP]
set -uo pipefail

NWID="2873fd00f2cc42ff"          # your own network (org kdeng) — you are the admin
LOCAL_NODE="9c7fc34643"          # this box
H20_NODE="3e8f2d44bc"            # yw01 (already ONLINE on ZeroTier)
H20_ZT_IP="${1:-}"               # H20's managed IP on THIS network (from Central Members)

echo "== [1/4] installing ZeroTier =="
if ! command -v zerotier-cli >/dev/null 2>&1; then
  curl -s https://install.zerotier.com | sudo bash
else
  echo "zerotier-cli already present: $(zerotier-cli info 2>&1)"
fi
sudo systemctl enable --now zerotier-one
sleep 2

echo "== [2/4] node identity =="
ADDR=$(sudo zerotier-cli info 2>/dev/null | awk '{print $3}')
echo "this node address: ${ADDR:-$LOCAL_NODE}   (authorize in Central)"
echo "H20 node address:  ${H20_NODE}   (authorize in Central too)"

echo "== [3/4] joining network ${NWID} =="
sudo zerotier-cli join "$NWID"
sleep 3
sudo zerotier-cli listnetworks

echo "== [4/4] state + verification =="
STATUS=$(sudo zerotier-cli listnetworks | awk -v n="$NWID" '$3==n {print $5}')
echo "network ${NWID} status: ${STATUS:-<not joined>}"
if [ "$STATUS" = "OK" ]; then
  MYIP=$(ip -brief addr | awk '/^zt/ {print $3}' | cut -d/ -f1 | head -1)
  echo "assigned overlay IP: ${MYIP:-<none>}"
  if [ -n "$H20_ZT_IP" ]; then
    printf 'ComfyUI /system_stats over overlay -> '
    curl -s -m 8 -o /dev/null -w '%{http_code}\n' "http://${H20_ZT_IP}:8188/system_stats"
    echo "AUTHORIZED & REACHABLE — run: COMFY_REMOTE_BASE_URL=http://${H20_ZT_IP}:8188 node src/smoke.ts"
  else
    echo "Authorized. Re-run with the H20 managed IP to verify: bash $0 <H20_ZT_IP>"
  fi
else
  cat <<EOF

>> Not authorized yet (status: ${STATUS:-REQUESTING_CONFIGURATION}). You are the admin of
>> network ${NWID}, so authorize BOTH members in Central:
>>   https://my.zerotier.com/network/${NWID}  →  Members → tick "Auth" for:
>>     ${LOCAL_NODE}   (this box)
>>     ${H20_NODE}   (H20 / yw01)
>> Each gets a managed IP; note the H20's, then re-run: bash $0 <H20_ZT_IP>
EOF
fi
