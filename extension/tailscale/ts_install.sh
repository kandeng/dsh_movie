#!/usr/bin/env bash
# One-shot: install the tarball tailscaled as a systemd service, join the
# kandeng@ tailnet, and verify the H20 (yw01) ComfyUI is reachable.
# Safe to re-run. Run:  bash /home/robot/drone-navigation-v2/ts_install.sh
set -euo pipefail

T=/home/robot/tailscale_1.98.8_amd64

echo "== [1/4] installing tailscaled service files =="
sudo ln -sf "$T/tailscaled" /usr/local/sbin/tailscaled
sudo ln -sf "$T/tailscaled" /usr/sbin/tailscaled   # unit's ExecStart path
sudo cp "$T/systemd/tailscaled.service" \
        "$T/systemd/tailscale-online.target" \
        "$T/systemd/tailscale-wait-online.service" /lib/systemd/system/
sudo cp "$T/systemd/tailscaled.defaults" /etc/default/tailscaled
sudo systemctl daemon-reload
sudo systemctl enable --now tailscaled
sleep 2
echo "tailscaled: $(systemctl is-active tailscaled)"

echo "== [2/4] joining tailnet (tailscale up) =="
# Run directly (no pipe) so the auth URL is visible: an expired node key makes
# 'tailscale up' block until browser login completes.
sudo tailscale up

echo "== [3/4] tailnet status =="
tailscale status | head -10

echo "== [4/4] verifying yw01 ComfyUI =="
for u in http://yw01:8188/system_stats http://yw01:8188/model_catalog/categories; do
  printf '%s -> ' "$u"
  curl -s -m 8 -o /dev/null -w '%{http_code}\n' "$u" || echo UNREACHABLE
done
echo "DONE"
