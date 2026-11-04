/*
 * 离线 TTS Worker：sherpa-onnx (WebAssembly) + Matcha 中英文模型。
 * 模型数据被拆成多个 <25 MiB 的分片（Cloudflare Pages 单文件上限），
 * 首次下载后存入 Cache Storage，之后断网也能直接从缓存加载。
 */
const CACHE_NAME = "edgetts-offline-v1";
const BASE = new URL("./", self.location.href).href;
const MODEL_BASE = BASE + "model/";

let tts = null;
let loading = null;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function cachedFetch(url, onBytes) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(url);
  if (hit) {
    const buf = await hit.arrayBuffer();
    onBytes?.(buf.byteLength, true);
    return buf;
  }
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）：${url.split("/").pop()}`);
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onBytes?.(value.length, false);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  await cache.put(url, new Response(out.slice(0), { headers: { "Content-Type": "application/octet-stream" } }));
  return out.buffer;
}

async function loadScriptCached(url) {
  const buf = await cachedFetch(url);
  const blobUrl = URL.createObjectURL(new Blob([buf], { type: "text/javascript" }));
  try { importScripts(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
}

async function load() {
  if (tts) return;
  if (loading) return loading;
  loading = (async () => {
    const manifestRes = await cachedFetch(MODEL_BASE + "manifest.json");
    const manifest = JSON.parse(new TextDecoder().decode(manifestRes));
    const total = manifest.size + manifest.wasm.size;
    let done = 0;
    const tick = (n) => { done += n; post({ type: "progress", phase: "download", loaded: done, total }); };

    const wasmBinary = await cachedFetch(BASE + manifest.wasm.name, tick);
    const data = new Uint8Array(manifest.size);
    let off = 0;
    for (const p of manifest.parts) {
      const buf = new Uint8Array(await cachedFetch(MODEL_BASE + p.name, tick));
      data.set(buf, off);
      off += buf.length;
    }
    if (off !== manifest.size) throw new Error("模型文件不完整，请删除后重新下载");

    post({ type: "progress", phase: "init" });
    await new Promise((resolve, reject) => {
      self.Module = {
        wasmBinary,
        locateFile: (p) => BASE + p,
        getPreloadedPackage: () => data.buffer,
        setStatus: () => {},
        onAbort: (what) => reject(new Error("离线引擎初始化失败：" + what)),
        onRuntimeInitialized() {
          try {
            tts = createOfflineTts(self.Module);
            resolve();
          } catch (e) {
            reject(e);
          }
        },
      };
      loadScriptCached(BASE + "sherpa-onnx-wasm-main-tts.js")
        .then(() => loadScriptCached(BASE + "sherpa-onnx-tts.js"))
        .catch(reject);
    });
  })();
  try {
    await loading;
  } catch (e) {
    loading = null;
    throw e;
  }
}

function generate({ id, sentences, speed }) {
  const parts = [];
  const cues = [];
  let sampleRate = tts.sampleRate;
  let t = 0;
  for (let i = 0; i < sentences.length; i++) {
    const text = sentences[i];
    const audio = tts.generate({ text, sid: 0, speed: speed || 1.0 });
    sampleRate = audio.sampleRate || sampleRate;
    const gap = Math.round(sampleRate * 0.12);
    const dur = audio.samples.length / sampleRate;
    cues.push({ start: t, end: t + dur, text });
    t += dur + gap / sampleRate;
    parts.push(audio.samples, new Float32Array(gap));
    post({ type: "gen-progress", id, done: i + 1, total: sentences.length });
  }
  const len = parts.reduce((a, b) => a + b.length, 0);
  const samples = new Float32Array(len);
  let off = 0;
  for (const p of parts) { samples.set(p, off); off += p.length; }
  post({ type: "result", id, samples, sampleRate, cues }, [samples.buffer]);
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === "load") {
      await load();
      post({ type: "ready", sampleRate: tts.sampleRate, numSpeakers: tts.numSpeakers });
    } else if (msg.type === "generate") {
      await load();
      generate(msg);
    }
  } catch (err) {
    post({ type: "error", id: msg.id, message: err && err.message ? err.message : String(err) });
  }
};
