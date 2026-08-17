import { EdgeTTS, createVTT, createSRT } from "./edge-tts.js";
import voices from "./voices.js";

let currentLang = "zh";
let currentGender = "male";
let currentVoice = null;
let currentRate = "+0%";
let autoPlay = true;

const langNames = {};
Object.keys(voices).forEach((code) => {
  const sample = voices[code].male?.[0] || voices[code].female?.[0];
  if (sample) langNames[code] = sample.language || code;
});

const sortedLangs = Object.keys(voices).sort((a, b) => {
  if (a === "zh") return -1;
  if (b === "zh") return 1;
  return (langNames[a] || a).localeCompare(langNames[b] || b, "zh");
});

const langSelect = document.getElementById("lang-select");
const voiceList = document.getElementById("voice-list");
const textInput = document.getElementById("text-input");
const generateBtn = document.getElementById("generate-btn");
const audioPanel = document.getElementById("audio-panel");
const autoPlayCb = document.getElementById("auto-play");
const genderMale = document.getElementById("gender-male");
const genderFemale = document.getElementById("gender-female");
const rateSlider = document.getElementById("rate-slider");
const rateLabel = document.getElementById("rate-label");
const charCount = document.getElementById("char-count");
const voiceCount = document.getElementById("voice-count");
const currentVoiceLabel = document.getElementById("current-voice-label");
const statusEl = document.getElementById("status");

function setStatus(msg, isErr = false) {
  statusEl.textContent = msg || "";
  statusEl.className = "status" + (isErr ? " err" : "");
}

function populateLangs() {
  langSelect.innerHTML = "";
  sortedLangs.forEach((code) => {
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = langNames[code] || code;
    if (code === currentLang) opt.selected = true;
    langSelect.appendChild(opt);
  });
}

langSelect.addEventListener("change", () => {
  currentLang = langSelect.value;
  renderVoices();
});

function setGender(g) {
  currentGender = g;
  genderMale.classList.toggle("active", g === "male");
  genderFemale.classList.toggle("active", g === "female");
  renderVoices();
}
genderMale.addEventListener("click", () => setGender("male"));
genderFemale.addEventListener("click", () => setGender("female"));

function renderVoices() {
  const list = voices[currentLang]?.[currentGender] || [];
  voiceList.innerHTML = "";
  if (list.length === 0) {
    voiceList.innerHTML = '<p class="muted" style="padding:8px;text-align:center">暂无该性别声音</p>';
    currentVoice = null;
    currentVoiceLabel.textContent = "—";
    voiceCount.textContent = "0 个声音";
    return;
  }
  list.forEach((v, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "voice-item" + (i === 0 ? " active" : "");
    const region = v.region ? ` · ${v.region}` : "";
    const langExtra = v.lang ? ` · ${v.lang}` : "";
    btn.innerHTML = `
      <span>${v.gender === "Male" ? "♂" : "♀"}</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${v.chracter}${langExtra}${region}</span>
      <span class="preview" title="试听">▶</span>
    `;
    btn.dataset.name = v.name;
    btn.dataset.label = `${v.chracter}${langExtra}${region}`;
    btn.addEventListener("click", (e) => {
      if (e.target.closest(".preview")) {
        e.stopPropagation();
        previewVoice(v.name);
        return;
      }
      document.querySelectorAll(".voice-item").forEach((el) => el.classList.remove("active"));
      btn.classList.add("active");
      currentVoice = v.name;
      currentVoiceLabel.textContent = btn.dataset.label;
    });
    voiceList.appendChild(btn);
  });
  currentVoice = list[0].name;
  currentVoiceLabel.textContent = `${list[0].chracter}${list[0].lang ? " · " + list[0].lang : ""}${list[0].region ? " · " + list[0].region : ""}`;
  voiceCount.textContent = `${list.length} 个声音 · 共 318 个模型`;
}

async function previewVoice(voiceName) {
  setStatus("试听中…");
  try {
    const tts = new EdgeTTS("你好，这是声音预览。Hello, this is a voice preview.", voiceName, { rate: "+0%" });
    const { audio } = await tts.synthesize();
    const url = URL.createObjectURL(audio);
    const a = new Audio(url);
    a.onended = () => setStatus("");
    a.play();
    setStatus("正在试听");
  } catch (err) {
    console.error(err);
    setStatus("试听失败，请检查网络", true);
  }
}

function rateToPercent(sliderVal) {
  // slider 50-300 maps to -50% .. +200%
  const pct = sliderVal - 100;
  return (pct >= 0 ? "+" : "") + pct + "%";
}
function rateToLabel(sliderVal) {
  return (sliderVal / 100).toFixed(1) + "x";
}

rateSlider.addEventListener("input", () => {
  currentRate = rateToPercent(Number(rateSlider.value));
  rateLabel.textContent = rateToLabel(Number(rateSlider.value));
});

autoPlayCb.addEventListener("change", () => {
  autoPlay = autoPlayCb.checked;
});

textInput.addEventListener("input", () => {
  charCount.textContent = textInput.value.length + " 字";
});

generateBtn.addEventListener("click", async () => {
  const text = textInput.value.trim();
  if (!text) {
    setStatus("请输入要转换的文字", true);
    return;
  }
  if (!currentVoice) {
    setStatus("请选择声音", true);
    return;
  }

  generateBtn.disabled = true;
  generateBtn.innerHTML = `<svg style="width:16px;height:16px;animation:spin 1s linear infinite" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" opacity="0.25"/><path d="M4 12a8 8 0 018-8" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg> 生成中…`;
  setStatus("正在连接 Edge TTS…");

  try {
    const tts = new EdgeTTS(text, currentVoice, { rate: currentRate });
    const { audio, subtitle } = await tts.synthesize();

    const audioUrl = URL.createObjectURL(audio);
    const vttContent = createVTT(subtitle, text);
    const srtContent = createSRT(subtitle, text);
    const vttUrl = URL.createObjectURL(new Blob([vttContent], { type: "text/vtt" }));
    const srtUrl = URL.createObjectURL(new Blob([srtContent], { type: "text/plain" }));
    const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");

    audioPanel.innerHTML = `
      <audio controls id="result-audio" src="${audioUrl}"></audio>
      <div class="dl-row">
        <a class="dl-btn dl-mp3" href="${audioUrl}" download="edge-tts-${ts}.mp3">⬇ MP3</a>
        <a class="dl-btn dl-vtt" href="${vttUrl}" download="edge-tts-${ts}.vtt">⬇ VTT</a>
        <a class="dl-btn dl-srt" href="${srtUrl}" download="edge-tts-${ts}.srt">⬇ SRT</a>
      </div>
    `;

    if (autoPlay) {
      const audioEl = document.getElementById("result-audio");
      audioEl.play().catch(() => {});
    }
    setStatus("生成完成");
  } catch (err) {
    console.error(err);
    audioPanel.innerHTML = `<p class="muted" style="margin:0;text-align:center;color:#ff8a8a">生成失败：${err.message || "请检查网络后重试"}</p>`;
    setStatus("生成失败", true);
  } finally {
    generateBtn.disabled = false;
    generateBtn.innerHTML = `<i data-lucide="play" style="width:16px;height:16px"></i> 生成音频`;
    if (window.lucide) lucide.createIcons();
  }
});

// spin keyframes
const style = document.createElement("style");
style.textContent = `@keyframes spin{to{transform:rotate(360deg)}}`;
document.head.appendChild(style);

populateLangs();
setGender("male");
renderVoices();
if (window.lucide) lucide.createIcons();
