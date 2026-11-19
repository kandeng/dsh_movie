# Resilient ComfyUI launcher for the DSH-Movie local engine.
#
# Prefers the GPU. When the NVIDIA driver is in a fault state (Xid 31 MMU
# fault -> cuInit 999 for every new context; recovery needs a machine reboot),
# torch.cuda.is_available() is False and comfy_kitchen's triton backend crashes
# at import time: triton.autotune asks driver.active.get_benchmarker() and the
# driver proxy raises "0 active drivers". The package only catches ImportError
# there, so the RuntimeError escapes and kills boot.
#
# In that situation we install a benign benchmarker stub (the triton backend is
# disabled by ComfyUI anyway unless --enable-triton-backend is passed) and fall
# back to --cpu so the local SD1.5 engine keeps serving real generations.
import runpy
import sys

COMFY_MAIN = "/home/robot/ComfyUI/main.py"


def main() -> None:
    import torch

    argv = ["main.py", "--listen", "127.0.0.1", "--port", "8188"]
    if torch.cuda.is_available():
        print("[comfy-launch] CUDA healthy -> GPU mode", flush=True)
    else:
        print("[comfy-launch] CUDA unavailable -> CPU fallback mode", flush=True)
        import triton.testing as tt
        from triton.runtime import driver as _cfg

        class _BenchDriver:
            def get_benchmarker(self):
                return tt.do_bench

        _cfg.set_active(_BenchDriver())
        argv.append("--cpu")

    sys.argv = argv
    runpy.run_path(COMFY_MAIN, run_name="__main__")


if __name__ == "__main__":
    main()