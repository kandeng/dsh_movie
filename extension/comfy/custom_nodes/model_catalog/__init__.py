"""Routes-only model catalog for ComfyUI (local engine edition).

Mirrors the H20's ``custom_nodes/model_catalog`` HTTP surface so the DSH-Movie
bridge can treat both engines identically:

    GET /model_catalog              -> {"models": [entry, ...]}
    GET /model_catalog/categories   -> {"categories": [{"name", "count"}, ...]}
    GET /model_catalog/{category}   -> {"category", "models"} (404 if unknown)

Each entry follows the documented schema (deployment/H20/comfy/README.md):
``id``, ``category``, ``filename``, ``path``, ``size_bytes``, ``size_human``,
``lazy_loaded``, ``purpose``, ``loader``, ``est_vram_gb``, ``est_ram_gb``,
``description``.

The node NEVER loads weights — it only stats files on disk under
``models/``. Descriptions are honest, file-derived text (category, exact
size, loader node); no curated per-model essays are synthesized.
"""

from __future__ import annotations

import os

from server import PromptServer

NODE_CLASS_MAPPINGS: dict = {}
NODE_DISPLAY_NAME_MAPPINGS: dict = {}

MODEL_EXTS = {
    ".safetensors",
    ".ckpt",
    ".pt",
    ".pth",
    ".bin",
    ".onnx",
    ".gguf",
    ".sft",
}

# category -> (default loader node, purpose text, est VRAM/RAM GB by size)
CATEGORY_INFO = {
    "checkpoints": ("CheckpointLoaderSimple", "Diffusion checkpoint (model + CLIP + VAE)"),
    "diffusion_models": ("UNETLoader", "Standalone diffusion model weights"),
    "unet": ("UNETLoader", "Standalone UNet weights"),
    "loras": ("LoraLoader", "LoRA fine-tune adapter"),
    "vae": ("VAELoader", "VAE encoder/decoder weights"),
    "clip": ("CLIPLoader", "Text encoder (CLIP/T5) weights"),
    "text_encoders": ("CLIPLoader", "Text encoder weights"),
    "clip_vision": ("CLIPVisionLoader", "CLIP vision encoder weights"),
    "controlnet": ("ControlNetLoader", "ControlNet conditioning model"),
    "upscale_models": ("UpscaleModelLoader", "Image upscaling model"),
    "embeddings": ("EmbeddingLoader", "Textual-inversion embedding"),
    "style_models": ("StyleModelLoader", "Style/reference model"),
    "hypernetworks": ("HypernetworkLoader", "Hypernetwork weights"),
    "gligen": ("GLIGENLoader", "Grounded language-to-image adapter"),
    "model_patches": ("ModelPatchLoader", "Model patch weights"),
    "latent_upscale_models": ("LatentUpscaleModelLoader", "Latent upscaling model"),
    "vae_approx": ("VAEApproxLoader", "Fast VAE preview approximation model"),
    "audio_encoders": ("AudioEncoderLoader", "Audio encoder weights"),
    "frame_interpolation": ("FrameInterpolationLoader", "Video frame interpolation model"),
    "optical_flow": ("OpticalFlowLoader", "Optical flow estimation model"),
    "photomaker": ("PhotoMakerLoader", "PhotoMaker identity adapter"),
    "detection": ("DetectionLoader", "Object/face detection model"),
    "background_removal": ("BackgroundRemovalLoader", "Matting/background removal model"),
    "geometry_estimation": ("GeometryLoader", "Depth/geometry estimation model"),
    "diffusers": ("DiffusersLoader", "Diffusers-format model directory"),
}


def _models_root() -> str:
    import folder_paths

    return folder_paths.models_dir


def _human_size(num: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if num < 1024.0 or unit == "TB":
            return f"{num:.2f} {unit}" if unit != "B" else f"{int(num)} B"
        num /= 1024.0
    return f"{num:.2f} TB"


def _estimate_gb(size_bytes: int) -> float:
    """Rough fp16 working-set estimate: file size + small headroom, in GB."""
    gb = size_bytes / (1024 ** 3)
    return round(min(max(gb * 1.2, 0.5), 24.0), 1)


def _entry(category: str, rel: str, full: str) -> dict:
    stat = os.stat(full)
    filename = os.path.basename(rel)
    loader, purpose = CATEGORY_INFO.get(category, ("CheckpointLoaderSimple", "Model weights"))
    est = _estimate_gb(stat.st_size)
    rel_id = f"{category}/{rel}"
    description = (
        f"{purpose}. File {filename} ({_human_size(stat.st_size)}) in models/{category}; "
        f"loaded lazily by {loader} when a workflow requests it. Est. VRAM {est} GB."
    )
    return {
        "id": rel_id,
        "category": category,
        "filename": filename,
        "path": full,
        "size_bytes": stat.st_size,
        "size_human": _human_size(stat.st_size),
        "lazy_loaded": True,
        "purpose": purpose,
        "loader": loader,
        "est_vram_gb": est,
        "est_ram_gb": est,
        "description": description,
    }


def _scan() -> dict[str, list[dict]]:
    root = _models_root()
    out: dict[str, list[dict]] = {}
    for category in sorted(os.listdir(root)):
        cat_dir = os.path.join(root, category)
        if not os.path.isdir(cat_dir) or category == "configs":
            continue
        entries: list[dict] = []
        for dirpath, _dirnames, filenames in os.walk(cat_dir):
            for name in sorted(filenames):
                ext = os.path.splitext(name)[1].lower()
                if ext not in MODEL_EXTS:
                    continue
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, cat_dir)
                try:
                    entries.append(_entry(category, rel, full))
                except OSError:
                    continue
        if entries:
            out[category] = entries
    return out


def _flat(catalog: dict[str, list[dict]]) -> list[dict]:
    return [entry for entries in catalog.values() for entry in entries]


routes = PromptServer.instance.routes


@routes.get("/model_catalog")
async def model_catalog(request):  # noqa: ANN001, ANN201
    from aiohttp import web

    return web.json_response({"models": _flat(_scan())})


@routes.get("/model_catalog/categories")
async def model_catalog_categories(request):  # noqa: ANN001, ANN201
    from aiohttp import web

    catalog = _scan()
    return web.json_response(
        {"categories": [{"name": name, "count": len(items)} for name, items in catalog.items()]}
    )


@routes.get("/model_catalog/{category}")
async def model_catalog_category(request):  # noqa: ANN001, ANN201
    from aiohttp import web

    category = request.match_info["category"]
    if category == "categories":  # shadowed by the static route above; keep 404 semantics
        return web.json_response({"error": "unknown-category"}, status=404)
    catalog = _scan()
    items = catalog.get(category)
    if items is None:
        return web.json_response({"error": "unknown-category"}, status=404)
    return web.json_response({"category": category, "models": items})
