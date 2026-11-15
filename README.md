# Edge TTS Clone - Cloudflare Pages 部署包

纯前端克隆的 Microsoft Edge 文字转语音工具，支持 74 种语言、约 318 种声音，自动生成 MP3 + VTT/SRT 字幕。

## 功能

- 74 种语言 / 318+ 声音
- 语速调节（0.5x ~ 3x）
- 自动生成 VTT / SRT 字幕
- 声音试听
- 深色模式
- 声音搜索（跨语言按名字/地区/方言）、音调与音量调节
- 长文本自动分段合成并拼接，字幕时间轴连续
- 设置与草稿自动保存在本机浏览器
- 完全免费、无需 API Key

## 技术说明

- 前端调用同源 `/api/tts`（Cloudflare Pages Function，`functions/api/tts.js`），由 Function 通过 WebSocket 连接微软 Edge TTS（`speech.platform.bing.com`）。浏览器无法设置上游要求的 Origin / Cookie / User-Agent，所以不能直连。
- 使用 Sec-MS-GEC v2 令牌（`Sec-MS-GEC-Version: 2-<Chromium 版本>`）。若微软再次升级版本导致 403，可在 Cloudflare 环境变量 `EDGE_TTS_CHROMIUM_VERSION` 中更新版本号，算法参考 rany2/edge-tts 的 `drm.py`。
- 需要部署到 Cloudflare Pages（含 Functions）；纯静态托管（如 GitHub Pages）无法使用。

## 部署到 Cloudflare Pages

### 方式一：直接上传（最快）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Pages** → **Upload assets**
2. 将本目录（`edge-tts-cf`）内的所有文件打包成 zip，或直接拖拽整个文件夹上传
3. 项目名称随意，点击 **Deploy**
4. 部署完成后即可通过 `*.pages.dev` 域名访问

### 方式二：Git 连接（推荐长期维护）

1. 将本目录推送到 GitHub / GitLab 仓库
2. Cloudflare Pages → **Connect to Git** → 选择仓库
3. 构建设置：
   - **Framework preset**: None
   - **Build command**: 留空
   - **Build output directory**: `/`（或 `.`）
4. 保存并部署

### 方式三：Wrangler CLI

```bash
# 安装 wrangler
npm i -g wrangler

# 登录
wrangler login

# 部署（在 edge-tts-cf 目录下）
npx wrangler pages deploy . --project-name=edge-tts-clone
```

## 本地预览

```bash
npx wrangler pages dev .   # 含 /api/tts Function
```

打开 http://localhost:8080 即可使用。

## 目录结构

```
edge-tts-cf/
├── index.html          # 主页面
├── js/
│   ├── edge-tts.js     # TTS WebSocket 客户端 + 字幕生成
│   ├── voices.js       # 74 语言 / 318 声音数据
│   └── app.js          # 界面逻辑
├── _headers            # Cloudflare 安全头
└── README.md
```

## 注意事项

1. **网络**：需要能访问 `speech.platform.bing.com`（部分地区可能需要代理）
2. **浏览器**：Chrome / Edge / Firefox / Safari 均可用，Edge 体验最佳
3. **合规**：本项目仅供学习交流，请遵守 [Microsoft 服务条款](https://www.microsoft.com/servicesagreement)。商业使用请自行评估风险。
4. **Token**：当前使用公开的 TrustedClientToken，微软可能随时变更接口，届时需更新 `edge-tts.js` 中的相关参数。

## 参考

- 原站：https://edge-tts.com
- Python 版：https://github.com/rany2/edge-tts
- 微软 Edge Read Aloud 服务

## 离线朗读（断网可用）

页面右侧“引擎”可选 **自动 / 在线 / 离线**：

- **在线**：Edge 神经语音（经 `/api/tts` 代理），输出 MP3。
- **离线**：浏览器本地运行 [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) WebAssembly，输出 WAV，带按句 SRT/VTT 字幕，不支持调音调。可选两个模型包，各自下载一次后保存在浏览器 Cache Storage，断网也能读任意文字：
  - **Kokoro 中英 · 4 声**（默认，约 216 MB）：[Kokoro-82M v1.1-zh](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh) FP16，24 kHz，晴岚、若溪（女）与云舟、景澈（男）。浏览器包来自 [haixin/timeline-studio-voice-models](https://huggingface.co/haixin/timeline-studio-voice-models)（Apache-2.0）。
  - **Matcha 中英 · 女声**（约 138 MB）：`matcha-icefall-zh-en`，16 kHz，体积更小、合成更快。
- **自动**（默认）：有网用在线；断网或在线请求失败时，如已下载离线模型则自动改用离线。

实现说明：

- `offline/tts-worker.js`：通用离线 Worker，通过 Worker name（`<目录>|<缓存名>`）指定模型包。
- `offline/v1/`：Matcha 包，sherpa-onnx 2.0.1 预编译 wasm 运行时（Apache-2.0）；模型数据拆成 6 个 ≤22 MB 分片放在 `model/`（Cloudflare Pages 单文件上限 25 MiB）。
- `offline/kokoro-v1/`：Kokoro 四声包（运行时、10 个 ≤22 MB 分片、试听样音、`LICENSE`、`SOURCE.md`）。
- `sw.js`：Service Worker 缓存页面本身，断网时也能打开站点。
- 模型包登记在 `js/offline-tts.js` 的 `PACKS`。更换或升级模型时请改用新目录与新缓存名。
