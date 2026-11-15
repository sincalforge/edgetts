import { EdgeTTS, createVTT, createSRT } from "./edge-tts.js";
import voices from "./voices.js";
import { OfflineEngine, PACKS, DEFAULT_PACK, sampleUrl, splitSentences, cuesToSRT, cuesToVTT } from "./offline-tts.js";

const STORE_KEY = "edgetts.settings.v2";
const CHUNK_LIMIT = 1500; // 后端单次上限 3000，留余量
const MP3_BYTES_PER_SEC = 48000 / 8; // audio-24khz-48kbitrate-mono-mp3
const HISTORY_MAX = 6;

const SAMPLES = {
  zh: "你好，这是声音试听。欢迎使用 Edge TTS 语音工作室。",
  en: "Hello, this is a voice preview from Edge TTS Voice Studio.",
  ja: "こんにちは、これは音声のプレビューです。",
  ko: "안녕하세요, 음성 미리 듣기입니다.",
  fr: "Bonjour, ceci est un aperçu de la voix.",
  de: "Hallo, dies ist eine Stimmvorschau.",
  es: "Hola, esta es una vista previa de la voz.",
  ru: "Здравствуйте, это предварительное прослушивание голоса.",
  it: "Ciao, questa è un'anteprima della voce.",
  pt: "Olá, esta é uma prévia da voz.",
};

// ---------- data ----------
const allVoices = [];
const langNames = {};
Object.entries(voices).forEach(([code, group]) => {
  ["male", "female"].forEach((g) =>
    (group[g] || []).forEach((v) => allVoices.push({ ...v, code, g }))
  );
  const sample = group.male?.[0] || group.female?.[0];
  if (sample) langNames[code] = sample.language || code;
});
const sortedLangs = Object.keys(voices).sort((a, b) => {
  if (a === "zh") return -1;
  if (b === "zh") return 1;
  if (a === "en") return -1;
  if (b === "en") return 1;
  return (langNames[a] || a).localeCompare(langNames[b] || b, "zh");
});

// ---------- state ----------
const defaults = {
  lang: "zh", gender: "all", voice: "zh-CN-XiaoxiaoNeural",
  rate: 100, pitch: 0, volume: 0, autoPlay: true, text: "", engine: "auto",
  offlinePack: DEFAULT_PACK, offlineSid: 0,
};
let state = { ...defaults };
try { Object.assign(state, JSON.parse(localStorage.getItem(STORE_KEY) || "{}")); } catch {}
if (!voices[state.lang]) state.lang = "zh";
if (!PACKS[state.offlinePack]) state.offlinePack = DEFAULT_PACK;
const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {} };

// ---------- dom ----------
const $ = (id) => document.getElementById(id);
const langSelect = $("lang-select");
const voiceList = $("voice-list");
const voiceSearch = $("voice-search");
const textInput = $("text-input");
const generateBtn = $("generate-btn");
const audioPanel = $("audio-panel");
const autoPlayCb = $("auto-play");
const rateSlider = $("rate-slider"), rateLabel = $("rate-label");
const pitchSlider = $("pitch-slider"), pitchLabel = $("pitch-label");
const volumeSlider = $("volume-slider"), volumeLabel = $("volume-label");
const charCount = $("char-count");
const voiceCount = $("voice-count");
const currentVoiceLabel = $("current-voice-label");
const currentVoiceId = $("current-voice-id");
const statusEl = $("status");
const historyList = $("history-list");
const historyBox = $("history-box");
const progressBar = $("progress-bar");

$("total-voices").textContent = allVoices.length;
$("total-langs").textContent = Object.keys(voices).length;

function setStatus(msg, kind = "") {
  statusEl.textContent = msg || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
}
function setProgress(p) {
  progressBar.style.width = p == null ? "0" : `${Math.round(p * 100)}%`;
  progressBar.parentElement.classList.toggle("on", p != null);
}
const icons = () => window.lucide && window.lucide.createIcons();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const labelOf = (v) => [v.chracter, v.lang, v.region].filter(Boolean).join(" · ");

