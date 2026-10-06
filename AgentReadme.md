# AgentReadme

> 面向后续 AI Agent 的快速上手指南。读完本文即可理解本项目的目标、架构、关键机制与已踩过的坑，避免重复调查。

---

## 1. 项目是什么

**OpencodeHUI** 是一个用 **Electron + React 从零编写的 opencode 图形客户端**。

- 不修改开放源代码内核，而是把官方 `opencode` 作为**本地 HTTP/SSE 服务**拉起（`opencode serve`），前端通过官方 SDK + 原生 `EventSource` 与之交互。
- 定位是 **WebUI 外壳**：内核负责会话/模型/工具执行，外壳负责界面与流式展示。
- 视觉风格为「液态玻璃」（窗口内部 CSS `backdrop-filter`，不穿透桌面、不依赖 Win32/DWM）。

### 用户意图（核心诉求，务必遵守）

1. **真・中断式流式**：内核每吐出一个分组（delta），界面必须**立即渲染**。
   - **明确拒绝任何人工平滑 / 打字机 / 蓄意延迟动画**。
   - 曾误加过平滑层，被用户否决并已彻底移除；不要重新引入。
2. 流式过程中要能实时渲染 **Markdown / LaTeX（KaTeX）/ 代码高亮**。
3. 交互体验要与「opencode 官方 GUI」一样丝滑（ms 级、逐 token 观感）。

> 关键教训：**卡顿一坨一坨的根因不在内核，而在渲染**。详见第 5 节，切勿再从内核或传输层找原因。

---

## 2. 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Electron 41 |
| 构建 | electron-vite 5（Vite 7） |
| UI | React 19 + TypeScript 7 |
| 样式 | Tailwind CSS v4（`@tailwindcss/vite`） |
| Markdown | `react-markdown` + `remark-gfm` + `remark-math` + `rehype-katex` + `rehype-highlight` |
| 高亮/公式 | `highlight.js`、`katex` |
| 内核通信 | `@opencode-ai/sdk/client`（REST）+ 原生 `EventSource`（SSE） |

---

## 3. 目录结构

```
OpencodeHUI/
├─ electron.vite.config.ts     # electron-vite 配置（@ 别名、React、Tailwind 插件）
├─ tsconfig.json               # TS 配置（ES2022 / Bundler / react-jsx / paths:@）
├─ package.json                # 脚本：dev / build / preview / typecheck
├─ .vscode/launch.json         # F5 调试（Main / Renderer / 复合 Debug All）
└─ src/
   ├─ main/
   │  ├─ index.ts              # Electron 主进程：创建无边框窗口、IPC、调试端口开关
   │  └─ opencode-server.ts    # 内核生命周期：选端口、净化 env、spawn、健康检查
   ├─ preload/
   │  └─ index.ts              # contextBridge 暴露 window.api
   └─ renderer/
      ├─ index.html
      └─ src/
         ├─ main.tsx           # 挂载 + 引入 katex/highlight 的 CSS
         ├─ App.tsx            # 全部界面与事件处理（核心文件）
         ├─ styles.css         # 液态玻璃 + .hui-md Markdown 样式
         ├─ env.d.ts           # window.api 类型声明
         └─ assets.d.ts        # 静态资源类型
```

**进程分工**

- **Main**：拉起/回收内核、创建窗口、IPC 转发；不参与业务逻辑。
- **Preload**：`contextBridge` 暴露 `getServerInfo / restartServer / onServerStatus / window.{minimize,maximize,close}`。
- **Renderer**：唯一执行业务的地方——直接连本地内核的 REST 与 SSE。

---

## 4. 运行 / 调试 / 构建

```bash
npm install
npm run dev          # 开发（HMR）
npm run typecheck    # tsc --noEmit
npm run build        # 生产构建（out/）
npm run preview      # 运行生产构建
```

- **VSCode 调试**：F5 → `Debug All`（Main 用 node 调试、Renderer 用 chrome 9222 attach）。
  `Debug Main Process` 已注入 `REMOTE_DEBUGGING_PORT=9222`；`src/main/index.ts` 仅在该环境变量存在时开启远程调试端口（便于 CDP 自动化排查）。
- 若安装 Electron 缓慢，可用镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

---

## 5. 流式渲染设计（本项目最核心、最易踩坑处）

### 数据流
`opencode serve` → SSE `/event` → Renderer 的 `EventSource.onmessage` → 更新 React 状态 → 渲染。

### 事件形状（要点）
- `message.part.delta`：`properties = { sessionID, messageID, partID, field:"text", delta }`。
  - **真正的流式信号；SDK 类型里没有此事件，需用原生 EventSource 处理。**
- `message.part.updated`：`properties.part` 为部件快照（含 `type/text/time`）。
- `message.updated` / `message.part.removed` / `message.removed` / `session.idle` / `session.error`。
- `part.type` 取值：`text | reasoning | tool | file | step-start | step-finish | patch | retry`。

### 已确立的正确做法

1. **禁用人工平滑/攒批延迟**。
2. **流式 Markdown 必须按块增量渲染**：
   - `splitStreaming()` 把文本切成「已完成块」与「尾部未闭合块」，用 `\n\n` 切分且**不切进未闭合的代码围栏**。
   - 已完成块交给被 `memo` 的 `<Markdown>`，**只解析一次**。
   - **未闭合的代码围栏先以纯文本 `<pre class="hui-code hui-code-live">` 显示**，闭合后再高亮一次。
   - 全文只在部件结束（`part.time?.end != null`）时整体解析一次。
