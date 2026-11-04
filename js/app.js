import { EdgeTTS, createVTT, createSRT } from "./edge-tts.js";
import voices from "./voices.js";

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
  rate: 100, pitch: 0, volume: 0, autoPlay: true, text: "",
};
let state = { ...defaults };
try { Object.assign(state, JSON.parse(localStorage.getItem(STORE_KEY) || "{}")); } catch {}
if (!voices[state.lang]) state.lang = "zh";
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

// ---------- generate ----------
const history = [];
let busy = false;

async function generate() {
  if (busy) return;
  const text = textInput.value.trim();
  if (!text) { setStatus("请输入要转换的文字", "err"); textInput.focus(); return; }
  if (!state.voice) { setStatus("请选择声音", "err"); return; }

  busy = true;
  generateBtn.disabled = true;
  generateBtn.innerHTML = `<span class="spinner"></span> 生成中…`;
  const chunks = splitText(text);
  const opts = { rate: signed(state.rate - 100, "%"), pitch: signed(state.pitch, "Hz"), volume: signed(state.volume, "%") };
  setProgress(0);

  try {
    const blobs = [];
    const subtitle = [];
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      setStatus(chunks.length > 1 ? `正在合成第 ${i + 1} / ${chunks.length} 段…` : "正在合成…");
      const { audio, subtitle: sub } = await new EdgeTTS(chunks[i], state.voice, opts).synthesize();
      sub.forEach((b) => subtitle.push({ ...b, Offset: b.Offset + offset }));
      offset += Math.round((audio.size / MP3_BYTES_PER_SEC) * 1e7);
      blobs.push(audio);
      setProgress((i + 1) / chunks.length);
    }
    const audio = new Blob(blobs, { type: "audio/mpeg" });
    const v = allVoices.find((x) => x.name === state.voice);
    const entry = {
      id: Date.now(),
      voice: v ? v.chracter : state.voice,
      snippet: text.slice(0, 40),
      ts: new Date().toISOString().slice(0, 19).replace(/[-:T]/g, ""),
      audioUrl: URL.createObjectURL(audio),
      vttUrl: URL.createObjectURL(new Blob([createVTT(subtitle, text)], { type: "text/vtt" })),
      srtUrl: URL.createObjectURL(new Blob([createSRT(subtitle, text)], { type: "text/plain" })),
      size: audio.size,
    };
    history.unshift(entry);
    history.splice(HISTORY_MAX).forEach((h) => [h.audioUrl, h.vttUrl, h.srtUrl].forEach(URL.revokeObjectURL));
    showResult(entry);
    renderHistory();
    setStatus(`生成完成 · ${(entry.size / 1024).toFixed(0)} KB · 约 ${Math.round(entry.size / MP3_BYTES_PER_SEC)} 秒`, "ok");
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
      <a class="dl-btn dl-mp3" href="${e.audioUrl}" download="edge-tts-${e.ts}.mp3"><i data-lucide="download"></i> MP3</a>
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
        <span class="h-meta">${esc(h.voice)} · ${h.ts.slice(8, 10)}:${h.ts.slice(10, 12)}</span>
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
