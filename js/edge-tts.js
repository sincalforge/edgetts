/**
 * Edge TTS client for Cloudflare Pages.
 * Speech synthesis is performed by the same-origin /api/tts Function because
 * browsers cannot supply the upstream Origin, Cookie, and User-Agent headers.
 */
class EdgeTTS {
  constructor(text, voice = "zh-CN-YunjianNeural", options = {}) {
    this.text = text;
    this.voice = voice;
    this.rate = options.rate || "+0%";
    this.volume = options.volume || "+0%";
    this.pitch = options.pitch || "+0Hz";
  }

  async synthesize() {
    let response;
    try {
      response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: this.text,
          voice: this.voice,
          rate: this.rate,
          volume: this.volume,
          pitch: this.pitch,
        }),
      });
    } catch {
      throw new Error("无法连接到本站语音服务。请检查 Pages Functions 是否已部署。");
    }

    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`语音服务返回了无效响应（HTTP ${response.status}）。`);
    }
    if (!response.ok) {
      throw new Error(body.detail || body.error || `语音服务请求失败（HTTP ${response.status}）。`);
    }
    if (typeof body.audio !== "string" || !Array.isArray(body.subtitle)) {
      throw new Error("语音服务没有返回有效的音频数据。");
    }

    return {
      audio: new Blob([base64ToBytes(body.audio)], { type: "audio/mpeg" }),
      subtitle: body.subtitle,
    };
  }
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function formatVTTTime(ticks) {
  const totalSeconds = Math.floor(ticks / 1e7);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ms = Math.floor((ticks % 1e7) / 1e4);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(ms, 3)}`;
}

function formatSRTTime(ticks) {
  const totalSeconds = Math.floor(ticks / 1e7);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ms = Math.floor((ticks % 1e7) / 1e4);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(ms, 3)}`;
}

function pad(n, len = 2) {
  return String(n).padStart(len, "0");
}

function createVTT(boundaries, originalText = null) {
  let vtt = "WEBVTT\n\n";
  if (originalText) {
    const sentences = originalText.split(/[。，,.\n]/).filter((sentence) => sentence.trim());
    let index = 0;
    sentences.forEach((sentence, sentenceIndex) => {
      if (index >= boundaries.length) return;
      let start = null;
      let end = null;
      let characterIndex = 0;
      const characters = sentence.trim().split("");
      while (characterIndex < characters.length && index < boundaries.length) {
        const word = boundaries[index].text;
        const remaining = characters.slice(characterIndex).join("");
        const position = remaining.indexOf(word);
        if (position !== -1) {
          if (start === null) start = formatVTTTime(boundaries[index].Offset);
          characterIndex += position + word.length;
          end = formatVTTTime(boundaries[index].Offset + boundaries[index].Duration);
        }
        index += 1;
      }
      if (start && end) vtt += `${sentenceIndex + 1}\n${start} --> ${end}\n${sentence.trim()}\n\n`;
    });
  } else {
    boundaries.forEach((boundary, index) => {
      const start = formatVTTTime(boundary.Offset);
      const end = formatVTTTime(boundary.Offset + boundary.Duration);
      vtt += `${index + 1}\n${start} --> ${end}\n${boundary.text}\n\n`;
    });
  }
  return vtt;
}

function createSRT(boundaries, originalText = null) {
  let srt = "";
  if (originalText) {
    const sentences = originalText.split(/[。，,.\n]/).filter((sentence) => sentence.trim());
    let index = 0;
    sentences.forEach((sentence, sentenceIndex) => {
      if (index >= boundaries.length) return;
      let start = null;
      let end = null;
      let characterIndex = 0;
      const characters = sentence.trim().split("");
      while (characterIndex < characters.length && index < boundaries.length) {
        const word = boundaries[index].text;
        const remaining = characters.slice(characterIndex).join("");
        const position = remaining.indexOf(word);
        if (position !== -1) {
          if (start === null) start = formatSRTTime(boundaries[index].Offset);
          characterIndex += position + word.length;
          end = formatSRTTime(boundaries[index].Offset + boundaries[index].Duration);
        }
        index += 1;
      }
      if (start && end) srt += `${sentenceIndex + 1}\n${start} --> ${end}\n${sentence.trim()}\n\n`;
    });
  } else {
    boundaries.forEach((boundary, index) => {
      const start = formatSRTTime(boundary.Offset);
      const end = formatSRTTime(boundary.Offset + boundary.Duration);
      srt += `${index + 1}\n${start} --> ${end}\n${boundary.text}\n\n`;
    });
  }
  return srt;
}

export { EdgeTTS, createVTT, createSRT };
