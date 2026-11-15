# Kokoro multi-lang v1.1 · 4 voices (browser bundle)

- Bundle: [haixin/timeline-studio-voice-models](https://huggingface.co/haixin/timeline-studio-voice-models) `kokoro-multi-lang-v1_1-fp16-4voices` (Apache-2.0, see `LICENSE`).
- Model: [hexgrad/Kokoro-82M-v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh) via `csukuangfj/kokoro-multi-lang-v1_1`, FP16 weights, 24 kHz, Chinese + English.
- Runtime: [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) WASM (commit 6897144), with the bundle author's zh/en span-merge fix.
- Voices (local sid → upstream): 0 晴岚 zf_001 · 1 若溪 zf_073 · 2 云舟 zm_009 · 3 景澈 zm_010.
- The Emscripten data package (212,733,356 bytes, sha256 48b5b1fd…fb86e) is re-split here into ≤22 MB parts in `model/` for the Cloudflare Pages 25 MiB per-file limit; the files are otherwise unmodified.