// ---------- language & voices ----------
function populateLangs() {
  langSelect.innerHTML = sortedLangs
    .map((c) => {
      const n = (voices[c].male?.length || 0) + (voices[c].female?.length || 0);
      return `<option value="${c}"${c === state.lang ? " selected" : ""}>${esc(langNames[c] || c)}（${n}）</option>`;
    })
    .join("");
}

function filteredVoices() {
  const q = voiceSearch.value.trim().toLowerCase();
  let list = q
    ? allVoices.filter((v) =>
        [v.chracter, v.name, v.language, v.region, v.lang].filter(Boolean).join(" ").toLowerCase().includes(q))
    : allVoices.filter((v) => v.code === state.lang);
  if (state.gender !== "all") list = list.filter((v) => v.g === state.gender);
  return list;
}

function renderVoices() {
  const list = filteredVoices();
  const q = voiceSearch.value.trim();
  voiceCount.textContent = q ? `搜索到 ${list.length} 个声音` : `${list.length} 个声音`;
  if (!list.length) {
    voiceList.innerHTML = `<p class="empty">没有匹配的声音</p>`;
    return;
  }
  voiceList.innerHTML = list
    .map((v) => `
      <div class="voice-item${v.name === state.voice ? " active" : ""}" role="option" tabindex="0" data-name="${v.name}">
        <span class="avatar ${v.g}">${esc(v.chracter.slice(0, 1))}</span>
        <span class="vmeta">
          <span class="vname">${esc(v.chracter)}${v.name.includes("Multilingual") ? '<em class="tag">多语种</em>' : ""}</span>
          <span class="vsub">${esc([q ? v.language : null, v.lang, v.region].filter(Boolean).join(" · "))}</span>
        </span>
        <button type="button" class="preview" title="试听" aria-label="试听 ${esc(v.chracter)}"><i data-lucide="volume-2"></i></button>
      </div>`)
    .join("");
  icons();
}

function selectVoice(name, scroll = false) {
  const v = allVoices.find((x) => x.name === name);
  if (!v) return;
  state.voice = name; save();
  currentVoiceLabel.textContent = labelOf(v);
  currentVoiceId.textContent = v.name;
  voiceList.querySelectorAll(".voice-item").forEach((el) => el.classList.toggle("active", el.dataset.name === name));
  if (scroll) voiceList.querySelector(".voice-item.active")?.scrollIntoView({ block: "nearest" });
}

voiceList.addEventListener("click", (e) => {
  const item = e.target.closest(".voice-item");
  if (!item) return;
  if (e.target.closest(".preview")) previewVoice(item.dataset.name, e.target.closest(".preview"));
  else selectVoice(item.dataset.name);
});
voiceList.addEventListener("keydown", (e) => {
  const item = e.target.closest(".voice-item");
  if (item && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectVoice(item.dataset.name); }
});

langSelect.addEventListener("change", () => {
  state.lang = langSelect.value; voiceSearch.value = ""; save(); renderVoices();
  const first = filteredVoices()[0];
  if (first) selectVoice(first.name);
});
voiceSearch.addEventListener("input", renderVoices);

document.querySelectorAll(".gender-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    state.gender = btn.dataset.g; save();
    document.querySelectorAll(".gender-btn").forEach((b) => b.classList.toggle("active", b === btn));
    renderVoices();
  })
);

$("copy-voice").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(state.voice); setStatus("已复制声音 ID", "ok"); }
  catch { setStatus("复制失败", "err"); }
});

// ---------- preview ----------
const previewCache = new Map();
let previewAudio = null;
async function previewVoice(name, btn) {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  const v = allVoices.find((x) => x.name === name);
  const base = name.slice(0, 2).toLowerCase();
  const text = SAMPLES[v?.code] || SAMPLES[base] || SAMPLES.en;
  btn?.classList.add("loading");
  setStatus(`正在试听 ${v ? v.chracter : name}…`);
  try {
    let url = previewCache.get(name);
    if (!url) {
      const { audio } = await new EdgeTTS(text, name).synthesize();
      url = URL.createObjectURL(audio);
      previewCache.set(name, url);
    }
    previewAudio = new Audio(url);
    previewAudio.onended = () => setStatus("");
    await previewAudio.play();
    setStatus(`正在试听 ${v ? v.chracter : name}`);
  } catch (err) {
    console.error(err);
    setStatus(`试听失败：${err.message || "请检查网络"}`, "err");
  } finally {
    btn?.classList.remove("loading");
  }
}

