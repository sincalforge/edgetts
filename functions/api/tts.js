const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const BASE_URL = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
const UPSTREAM_ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const DEFAULT_CHROMIUM_VERSION = "143.0.3650.75";
const MAX_TEXT_LENGTH = 3000;
const REQUEST_TIMEOUT_MS = 45_000;

export async function onRequestPost(context) {
  let payload;
  try {
    payload = await context.request.json();
  } catch {
    return json({ error: "请求体必须是 JSON。" }, 400);
  }

  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const voice = typeof payload.voice === "string" ? payload.voice.trim() : "";
  const rate = normalizeProsodyValue(payload.rate, "+0%", /^[+-]\d{1,3}%$/);
  const volume = normalizeProsodyValue(payload.volume, "+0%", /^[+-]\d{1,3}%$/);
  const pitch = normalizeProsodyValue(payload.pitch, "+0Hz", /^[+-]\d{1,3}Hz$/);

  if (!text) return json({ error: "请输入要转换的文字。" }, 400);
  if (text.length > MAX_TEXT_LENGTH) {
    return json({ error: `单次最多支持 ${MAX_TEXT_LENGTH} 个字符。` }, 413);
  }
  if (!/^[A-Za-z]{2,3}-[A-Za-z]{2,4}(?:-[A-Za-z]+)?-[A-Za-z0-9]+Neural$/.test(voice)) {
    return json({ error: "声音参数无效。" }, 400);
  }

  try {
    const result = await synthesize({
      text,
      voice,
      rate,
      volume,
      pitch,
      chromiumVersion: context.env.EDGE_TTS_CHROMIUM_VERSION || DEFAULT_CHROMIUM_VERSION,
    });
    return json({ audio: bytesToBase64(result.audio), subtitle: result.subtitle });
  } catch (error) {
    console.error("Edge TTS synthesis failed", error);
    return json(
      {
        error: "语音服务暂时不可用。请稍后重试。",
        detail: error instanceof Error ? error.message : "Unknown upstream error",
      },
      502,
    );
  }
}

function normalizeProsodyValue(value, fallback, pattern) {
  return typeof value === "string" && pattern.test(value) ? value : fallback;
}

async function synthesize({ text, voice, rate, volume, pitch, chromiumVersion }) {
  const connectionId = crypto.randomUUID().replaceAll("-", "").toUpperCase();
  const secMsGec = generateSecMsGec();
  // Workers 通过 HTTPS fetch 加 Upgrade: websocket 建立远程 WebSocket；fetch(wss://...) 会被运行时拒绝。
  const url = new URL(`https://${BASE_URL}/edge/v1`);
  url.searchParams.set("TrustedClientToken", TRUSTED_CLIENT_TOKEN);
  url.searchParams.set("ConnectionId", connectionId);
  url.searchParams.set("Sec-MS-GEC", secMsGec);
  url.searchParams.set("Sec-MS-GEC-Version", `2-${chromiumVersion}`);

  const chromiumMajor = chromiumVersion.split(".", 1)[0];
  const upstream = await fetch(url, {
    headers: {
      Upgrade: "websocket",
      Origin: UPSTREAM_ORIGIN,
      "Sec-WebSocket-Version": "13",
      "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumMajor}.0.0.0 Safari/537.36 Edg/${chromiumMajor}.0.0.0`,
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Cookie: `muid=${randomHex(16)};`,
    },
  });

  if (!upstream.webSocket) {
    throw new Error(`上游 WebSocket 握手被拒绝（HTTP ${upstream.status}）。`);
  }

  const ws = upstream.webSocket;
  ws.binaryType = "arraybuffer";
  ws.accept();

  const audioChunks = [];
  const subtitle = [];
  let done;
  let fail;
  const completed = new Promise((resolve, reject) => {
    done = resolve;
    fail = reject;
  });
  const timeout = setTimeout(() => fail(new Error("上游语音服务响应超时。")), REQUEST_TIMEOUT_MS);
  let settled = false;

  const settle = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    callback(value);
  };

  ws.addEventListener("message", async (event) => {
    try {
      if (typeof event.data === "string") {
        const { path, body } = splitTextFrame(event.data);
        if (path === "audio.metadata") {
          const metadata = JSON.parse(body);
          for (const item of metadata.Metadata || []) {
            if (item.Type === "WordBoundary" && item.Data) {
              subtitle.push({
                Offset: item.Data.Offset,
                Duration: item.Data.Duration,
                text: item.Data.text?.Text || "",
              });
            }
          }
        } else if (path === "turn.end") {
          settle(done);
          ws.close(1000, "turn completed");
        }
        return;
      }

      const frame = event.data instanceof ArrayBuffer ? event.data : await event.data.arrayBuffer();
      const audio = extractAudioFrame(new Uint8Array(frame));
      if (audio) audioChunks.push(audio);
    } catch (error) {
      settle(fail, error);
      ws.close(1011, "frame parse failed");
    }
  });

  ws.addEventListener("error", () => {
    settle(fail, new Error("上游 WebSocket 连接错误。"));
  });

  ws.addEventListener("close", (event) => {
    if (!settled) {
      settle(fail, new Error(`上游连接意外关闭（${event.code || 1006}）。`));
    }
  });

  ws.send(createSpeechConfig());
  ws.send(createSsml({ text, voice, rate, volume, pitch }));
  await completed;

  if (!audioChunks.length) throw new Error("上游未返回音频数据。");
  return { audio: concatBytes(audioChunks), subtitle };
}

