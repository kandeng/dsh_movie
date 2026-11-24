import gc
import io
import os
import sys
import threading
import time
import wave

# Single path knob, matching the launcher scripts (default = reference layout).
COMFY_ROOT = os.environ.get('COMFY_ROOT', '/root/comfy')

sys.path.append(f'{COMFY_ROOT}/CosyVoice')
sys.path.append(f'{COMFY_ROOT}/CosyVoice/third_party/Matcha-TTS')

import numpy as np
import torch
import torchaudio
from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel

from cosyvoice.cli.cosyvoice import AutoModel

MODEL_DIR = f'{COMFY_ROOT}/CosyVoice/pretrained_models/CosyVoice2-0.5B'
UDS_PATH = os.environ.get('COSY_UDS', f'{COMFY_ROOT}/log/tts.sock')
IDLE_TIMEOUT = float(os.environ.get('COSY_IDLE_TIMEOUT', '600'))
SAMPLE_RATE = 24000

PROMPTS = {
    'female_zh': ('希望你以后能够做的比我还好呦。', f'{COMFY_ROOT}/CosyVoice/asset/zero_shot_prompt.wav'),
    'female_zh_alt': ('', f'{COMFY_ROOT}/CosyVoice/asset/cross_lingual_prompt.wav'),
}

app = FastAPI(title='CosyVoice2 TTS (lazy, unix socket)')

_lock = threading.Lock()
_model = None
_last_used = 0.0


def _get_model():
    global _model, _last_used
    if _model is None:
        t0 = time.time()
        _model = AutoModel(model_dir=MODEL_DIR)
        print(f'[tts] model loaded in {time.time() - t0:.1f}s (lazy)', flush=True)
    _last_used = time.time()
    return _model


def _unload_model(reason):
    global _model
    if _model is not None:
        _model = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        print(f'[tts] model unloaded ({reason})', flush=True)


def _idle_watcher():
    while True:
        time.sleep(min(15.0, max(1.0, IDLE_TIMEOUT / 4)))
        with _lock:
            if _model is not None and (time.time() - _last_used) >= IDLE_TIMEOUT:
                _unload_model(f'idle > {IDLE_TIMEOUT:.0f}s')


threading.Thread(target=_idle_watcher, daemon=True, name='tts-idle-watcher').start()


class TTSRequest(BaseModel):
    text: str
    speaker_id: str = 'female_zh'


def wav_bytes(tensor, sample_rate):
    pcm = (tensor.squeeze(0).numpy() * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


@app.get('/health')
def health():
    return {'status': 'ok', 'model_loaded': _model is not None, 'sample_rate': SAMPLE_RATE,
            'speakers': list(PROMPTS), 'idle_timeout_s': IDLE_TIMEOUT, 'socket': UDS_PATH}


@app.post('/tts')
def tts(req: TTSRequest):
    if req.speaker_id not in PROMPTS:
        return Response(content=f'unknown speaker_id, choose from {list(PROMPTS)}', status_code=400,
                        media_type='text/plain')
    prompt_text, prompt_wav = PROMPTS[req.speaker_id]
    with _lock:
        cosy = _get_model()
        chunks = []
        if prompt_text:
            for j in cosy.inference_zero_shot(req.text, prompt_text, prompt_wav, stream=False):
                chunks.append(j['tts_speech'])
        else:
            for j in cosy.inference_cross_lingual(req.text, prompt_wav, stream=False):
                chunks.append(j['tts_speech'])
        audio = chunks[0] if len(chunks) == 1 else torch.cat(chunks, dim=1)
        out = wav_bytes(audio, cosy.sample_rate)
        _last_used = time.time()
    return Response(content=out, media_type='audio/wav',
                    headers={'Content-Disposition': 'attachment; filename="tts.wav"'})


if __name__ == '__main__':
    import uvicorn
    os.makedirs(os.path.dirname(UDS_PATH), exist_ok=True)
    if os.path.exists(UDS_PATH):
        os.unlink(UDS_PATH)
    print(f'[tts] serving on unix socket {UDS_PATH} (lazy load, idle timeout {IDLE_TIMEOUT:.0f}s)', flush=True)
    uvicorn.run(app, uds=UDS_PATH, log_level='info')
