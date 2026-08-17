# Edge TTS Clone - Cloudflare Pages 部署包

纯前端克隆的 Microsoft Edge 文字转语音工具，支持 74 种语言、约 318 种声音，自动生成 MP3 + VTT/SRT 字幕。

## 功能

- 74 种语言 / 318+ 声音
- 语速调节（0.5x ~ 3x）
- 自动生成 VTT / SRT 字幕
- 声音试听
- 深色模式
- 完全免费、无需 API Key、无后端

## 技术说明

- 浏览器端通过 WebSocket 直接连接微软 Edge TTS 服务（`speech.platform.bing.com`）
- 无需服务器，适合 Cloudflare Pages / GitHub Pages / 任意静态托管
- 推荐使用 Microsoft Edge 浏览器以获得最佳兼容性

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
# 任意静态服务器即可，例如：
npx serve .
# 或
python -m http.server 8080
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