function createSpeechConfig() {
  return [
    `X-Timestamp:${edgeTimestamp()}`,
    "Content-Type:application/json; charset=utf-8",
    "Path:speech.config",
    "",
    JSON.stringify({
      context: {
        synthesis: {
          audio: {
            metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: true },
            outputFormat: "audio-24khz-48kbitrate-mono-mp3",
          },
        },
      },
    }),
  ].join("\r\n");
}

function createSsml({ text, voice, rate, volume, pitch }) {
  return [
    `X-RequestId:${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`,
    "Content-Type:application/ssml+xml",
    `X-Timestamp:${edgeTimestamp()}Z`,
    "Path:ssml",
    "",
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${voice}'><prosody rate='${rate}' volume='${volume}' pitch='${pitch}'>${escapeXml(text)}</prosody></voice></speak>`,
  ].join("\r\n");
}

function splitTextFrame(frame) {
  const separator = "\r\n\r\n";
  const index = frame.indexOf(separator);
  const headers = index === -1 ? frame : frame.slice(0, index);
  const body = index === -1 ? "" : frame.slice(index + separator.length);
  const path = headers
    .split("\r\n")
    .map((line) => line.split(":", 2))
    .find(([key]) => key.trim().toLowerCase() === "path")?.[1]
    ?.trim();
  return { path, body };
}

function extractAudioFrame(frame) {
  if (frame.byteLength < 2) return null;
  const headerLength = (frame[0] << 8) | frame[1];
  if (headerLength + 2 > frame.byteLength) throw new Error("收到格式错误的音频帧。");
  const headers = new TextDecoder().decode(frame.slice(2, headerLength + 2));
  const path = headers
    .split("\r\n")
    .map((line) => line.split(":", 2))
    .find(([key]) => key.trim().toLowerCase() === "path")?.[1]
    ?.trim();
  const contentType = headers
    .split("\r\n")
    .map((line) => line.split(":", 2))
    .find(([key]) => key.trim().toLowerCase() === "content-type")?.[1]
    ?.trim();
  if (path !== "audio" || contentType !== "audio/mpeg") return null;
  return frame.slice(headerLength + 2);
}

// ---- Sec-MS-GEC v2 token (ported from rany2/edge-tts 7.3.x drm.py) ----
const WIN_EPOCH = 11_644_473_600;
const SHA256_INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const SHA256_STATE = [0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2];
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0,
  0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA256_ADJUSTMENT = 0xc9dc06a7;
