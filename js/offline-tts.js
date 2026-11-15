/**
 * 离线引擎（sherpa-onnx WebAssembly）主线程封装。
 * 每个模型包首次使用需下载一次，之后保存在浏览器 Cache Storage，断网可用。
 * 更换/升级模型包时请用新目录和新缓存名，避免旧缓存与新文件混用。
 */
const OFFLINE_ROOT = new URL("../offline/", import.meta.url).href;

export const PACKS = {
  kokoro: {
    id: "kokoro",
    dir: "kokoro-v1",
    cache: "edgetts-offline-kokoro-v1",
    name: "Kokoro · 4 声",
    short: "Kokoro",
    desc: "中英文，更自然，2 女 2 男",
    voices: [
      { sid: 0, name: "晴岚", gender: "女", sample: "samples/zh_f_qinglan.mp3" },
      { sid: 1, name: "若溪", gender: "女", sample: "samples/zh_f_ruoxi.mp3" },
      { sid: 2, name: "云舟", gender: "男", sample: "samples/zh_m_yunzhou.mp3" },
      { sid: 3, name: "景澈", gender: "男", sample: "samples/zh_m_jingche.mp3" },
    ],
  },
  matcha: {
    id: "matcha",
    dir: "v1",
    cache: "edgetts-offline-v1",
    name: "Matcha · 女声",
    short: "Matcha",
    desc: "中英文，更小更快，1 女",
    voices: [{ sid: 0, name: "女声", gender: "女" }],
  },
};
export const DEFAULT_PACK = "kokoro";
export const sampleUrl = (pack, v) => (v.sample ? OFFLINE_ROOT + PACKS[pack].dir + "/" + v.sample : null);

export class OfflineEngine {
  constructor(packId = DEFAULT_PACK) {
    this.pack = PACKS[packId] || PACKS[DEFAULT_PACK];
    this.base = OFFLINE_ROOT + this.pack.dir + "/";
    this.manifestUrl = this.base + "model/manifest.json";
    this.worker = null;
    this.ready = false;
    this.loadPromise = null;
    this.pending = new Map();
    this.onProgress = null;
    this.seq = 0;
  }

  get supported() {
    return typeof WebAssembly === "object" && typeof Worker === "function" && "caches" in self;
  }

  /** 已缓存字节数与总大小，用来判断模型是否已完整下载 */
  async status() {
    if (!this.supported) return { supported: false, cached: false, size: 0 };
    try {
      if (!(await caches.has(this.pack.cache))) return { supported: true, cached: false, size: 0 };
      const cache = await caches.open(this.pack.cache);
      const mRes = await cache.match(this.manifestUrl);
      if (!mRes) return { supported: true, cached: false, size: 0 };
      const m = await mRes.json();
      const urls = [this.base + m.wasm.name, ...m.parts.map((p) => this.base + "model/" + p.name)];
      const hits = await Promise.all(urls.map((u) => cache.match(u)));
      return { supported: true, cached: hits.every(Boolean), size: m.size + m.wasm.size };
    } catch {
      return { supported: true, cached: false, size: 0 };
    }
  }

  async manifestSize() {
    try {
      const m = await (await fetch(this.manifestUrl)).json();
      return m.size + m.wasm.size;
    } catch {
      return 0;
    }
  }

  _ensureWorker() {
    if (this.worker) return;
    this.worker = new Worker(OFFLINE_ROOT + "tts-worker.js", { name: `${this.pack.dir}|${this.pack.cache}` });
    this.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "progress") this.onProgress?.(msg);
      else if (msg.type === "ready") {
        this.ready = true;
        this._resolveLoad?.();
      } else if (msg.type === "gen-progress") this.pending.get(msg.id)?.onProgress?.(msg.done, msg.total);
      else if (msg.type === "result") {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p?.resolve(msg);
      } else if (msg.type === "error") {
        const err = new Error(msg.message);
        if (msg.id != null && this.pending.has(msg.id)) {
          this.pending.get(msg.id).reject(err);
          this.pending.delete(msg.id);
        } else {
          this._rejectLoad?.(err);
        }
      }
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || "离线引擎崩溃（可能是内存不足）");
      this._rejectLoad?.(err);
      this.pending.forEach((p) => p.reject(err));
      this.pending.clear();
      this.worker.terminate();
      this.worker = null;
      this.ready = false;
      this.loadPromise = null;
    };
  }

  /** 下载（如未缓存）并初始化模型 */
  load() {
    if (this.ready) return Promise.resolve();
    if (this.loadPromise) return this.loadPromise;
    this._ensureWorker();
    navigator.storage?.persist?.().catch(() => {});
    this.loadPromise = new Promise((resolve, reject) => {
      this._resolveLoad = resolve;
      this._rejectLoad = (err) => {
        this.loadPromise = null;
        reject(err);
      };
      this.worker.postMessage({ type: "load" });
    });
    return this.loadPromise;
  }

  /**
   * @param {string[]} sentences 已切分的句子
   * @returns {Promise<{audio: Blob, cues: {start:number,end:number,text:string}[], duration:number}>}
   */
  async synthesize(sentences, { speed = 1, gain = 1, sid = 0 } = {}, onProgress) {
    await this.load();
    const id = ++this.seq;
    const msg = await new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ type: "generate", id, sentences, speed, sid });
    });
    const audio = encodeWav(msg.samples, msg.sampleRate, gain);
    return { audio, cues: msg.cues, duration: msg.samples.length / msg.sampleRate };
  }

  /** 释放 Worker（切换模型包时回收内存，缓存保留） */
  unload() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.ready = false;
    this.loadPromise = null;
  }

  async remove() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.ready = false;
    this.loadPromise = null;
    await caches.delete(this.pack.cache);
  }
}

function encodeWav(samples, sampleRate, gain = 1) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i] * gain));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** 按句切分，过长的句子再按逗号切，供离线合成与字幕使用 */
export function splitSentences(text, max = 80) {
  const out = [];
  const sentences = text.replace(/\r/g, "").match(/[^。！？!?；;\n]+[。！？!?；;]*|\n+/g) || [];
  for (let s of sentences) {
    s = s.trim();
    if (!s) continue;
    if (s.length <= max) { out.push(s); continue; }
    let cur = "";
    for (const piece of s.match(/[^，,、：:]+[，,、：:]*/g) || [s]) {
      if ((cur + piece).length > max && cur) { out.push(cur); cur = ""; }
      cur += piece;
      while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
    }
    if (cur) out.push(cur);
  }
  // 纯标点句会让模型报错，过滤掉
  return out.filter((s) => /[\p{L}\p{N}]/u.test(s));
}

const fmt = (sec, sep) => {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms % 1000, 3)}`;
};
export const cuesToSRT = (cues) => cues.map((c, i) => `${i + 1}\n${fmt(c.start, ",")} --> ${fmt(c.end, ",")}\n${c.text}\n`).join("\n");
export const cuesToVTT = (cues) => "WEBVTT\n\n" + cues.map((c, i) => `${i + 1}\n${fmt(c.start, ".")} --> ${fmt(c.end, ".")}\n${c.text}\n`).join("\n");
