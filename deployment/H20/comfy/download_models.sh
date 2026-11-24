#!/usr/bin/env bash
# Provision the model bill-of-materials for the movie ComfyUI stack.
#
# Reads a TSV manifest (default: models.manifest next to this script) with one
# row per artifact:
#     <dest>\t<size_bytes>\t<url>
#   dest       path relative to $COMFY_ROOT (e.g. ComfyUI/models/checkpoints/x.safetensors,
#              or CosyVoice/pretrained_models/... for the TTS weights)
#   size_bytes exact on-disk byte count, or "-" when unknown (size check skipped)
#   url        full https URL, or "-" for check-only rows (no known mirror)
# Lines starting with '#' and blank lines are ignored.
#
# Modes:
#   ./download_models.sh               download anything missing / size-mismatched (aria2c, resume-safe)
#   ./download_models.sh --check-only  audit an existing box: verify on-disk sizes, no network
#
# Env: COMFY_ROOT (default /root/comfy), MANIFEST (default <script dir>/models.manifest)
set -uo pipefail

COMFY_ROOT="${COMFY_ROOT:-/root/comfy}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${MANIFEST:-${SCRIPT_DIR}/models.manifest}"
CHECK_ONLY=0
[ "${1:-}" = "--check-only" ] && CHECK_ONLY=1

if [ ! -f "$MANIFEST" ]; then
    echo "ERROR: manifest not found: $MANIFEST" >&2
    echo "Generate it on a fully-provisioned reference host (see DEPLOY.md step 4)." >&2
    exit 2
fi
if [ "$CHECK_ONLY" = 0 ] && ! command -v aria2c >/dev/null 2>&1; then
    echo "ERROR: aria2c not installed (apt-get install -y aria2)." >&2
    exit 2
fi

missing=0 bad=0 ok=0 skipped=0
while IFS=$'\t' read -r dest size url; do
    # skip comments / blanks
    case "$dest" in ''|\#*) continue ;; esac
    abs="${COMFY_ROOT}/${dest}"

    have="-"
    if [ -f "$abs" ]; then
        have=$(stat -c %s "$abs")
    fi

    if [ "$CHECK_ONLY" = 1 ]; then
        if [ "$have" = "-" ]; then
            echo "MISSING  $dest"; missing=$((missing+1))
        elif [ "$size" != "-" ] && [ "$have" != "$size" ]; then
            echo "BADSIZE  $dest (have $have, want $size)"; bad=$((bad+1))
        else
            ok=$((ok+1))
        fi
        continue
    fi

    # download mode
    if [ "$have" != "-" ] && { [ "$size" = "-" ] || [ "$have" = "$size" ]; }; then
        ok=$((ok+1)); continue
    fi
    if [ "$url" = "-" ]; then
        echo "SKIP     $dest (no url in manifest; place manually)"; skipped=$((skipped+1)); continue
    fi
    mkdir -p "$(dirname "$abs")"
    echo "GET      $dest"
    if ! aria2c -c -x16 -s16 -d "$(dirname "$abs")" -o "$(basename "$abs")" "$url"; then
        echo "FAILED   $dest"; bad=$((bad+1)); continue
    fi
    have=$(stat -c %s "$abs" 2>/dev/null || echo -)
    if [ "$size" != "-" ] && [ "$have" != "$size" ]; then
        echo "BADSIZE  $dest (have $have, want $size)"; bad=$((bad+1))
    else
        ok=$((ok+1))
    fi
done < "$MANIFEST"

echo "---- manifest summary: ok=$ok missing=$missing bad=$bad skipped=$skipped (root=$COMFY_ROOT)"
[ "$missing" = 0 ] && [ "$bad" = 0 ]