// ---------- sliders ----------
const signed = (n, unit) => (n >= 0 ? "+" : "") + n + unit;
function syncSliders() {
  rateSlider.value = state.rate; pitchSlider.value = state.pitch; volumeSlider.value = state.volume;
  rateLabel.textContent = (state.rate / 100).toFixed(2).replace(/0$/, "") + "x";
  pitchLabel.textContent = signed(state.pitch, " Hz");
  volumeLabel.textContent = signed(state.volume, "%");
}
[[rateSlider, "rate"], [pitchSlider, "pitch"], [volumeSlider, "volume"]].forEach(([el, key]) =>
  el.addEventListener("input", () => { state[key] = Number(el.value); save(); syncSliders(); })
);
$("reset-params").addEventListener("click", () => {
  state.rate = 100; state.pitch = 0; state.volume = 0; save(); syncSliders();
});

autoPlayCb.addEventListener("change", () => { state.autoPlay = autoPlayCb.checked; save(); });

// ---------- text ----------
function updateCount() {
  const n = textInput.value.length;
  const parts = n ? splitText(textInput.value).length : 0;
  charCount.textContent = parts > 1 ? `${n} 字 · 将分 ${parts} 段合成` : `${n} 字`;
}
let saveTimer;
textInput.addEventListener("input", () => {
  updateCount();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { state.text = textInput.value; save(); }, 400);
});
textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generate(); }
});
$("clear-text").addEventListener("click", () => { textInput.value = ""; state.text = ""; save(); updateCount(); textInput.focus(); });
$("sample-text").addEventListener("click", () => {
  textInput.value = "春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。\n\n这是一段示例文字。你可以调节语速、音调和音量，生成后可下载 MP3 音频和 SRT、VTT 字幕。";
  state.text = textInput.value; save(); updateCount();
});