3. **按动画帧合并提交**（关键）：
   - delta 入 `pendingDeltas` 缓冲，用 `requestAnimationFrame` 每帧最多提交一次，`reduceDelta()` 顺序合并。
   - 这不是延迟：显示器每帧最多绘制一次，同帧内多次渲染既不可见又会拖垮主线程。
4. `rehype-highlight` 传 `{ detect: false, ignoreMissing: true }`，**关闭自动语言探测**。
5. 自动吸底用 `requestAnimationFrame` 节流，避免每个 delta 强制同步重排。

### 为什么必须这样（血泪调查结论）

- 最初「每个 delta 全量重跑 `react-markdown` + `rehype-highlight`」，dev 模式单次渲染约 **12ms**，而 delta 间隔仅 **3–5ms** → 渲染追不上 → 主线程积压 → SSE 事件排队 → 解堵后**一次性爆发**（即用户口中的「一坨一坨」）。
- 铁证：477 个 delta **只在 5 个事件循环 tick 到达**，并伴随单个 **3825ms 长任务**；而给「App 不渲染的会话」发消息时，458 个 delta 分散在 **93 个 tick、0 长任务**。→ 卡顿 100% 在渲染侧。
- CPU Profiler 热点：`react_jsx-dev-runtime`（dev 开销）、`rehype-highlight`、`react-markdown`。
- **修复后**：dev 下 tick 数 4→144、最大突发 354→20、长任务 3.8s→无、屏幕 464 帧/4.9s（≈90fps）。
- **生产构建**（无 `jsxDEV`）本就宽裕，修复后同样顺滑。

> 忠告：**不要**再用「打字机/平滑/延迟」去掩盖卡顿；正确方向是降低渲染成本 + 帧内合并。

---

## 6. 内核管理要点（`src/main/opencode-server.ts`）

- **端口**：`freePort()` 动态选空闲端口，监听 `127.0.0.1`。
- **二进制解析 `resolveOpencodeBin()` 优先级**：
  1. `OPENCODE_BIN` 环境变量
  2. `%APPDATA%\Clonely\bin\opencode.exe`（**桌面版托管内核，与新版数据库 schema 兼容**）
  3. PATH 上的 `opencode`
- **环境变量净化 `sanitizedEnv()`**：务必删除宿主注入的这些键，否则会干扰独立内核：
  `OPENCODE_CLIENT`、`OPENCODE_SERVER_PASSWORD`、`OPENCODE_SERVER_USERNAME`、`OPENCODE_DISABLE_EMBEDDED_WEB_UI`、`OPENCODE_EXPERIMENTAL_FILEWATCHER`、`OPENCODE_EXPERIMENTAL_ICON_DISCOVERY`。
  删除后为**无鉴权本地服务**，前端可直接连接。
- **健康检查**：轮询 `GET /global/health` 获取 `version`，据此判定 `ready/error`。
- Windows 下 PATH 里的 `opencode` 是 shell shim，需 `shell:true` 启动。

---

## 7. 环境与已知坑

- **数据库版本兼容**：默认 DB `~/.local/share/opencode/opencode.db` 由桌面版写入；若用旧版 CLI 会报 `SQLiteError: no such column: replacement_seq`。用 `resolveOpencodeBin()` 的优先级规避。
- **SDK 入口**：必须用 `@opencode-ai/sdk/client`；根入口会引入 Node `child_process`，浏览器打包失败。
- **CORS**：内核会反射 Origin（`Access-Control-Allow-Origin`），可跨源直连。
- **模型可用性**：`config.providers()` 返回多个 provider/模型；沙箱/离线环境常只有 `deepseek/deepseek-flash`、`deepseek/deepseek-v4-pro` 可用。默认 `config.get().model` 可能不可达。
- **发送接口**：用 `POST /session/{id}/prompt_async`（发后即返回，结果走 SSE）；停止用 `POST /session/{id}/abort`。
- TS7 已移除 `baseUrl`，`paths` 用相对 `./`。

---

## 8. 待办 / 已知限制

- 流式时按块渲染，跨空行的紧耦合结构（如松列表跨段）在流式期间可能呈现为多段；部件结束时整体重解析可纠正。
- 长代码块在闭合成围栏前不高亮（有意为之，换取流式性能）。
- 尚未做会话持久化 UI、工具调用结果富展示、多模态等增强。

---

## 9. 快速改动指引

| 想改什么 | 去哪里 |
|---|---|
| 界面 / 事件处理 / 流式逻辑 | `src/renderer/src/App.tsx` |
| Markdown / 玻璃样式 | `src/renderer/src/styles.css` |
| 内核启动 / env / 二进制解析 | `src/main/opencode-server.ts` |
| 窗口 / IPC / 调试端口 | `src/main/index.ts` |
| 暴露给渲染进程的 API | `src/preload/index.ts` |
| 构建 / 别名 / 插件 | `electron.vite.config.ts` |

改动后**必须**运行：`npm run typecheck && npm run build`。