const SHA256_BLOCK_K = [...SHA256_K.slice(0, 14), SHA256_ADJUSTMENT, ...SHA256_K.slice(15)];
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80;
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0;
const CS64_COEFFICIENTS = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038], [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c], [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da], [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

const u32 = (value) => value >>> 0;
const add = (...values) => values.reduce((sum, value) => (sum + value) >>> 0, 0);
const mul = (a, b) => Math.imul(a, b) >>> 0;
const rotr = (value, bits) => ((value >>> bits) | (value << (32 - bits))) >>> 0;
const rol16 = (value) => rotr(value, 16);
const sigma0 = (x) => (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
const sigma1 = (x) => (rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10)) >>> 0;

function sha256Rounds(state, words, firstRound = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  const k = firstRound === 14 ? SHA256_BLOCK_K : SHA256_K;
  for (let i = firstRound; i < 64; i += 1) {
    const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const ch = (g ^ (e & (f ^ g))) >>> 0;
    const t1 = add(h, s1, ch, k[i], words[i]);
    const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const maj = ((a & b) | (c & (a | b))) >>> 0;
    const t2 = add(s0, maj);
    h = g; g = f; f = e; e = add(d, t1); d = c; c = b; b = a; a = add(t1, t2);
  }
  return [a, b, c, d, e, f, g, h];
}

function expandSchedule(words, firstWord = 16) {
  for (let i = firstWord; i < 64; i += 1) {
    words.push(add(sigma1(words[i - 2]), words[i - 7], sigma0(words[i - 15]), words[i - 16]));
  }
}

function readU32BE(bytes, offset, length = 4) {
  let value = 0;
  for (let i = 0; i < length; i += 1) value = value * 256 + (bytes[offset + i] ?? 0);
  return value >>> 0;
}

function sha256Init(data7) {
  const words = new Array(14).fill(0);
  words.push(readU32BE(data7, 0, 3));
  words.push(readU32BE(data7, 3, 4));
  for (let i = 16; i < 30; i += 1) {
    let value = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) value = add(value, i === 16 ? (sigma1(words[i - 2]) ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0 : sigma1(words[i - 2]));
    if (i - 7 >= 14) value = add(value, words[i - 7]);
    if (i - 15 >= 14) value = add(value, i === 29 ? (sigma0(words[i - 15]) ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0 : sigma0(words[i - 15]));
    words.push(value);
  }
  words.push(u32(sigma1(words[28]) + words[23] + sigma0(words[15]) + words[14] + SHA256_ADJUSTMENT - SHA256_K[14]));
  expandSchedule(words, 31);
  const working = sha256Rounds(SHA256_STATE, words, 14);
  return SHA256_INITIAL.map((x, i) => add(x, working[i]));
}

function sha256Digest(data) {
  if (data.length < 7) throw new Error("Token salt must contain at least seven bytes");
  const length = 57 + data.length;
  const padLength = (((55 - length) % 64) + 64) % 64;
  const tail = data.slice(7);
  const padded = new Uint8Array(tail.length + 1 + padLength + 8);
  padded.set(tail, 0);
  padded[tail.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setBigUint64(padded.length - 8, BigInt(length * 8), false);
  let state = sha256Init(data.slice(0, 7));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = [];
    for (let i = 0; i < 16; i += 1) words.push(view.getUint32(offset + i * 4, false));
    expandSchedule(words);
    const working = sha256Rounds(state, words);
    state = state.map((x, i) => add(x, working[i]));
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  state.forEach((value, i) => outView.setUint32(i * 4, value, false));
  return out;
}

function wordsLe4Even(bytes) {
  const paddedLength = Math.ceil(bytes.length / 4) * 4;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  const view = new DataView(padded.buffer);
  const words = [];
  for (let i = 0; i < paddedLength; i += 4) words.push(view.getUint32(i, true));
  if (words.length % 2) words.push(0);
  return words;
}

function cs64Digest(data, digest) {
  const digestView = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const keyA = (digestView.getUint32(0, true) | 1) >>> 0;
  const keyB = (digestView.getUint32(4, true) | 1) >>> 0;
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];
  const terms = CS64_COEFFICIENTS.map(([coefficient], i) => mul(coefficient, factors[i % 2]));
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset);
  const prefixed = new Uint8Array(data.length + 1);
  prefixed.set(data, 1);
  wordsLe4Even(prefixed).forEach((word, i) => {
    let term = mul(word, i % 2 === 0 ? keyA : keyB);
    let offset = mul(rol16(word), i % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (i === 0) {
      term = add(term, mul(CS64_ADJUSTMENT0, factors[0]));
      offset = add(offset, CS64_ADJUSTMENT1);
    }
    terms.push(term);
    offsets.push(offset);
  });
  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i];
    const y = terms[i + 1];
    let t = rol16(add(offsets[i], x));
    let q = mul(t, 0x76f50f34);
    swapAcc = add(swapAcc, mul(rol16(q), 0xc3efea97), q);
    t = rol16(add(offsets[i + 1], y));
    q = mul(t, 0x1881ce3c);
    swapLast = add(mul(rol16(q), 0x35bd1ec9), q);
    swapAcc = add(swapAcc, swapLast);

    state = add(mul(state, keyA), x);
    state = mul(rol16(state), 0xcf98b111);
    state = mul(rol16(state), 0x87085b9f);
    state = mul(rol16(state), 0x12ceb96d);
    state = mul(rol16(state), 0x257e1d83);
    acc = add(acc, state);
    t = add(mul(state, keyB), y);
    t = mul(rol16(t), 0xa27416f5);
    t = mul(rol16(t), 0xd38396ff);
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = add(acc, state);
  }
  return [u32(swapLast ^ state), u32(swapAcc ^ acc)];
}

const toHex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();

function generateSecMsGec(unixSeconds = Date.now() / 1000) {
  let seconds = Math.floor(unixSeconds) + WIN_EPOCH;
  seconds -= seconds % 300;
  const ticks = (BigInt(seconds) * 10_000_000n).toString();
  const data = new TextEncoder().encode(`${ticks}${TRUSTED_CLIENT_TOKEN}`);
  const digest = sha256Digest(data);
  const [cs0, cs1] = cs64Digest(data, digest);
  const csBytes = new Uint8Array(8);
  const csView = new DataView(csBytes.buffer);
  csView.setUint32(0, cs0, true);
  csView.setUint32(4, cs1, true);
  return `${toHex(csBytes)}-${toHex(digest)}`;
}

function edgeTimestamp() {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function escapeXml(value) {
  return value.replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  })[character]);
}

function randomHex(byteCount) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function concatBytes(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