// 按句子切分，单段不超过 CHUNK_LIMIT
function splitText(text) {
  text = text.trim();
  if (text.length <= CHUNK_LIMIT) return [text];
  const sentences = text.match(/[^。！？!?；;\n.]+[。！？!?；;\n.]*/g) || [text];
  const chunks = [];
  let cur = "";
  for (let s of sentences) {
    while (s.length > CHUNK_LIMIT) {
      if (cur) { chunks.push(cur); cur = ""; }
      chunks.push(s.slice(0, CHUNK_LIMIT));
      s = s.slice(CHUNK_LIMIT);
    }
    if ((cur + s).length > CHUNK_LIMIT) { chunks.push(cur); cur = s; }
    else cur += s;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.map((c) => c.trim()).filter(Boolean);
}

// ---------- offline engine ----------
const engines = {};
const getEngine = (id) => (engines[id] ||= new OfflineEngine(id));
const offlineStatus = $("offline-status");
const offlineAction = $("offline-action");
const offlineDelete = $("offline-delete");
const offlineBar = $("offline-bar");
const packSeg = $("pack-seg");
const offlineVoicesEl = $("offline-voices");
const netPill = $("net-pill");
const cachedPacks = new Set();
const mb = (n) => (n / 1048576).toFixed(0) + " MB";
const curPack = () => PACKS[state.offlinePack];
const curOfflineVoice = () => curPack().voices.find((v) => v.sid === state.offlineSid) || curPack().voices[0];
let offlineCached = false; // 是否至少有一个模型包已完整下载

function setOfflineUI(text, { action = null, del = false, progress = null } = {}) {
  offlineStatus.textContent = text;
  offlineAction.hidden = !action;
  if (action) offlineAction.innerHTML = action;
  offlineDelete.hidden = !del;
  offlineBar.parentElement.classList.toggle("on", progress != null);
  offlineBar.style.width = progress == null ? "0" : `${Math.round(progress * 100)}%`;
  icons();
}

function renderPacks() {
  packSeg.innerHTML = Object.values(PACKS).map((p) => `
    <button type="button" class="pack-btn${p.id === state.offlinePack ? " active" : ""}" data-p="${p.id}" role="radio" aria-checked="${p.id === state.offlinePack}">
      ${cachedPacks.has(p.id) ? '<span class="tag">已下载</span>' : ""}<b>${esc(p.name)}</b><small>${esc(p.desc)}</small>
    </button>`).join("");
  const pack = curPack();
  offlineVoicesEl.innerHTML = pack.voices.map((v) => `
    <div class="ovoice${v.sid === curOfflineVoice().sid ? " active" : ""}" data-sid="${v.sid}" role="radio" tabindex="0" aria-checked="${v.sid === curOfflineVoice().sid}">
      <span>${esc(v.name)}<small>${v.gender}</small></span>
      ${v.sample ? `<button type="button" class="play" data-sample="${v.sid}" title="试听"><i data-lucide="play"></i></button>` : ""}
    </div>`).join("");
  icons();
}

packSeg.addEventListener("click", (e) => {
  const b = e.target.closest(".pack-btn");
  if (!b || b.dataset.p === state.offlinePack) return;
  // 切换模型包时释放另一个包占用的内存
  Object.values(engines).forEach((en) => { if (en.pack.id !== b.dataset.p && en.ready) en.unload(); });
  state.offlinePack = b.dataset.p;
  state.offlineSid = PACKS[b.dataset.p].voices[0].sid;
  save();
  renderPacks();
  refreshOffline();
});

let sampleAudio = null;
offlineVoicesEl.addEventListener("click", (e) => {
  const playBtn = e.target.closest(".play");
  const item = e.target.closest(".ovoice");
  if (!item) return;
  const v = curPack().voices.find((x) => String(x.sid) === item.dataset.sid);
  if (playBtn) {
    e.stopPropagation();
    sampleAudio?.pause();
    sampleAudio = new Audio(sampleUrl(state.offlinePack, v));
    sampleAudio.play().catch(() => setStatus("试听需要联网（样音未缓存）", "err"));
  }
  state.offlineSid = v.sid;
  save();
  renderPacks();
});
offlineVoicesEl.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("ovoice")) { e.preventDefault(); e.target.click(); }
});

async function refreshOffline() {
  const eng = getEngine(state.offlinePack);
  if (!eng.supported) { setOfflineUI("当前浏览器不支持离线引擎"); return; }
  const sts = await Promise.all(Object.keys(PACKS).map(async (id) => [id, await getEngine(id).status()]));
  cachedPacks.clear();
  sts.forEach(([id, st]) => st.cached && cachedPacks.add(id));
  offlineCached = cachedPacks.size > 0;
  renderPacks();
  const st = Object.fromEntries(sts)[state.offlinePack];
  if (eng.ready) setOfflineUI(`已就绪 · ${curPack().name}`, { del: true });
  else if (st.cached) setOfflineUI(`已下载（${mb(st.size)}），断网可用`, { action: '<i data-lucide="cpu"></i> 预加载', del: true });
  else {
    const size = await eng.manifestSize();
    setOfflineUI("未下载。下载一次后，断网也能朗读任意文字。", { action: `<i data-lucide="download"></i> 下载${curPack().short}模型${size ? "（" + mb(size) + "）" : ""}` });
  }
}

function attachProgress(eng) {
  eng.onProgress = (p) => {
    if (eng.pack.id !== state.offlinePack) return;
    if (p.phase === "download") setOfflineUI(`下载中 ${mb(p.loaded)} / ${mb(p.total)}`, { progress: p.loaded / p.total });
    else if (p.phase === "init") setOfflineUI("正在初始化离线引擎…", { progress: 1 });
  };
}

async function loadOffline(packId = state.offlinePack) {
  const eng = getEngine(packId);
  attachProgress(eng);
  try {
    await eng.load();
  } finally {
    refreshOffline();
  }
  return eng;
}

offlineAction.addEventListener("click", () => loadOffline().catch((e) => setStatus(e.message, "err")));
offlineDelete.addEventListener("click", async () => {
  if (!confirm(`删除已下载的 ${curPack().name} 模型？删除后需联网重新下载。`)) return;
  await getEngine(state.offlinePack).remove();
  refreshOffline();
  setStatus("离线模型已删除", "ok");
});

