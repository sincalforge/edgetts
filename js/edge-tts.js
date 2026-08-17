/**
 * Edge TTS Client - Microsoft Edge Online TTS via WebSocket
 * Compatible with browser environment, no API key required.
 */
class EdgeTTS {
  constructor(text, voice = "zh-CN-YunjianNeural", options = {}) {
    this.text = text;
    this.voice = voice;
    this.rate = options.rate || "+0%";
    this.volume = options.volume || "+0%";
    this.pitch = options.pitch || "+0Hz";
    this.TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    this.BASE_URL = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
    this.WSS_URL = `wss://${this.BASE_URL}/edge/v1`;
    this.CHROMIUM_FULL_VERSION = "130.0.2849.68";
    this.SEC_MS_GEC_VERSION = `1-${this.CHROMIUM_FULL_VERSION}`;
    this.WIN_EPOCH = 11644473600;
  }

  async connect() {
    const connectionId = this.generateConnectionId();
    const secMsGec = await this.generateSecMsGec();
    const url = `${this.WSS_URL}?TrustedClientToken=${this.TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${this.SEC_MS_GEC_VERSION}&ConnectionId=${connectionId}`;
    this.ws = new WebSocket(url);
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
    });
  }

  async synthesize() {
    await this.connect();
    this.ws.send(this.createSpeechConfig());
    this.ws.send(this.createSSML());
    return new Promise((resolve, reject) => {
      const audioChunks = [];
      let wordBoundaries = [];

      this.ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          const parts = event.data.split("\r\n\r\n");
          const headers = parts[0];
          const body = parts[1];
          const headerLines = headers.split("\r\n");
          const headerMap = {};
          headerLines.forEach((line) => {
            const [key, value] = line.split(":", 2);
            if (key && value !== undefined) headerMap[key.trim()] = value.trim();
          });

          if (headerMap.Path === "audio.metadata") {
            try {
              const meta = JSON.parse(body);
              if (meta.Metadata && Array.isArray(meta.Metadata)) {
                const boundaries = meta.Metadata
                  .map((m) =>
                    m.Type === "WordBoundary" && m.Data
                      ? {
                          Offset: m.Data.Offset,
                          Duration: m.Data.Duration,
                          text: m.Data.text.Text,
                        }
                      : null
                  )
                  .filter(Boolean);
                wordBoundaries = wordBoundaries.concat(boundaries);
              }
            } catch (e) {}
          } else if (headerMap.Path === "turn.end") {
            this.ws.close();
          }
        } else {
          const reader = new FileReader();
          reader.onload = () => {
            const buffer = new Uint8Array(reader.result);
            const headerLen = (buffer[0] << 8) | buffer[1] + 2;
            if (headerLen > buffer.length) return;
            const headerBytes = buffer.slice(0, headerLen);
            const headerStr = new TextDecoder().decode(headerBytes);
            const hMap = {};
            headerStr.split("\r\n").forEach((line) => {
              const parts = line.split(":", 2);
              if (parts.length === 2) hMap[parts[0].trim()] = parts[1].trim();
            });
            if (hMap.Path !== "audio") return;
            const contentType = hMap["Content-Type"];
            if (contentType !== "audio/mpeg" && contentType !== undefined) return;
            const audioData = buffer.slice(headerLen);
            if (audioData.length > 0) audioChunks.push(audioData);
          };
          reader.readAsArrayBuffer(event.data);
        }
      };

      this.ws.onclose = () => {
        const blob = new Blob(audioChunks, { type: "audio/mpeg" });
        resolve({ audio: blob, subtitle: wordBoundaries });
      };
      this.ws.onerror = (err) => reject(err);
    });
  }

  createSpeechConfig() {
    const config = {
      context: {
        synthesis: {
          audio: {
            metadataoptions: {
              sentenceBoundaryEnabled: false,
              wordBoundaryEnabled: true,
            },
            outputFormat: "audio-24khz-48kbitrate-mono-mp3",
          },
        },
      },
    };
    return (
      `X-Timestamp:${this.getTimestamp()}\r\n` +
      `Content-Type:application/json; charset=utf-8\r\n` +
      `Path:speech.config\r\n\r\n` +
      JSON.stringify(config)
    );
  }

  createSSML() {
    const ssml =
      `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
      `<voice name='${this.voice}'>` +
      `<prosody rate='${this.rate}' volume='${this.volume}' pitch='${this.pitch}'>` +
      `${this.escapeXml(this.text)}` +
      `</prosody></voice></speak>`;
    return (
      `X-RequestId:${this.generateConnectionId()}\r\n` +
      `Content-Type:application/ssml+xml\r\n` +
      `X-Timestamp:${this.getTimestamp()}Z\r\n` +
      `Path:ssml\r\n\r\n` +
      ssml
    );
  }

  generateConnectionId() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
      .replace(/[xy]/g, function (c) {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 3) | 8).toString(16);
      })
      .replaceAll("-", "")
      .toUpperCase();
  }

  getTimestamp() {
    return new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  }

  escapeXml(str) {
    return str.replace(/[<>&'"]/g, (c) => {
      switch (c) {
        case "<": return "&lt;";
        case ">": return "&gt;";
        case "&": return "&amp;";
        case "'": return "&apos;";
        case '"': return "&quot;";
        default: return c;
      }
    });
  }

  async generateSecMsGec() {
    if (!crypto?.subtle) throw new Error("Browser does not support Web Crypto");
    const ticks = Math.floor(Date.now() / 1000);
    let windowsTicks = ticks + this.WIN_EPOCH;
    windowsTicks -= windowsTicks % 300;
    windowsTicks = Math.floor(windowsTicks * 1e7);
    const str = `${windowsTicks}${this.TRUSTED_CLIENT_TOKEN}`;
    const data = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }
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
    const sentences = originalText.split(/[。，,.\n]/).filter((s) => s.trim());
    let idx = 0;
    sentences.forEach((sentence, i) => {
      if (idx >= boundaries.length) return;
      let start = null, end = null;
      let charIdx = 0;
      const chars = sentence.trim().split("");
      while (charIdx < chars.length && idx < boundaries.length) {
        const word = boundaries[idx].text;
        const remaining = chars.slice(charIdx).join("");
        const pos = remaining.indexOf(word);
        if (pos !== -1) {
          if (start === null) start = formatVTTTime(boundaries[idx].Offset);
          charIdx += pos + word.length;
          end = formatVTTTime(boundaries[idx].Offset + boundaries[idx].Duration);
        }
        idx++;
      }
      if (start && end) {
        vtt += `${i + 1}\n${start} --> ${end}\n${sentence.trim()}\n\n`;
      }
    });
  } else {
    boundaries.forEach((b, i) => {
      const start = formatVTTTime(b.Offset);
      const end = formatVTTTime(b.Offset + b.Duration);
      vtt += `${i + 1}\n${start} --> ${end}\n${b.text}\n\n`;
    });
  }
  return vtt;
}

function createSRT(boundaries, originalText = null) {
  let srt = "";
  if (originalText) {
    const sentences = originalText.split(/[。，,.\n]/).filter((s) => s.trim());
    let idx = 0;
    sentences.forEach((sentence, i) => {
      if (idx >= boundaries.length) return;
      let start = null, end = null;
      let charIdx = 0;
      const chars = sentence.trim().split("");
      while (charIdx < chars.length && idx < boundaries.length) {
        const word = boundaries[idx].text;
        const remaining = chars.slice(charIdx).join("");
        const pos = remaining.indexOf(word);
        if (pos !== -1) {
          if (start === null) start = formatSRTTime(boundaries[idx].Offset);
          charIdx += pos + word.length;
          end = formatSRTTime(boundaries[idx].Offset + boundaries[idx].Duration);
        }
        idx++;
      }
      if (start && end) {
        srt += `${i + 1}\n${start} --> ${end}\n${sentence.trim()}\n\n`;
      }
    });
  } else {
    boundaries.forEach((b, i) => {
      const start = formatSRTTime(b.Offset);
      const end = formatSRTTime(b.Offset + b.Duration);
      srt += `${i + 1}\n${start} --> ${end}\n${b.text}\n\n`;
    });
  }
  return srt;
}

export { EdgeTTS, createVTT, createSRT };