function syncEngineUI() {
  document.querySelectorAll(".engine-btn").forEach((b) => b.classList.toggle("active", b.dataset.e === state.engine));
  document.body.classList.toggle("mode-offline", state.engine === "offline");
}
document.querySelectorAll(".engine-btn").forEach((b) =>
  b.addEventListener("click", () => { state.engine = b.dataset.e; save(); syncEngineUI(); })
);

function syncNet() {
  const on = navigator.onLine;
  netPill.classList.toggle("off", !on);
  netPill.lastChild.textContent = on ? " 在线" : " 离线";
}
window.addEventListener("online", syncNet);
window.addEventListener("offline", syncNet);

// ---------- generate ----------
const history = [];
let busy = false;

async function synthOnline(text, onPct) {
  const chunks = splitText(text);
  const opts = { rate: signed(state.rate - 100, "%"), pitch: signed(state.pitch, "Hz"), volume: signed(state.volume, "%") };
  const blobs = [];
  const subtitle = [];
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    setStatus(chunks.length > 1 ? `正在合成第 ${i + 1} / ${chunks.length} 段…` : "正在合成…");
    const { audio, subtitle: sub } = await new EdgeTTS(chunks[i], state.voice, opts).synthesize();
    sub.forEach((b) => subtitle.push({ ...b, Offset: b.Offset + offset }));
    offset += Math.round((audio.size / MP3_BYTES_PER_SEC) * 1e7);
    blobs.push(audio);
    onPct((i + 1) / chunks.length);
  }
  const audio = new Blob(blobs, { type: "audio/mpeg" });
  const v = allVoices.find((x) => x.name === state.voice);
  return {
    audio, ext: "mp3", engine: "在线",
    voice: v ? v.chracter : state.voice,
    vtt: createVTT(subtitle, text), srt: createSRT(subtitle, text),
    seconds: audio.size / MP3_BYTES_PER_SEC,
  };
}

async function synthOffline(text, onPct) {
  const sentences = splitSentences(text);
  if (!sentences.length) throw new Error("没有可朗读的文字");
  // 选中的模型包没下载、又没网时，退回到已下载的那个包
  let packId = state.offlinePack;
  if (!cachedPacks.has(packId) && !navigator.onLine && cachedPacks.size) packId = [...cachedPacks][0];
  const pack = PACKS[packId];
  const voice = packId === state.offlinePack ? curOfflineVoice() : pack.voices[0];
  const eng = getEngine(packId);
  if (!eng.ready) setStatus(cachedPacks.has(packId) ? "正在加载离线引擎…" : "首次使用，正在下载离线模型…");
  await loadOffline(packId);
  setStatus("离线合成中…");
  const { audio, cues, duration } = await eng.synthesize(
    sentences,
    { speed: state.rate / 100, gain: 1 + state.volume / 100, sid: voice.sid },
    (done, total) => { setStatus(`离线合成中 ${done} / ${total} 句…`); onPct(done / total); }
  );
  const voiceName = pack.voices.length > 1 ? `${pack.short} ${voice.name}` : `本地 ${pack.short}`;
  return { audio, ext: "wav", engine: "离线", voice: voiceName, vtt: cuesToVTT(cues), srt: cuesToSRT(cues), seconds: duration };
}

const isNetworkError = (err) => err instanceof TypeError || /无法连接|Failed to fetch|NetworkError|HTTP 5\d\d/.test(err?.message || "");

async function generate() {
  if (busy) return;
  const text = textInput.value.trim();
  if (!text) { setStatus("请输入要转换的文字", "err"); textInput.focus(); return; }

  busy = true;
  generateBtn.disabled = true;
  generateBtn.innerHTML = `<span class="spinner"></span> 生成中…`;
  setProgress(0);

  try {
    let r;
    const useOffline = state.engine === "offline" || (state.engine === "auto" && !navigator.onLine);
    if (useOffline) {
      if (!offlineCached && !navigator.onLine) throw new Error("当前离线，且尚未下载离线模型。请联网后在“离线引擎”里下载一次。");
      r = await synthOffline(text, setProgress);
    } else {
      if (!state.voice) throw new Error("请选择声音");
      try {
        r = await synthOnline(text, setProgress);
      } catch (err) {
        if (state.engine === "auto" && offlineCached && isNetworkError(err)) {
          setStatus("在线服务不可用，已切换到离线引擎…");
          setProgress(0);
          r = await synthOffline(text, setProgress);
        } else throw err;
      }
    }

    const entry = {
      id: Date.now(),
      voice: r.voice, engine: r.engine, ext: r.ext,
      snippet: text.slice(0, 40),
      ts: new Date().toISOString().slice(0, 19).replace(/[-:T]/g, ""),
      audioUrl: URL.createObjectURL(r.audio),
      vttUrl: URL.createObjectURL(new Blob([r.vtt], { type: "text/vtt" })),
      srtUrl: URL.createObjectURL(new Blob([r.srt], { type: "text/plain" })),
      size: r.audio.size,
    };
    history.unshift(entry);
    history.splice(HISTORY_MAX).forEach((h) => [h.audioUrl, h.vttUrl, h.srtUrl].forEach(URL.revokeObjectURL));
    showResult(entry);
    renderHistory();
    setStatus(`${r.engine}生成完成 · ${(entry.size / 1024).toFixed(0)} KB · 约 ${Math.round(r.seconds)} 秒`, "ok");
  } catch (err) {
    console.error(err);
    audioPanel.innerHTML = `<p class="placeholder err">生成失败：${esc(err.message || "请检查网络后重试")}</p>`;
    setStatus("生成失败", "err");
  } finally {
    busy = false;
    setTimeout(() => setProgress(null), 600);
    generateBtn.disabled = false;
    generateBtn.innerHTML = `<i data-lucide="sparkles"></i> 生成音频 <kbd>Ctrl ↵</kbd>`;
    icons();
  }
}
generateBtn.addEventListener("click", generate);

function showResult(e, play = state.autoPlay) {
  audioPanel.innerHTML = `
    <audio controls id="result-audio" src="${e.audioUrl}"></audio>
    <div class="dl-row">
      <a class="dl-btn dl-mp3" href="${e.audioUrl}" download="edge-tts-${e.ts}.${e.ext}"><i data-lucide="download"></i> ${e.ext.toUpperCase()}</a>
      <a class="dl-btn dl-srt" href="${e.srtUrl}" download="edge-tts-${e.ts}.srt"><i data-lucide="captions"></i> SRT</a>
      <a class="dl-btn dl-vtt" href="${e.vttUrl}" download="edge-tts-${e.ts}.vtt"><i data-lucide="file-text"></i> VTT</a>
    </div>`;
  icons();
  if (play) $("result-audio").play().catch(() => {});
}

function renderHistory() {
  historyBox.hidden = history.length === 0;
  historyList.innerHTML = history
    .map((h) => `
      <button type="button" class="history-item" data-id="${h.id}">
        <i data-lucide="play-circle"></i>
        <span class="h-text">${esc(h.snippet)}${h.snippet.length >= 40 ? "…" : ""}</span>
        <span class="h-meta">${esc(h.engine)} · ${esc(h.voice)} · ${h.ts.slice(8, 10)}:${h.ts.slice(10, 12)}</span>
      </button>`)
    .join("");
  icons();
}
historyList.addEventListener("click", (e) => {
  const item = e.target.closest(".history-item");
  const h = item && history.find((x) => String(x.id) === item.dataset.id);
  if (h) showResult(h, true);
});

// ---------- init ----------
syncEngineUI();
syncNet();
refreshOffline();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
populateLangs();
document.querySelectorAll(".gender-btn").forEach((b) => b.classList.toggle("active", b.dataset.g === state.gender));
autoPlayCb.checked = state.autoPlay;
textInput.value = state.text || "";
syncSliders();
updateCount();
renderVoices();
if (!allVoices.some((v) => v.name === state.voice)) state.voice = filteredVoices()[0]?.name || "zh-CN-YunjianNeural";
selectVoice(state.voice, true);
icons();
