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
   - **通常拒绝人工平滑、打字机和蓄意延迟**。唯一例外：等待气泡展开后，允许将动画期间积攒的首批文字在不超过 0.75 秒内轻微带出；追上后必须直接按真实 SSE 增量显示。
   - 曾误加过全程平滑层，被用户否决并移除；不要把首批文字过渡扩展成全程播放队列。
2. 流式过程中要能实时渲染 **Markdown / LaTeX（KaTeX）/ 代码高亮**。
3. 交互体验要与「opencode 官方 GUI」一样丝滑（ms 级、逐 token 观感）。

> 旧调查结论仅作背景；应以当前代码与可复现的性能测量判断瓶颈。详见第 5 节。

---

## 2. 技术栈

| 层 | 选型 |
|---|---|
| 桌面壳 | Electron 41 |
| 构建 | electron-vite 5（Vite 7） |
| UI | React 19 + TypeScript 7 |
| 样式 | Tailwind CSS v4（`@tailwindcss/vite`） |
| Markdown | Worker 中的 `unified` + `remark-parse` + `remark-gfm` + `remark-math` + `remark-rehype` + `rehype-stringify`；`react-markdown` 提供安全 URL 转换 |
| 高亮/公式 | `highlight.js`、`katex` |
| 内核通信 | `@opencode-ai/sdk/client`（REST）+ 原生 `EventSource`（SSE） |

---

## 3. 目录结构

```
OpencodeHUI/
├─ electron.vite.config.ts     # electron-vite 配置（@ 别名、React、Tailwind 插件）
├─ tsconfig.json               # TS 配置（ES2022 / Bundler / react-jsx / paths:@）
├─ package.json                # 脚本：dev / build / preview / typecheck / test:stream / test:workspace
├─ .vscode/launch.json         # F5 调试（Main / Renderer / 复合 Debug All）
├─ scripts/
│  ├─ stream-benchmark.mjs     # 启动开发服务器或生产页面及 Electron 测试进程
│  ├─ stream-benchmark.cjs     # 流式性能测量与显示/事件/滚动回归断言
│  ├─ stream-benchmark-preload.cjs # 页面加载前注入假内核，无真实模型请求
│  ├─ workspace-regressions.cjs # 工作空间切换、目录作用域及迟到请求回归
│  └─ workspace-store.test.mjs # 工作空间持久化、路径验证与目录比较测试
└─ src/
   ├─ main/
   │  ├─ index.ts              # Electron 主进程：创建无边框窗口、IPC、调试端口开关
   │  ├─ opencode-server.ts    # 内核生命周期：选端口、净化 env、spawn、健康检查
   │  └─ workspace.ts         # 工作空间路径验证、持久化和启动回退
   ├─ preload/
   │  └─ index.ts              # contextBridge 暴露 window.api
   └─ renderer/
      ├─ index.html
      └─ src/
         ├─ main.tsx           # 挂载 + 引入 katex/highlight 的 CSS
         ├─ App.tsx            # 全部界面与事件处理（核心文件）
         ├─ SessionContextMenu.tsx # 会话右键菜单、定位、关闭与焦点管理
         ├─ workspace-path.ts # 工作空间目录精确比较，兼容 Windows 大小写与斜杠
         ├─ stream-state.ts   # 按 SSE 顺序归并消息事件
         ├─ StreamingMarkdown.tsx # 即时文本展示、格式化调度与 DOM 复用
         ├─ markdown.worker.ts # Markdown / KaTeX / 高亮计算与有界缓存
         ├─ markdown-types.ts  # Worker 请求、响应与渲染片段的数据类型
         ├─ styles.css         # 液态玻璃 + .hui-md Markdown 样式
         ├─ env.d.ts           # window.api 类型声明
         └─ assets.d.ts        # 静态资源类型
```

**进程分工**

- **Main**：拉起/回收内核、创建窗口、IPC 转发、原生工作空间文件夹选择与本地设置保存。
- **Preload**：`contextBridge` 暴露 `getWorkspacePath / chooseWorkspacePath / getServerInfo / restartServer / onServerStatus / window.{minimize,maximize,close}`。
- **Renderer**：直接连接本地内核的 REST 与 SSE，管理消息状态、交互和 DOM 更新。
- **Markdown Worker**：承担 Markdown 解析、公式排版、代码高亮与格式化缓存，不负责消息接收或发送。

---

## 4. 运行 / 调试 / 构建

```bash
npm install
npm run dev          # 开发（HMR）
npm run typecheck    # tsc --noEmit
npm run build        # 生产构建（out/）
npm run preview      # 运行生产构建
npm run test:stream  # 假内核驱动的 Electron 流式性能与功能回归
npm run test:workspace # 工作空间设置与目录隔离的单元验证
```

- **VSCode 调试**：F5 → `Debug All`（Main 用 node 调试、Renderer 用 chrome 9222 attach）。
  `Debug Main Process` 已注入 `REMOTE_DEBUGGING_PORT=9222`；`src/main/index.ts` 仅在该环境变量存在时开启远程调试端口（便于 CDP 自动化排查）。
- 若安装 Electron 缓慢，可用镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

---

## 5. 流式渲染设计（2026-10-06 修订）

### 数据流
`opencode serve` → SSE `/event` → 有序消息事件队列 → 每帧提交 React 状态 → 立即显示新文本。
Markdown / KaTeX / 高亮由独立 Worker 计算；格式化结果在下一绘制帧应用，期间新增文本始终可见。

### 已验证的问题

旧实现只用空行切分 `splitStreaming()`。连续列表、表格、无空行长段落仍是一个不断增长的尾块，每次 delta 都在主线程完整执行 Markdown、公式、高亮，并且 ReactMarkdown 每次重新创建处理器、注册高亮语言。缓存已完成的段落不能覆盖这些输入。
另外，delta 推迟到 rAF 才提交，而 `message.part.updated` 快照直接提交，会颠倒 SSE 原始顺序，导致重复追加、回退；切换会话时未清理的 delta 还可能串入新会话。

本机 Electron 开发模式固定数据复现（80 条连续列表、5,660 字符、40 字符/批、4ms 发送间隔）：旧实现输出过程约 10.2s，前四分之一每批平均 19.1ms、后四分之一 114.1ms，83 次 >50ms 主线程长任务。此数据来自离线假内核，不受模型速度影响。不能仅以“dev 模式开销”解释该缺陷。

### 当前实现

1. `stream-state.ts` 对 delta、部件快照、消息元信息与删除事件按接收顺序归并。同帧只复制一次消息数组及受影响部件数组，保持未变化消息的引用。
2. 会话切换、连接清理时取消待提交事件。REST 返回结果检查会话代次及事件版本，避免覆盖更新中的 SSE 状态。
3. `StreamingMarkdown.tsx` 在通常流式阶段立即展示已收到的新文本；格式化尚未完成的后缀临时以原始文本显示，并在 `useLayoutEffect` 中接到当前段落、列表项或开放代码块的原位置，继承该处字体和行高。Worker 的 `tailKind` 指示续写位置；新段落使用独立文本块。首条回复在气泡展开后有一次有界短过渡，详见下文；后续没有打字机、字符播放队列或固定等待计时器。
4. `markdown.worker.ts` 在 Worker 中解析完整 Markdown，保留跨段引用链接、列表、表格语义；复用 unified 处理器及高亮器。未闭合围栏暂不高亮。
5. 段落、列表项、代码块的格式化结果使用有界缓存（最多 512 项、约 8,000,000 个序列化字符的预算）。旧列表项及表格行保留 DOM；跨 Worker 消息仅传变化的片段，已有片段通过 ID 复用。
6. 格式化请求最多一个执行中，每个部件只保留最新待执行快照；格式化结果每帧最多应用一次。格式化计算不阻塞文字显示，也不堆积历史快照。
7. 原始 HTML 保持转义；链接沿用 ReactMarkdown 的安全 URL 转换。渲染进程只插入本项目流水线生成的 HTML。
8. 自动吸底在 ResizeObserver 的布局后、绘制前阶段更新滚动位置，同时跟踪文字增长和异步排版，并区分用户滚动与排版引起的滚动事件。此处不再另排下一帧，避免先显示旧位置再跳到底部。助手气泡宽度固定为可用宽度的 82%，滚动区预留滚动条位置；消息气泡不重复执行父面板已经提供的背景模糊。
9. Vite 使用 `worker` 导出条件，确保 Markdown 的字符实体解码不调用 `document`；预优化 Worker 依赖，避免第一次生成回复时触发依赖发现后的整页重载。

### 回归验证

```bash
npm run typecheck
npm run build
npm run test:stream                  # Electron + Vite 开发模式
npm run test:stream -- --large        # 约 1.7 万字列表、2 万字段落、近 3 万字符代码
npm run test:stream -- --production   # 直接加载 out/renderer/index.html，验证 file:// Worker
npm run test:stream -- --layout-only  # 只验证流式气泡尺寸、滚动与代码续写
```

测试内核为假的，不创建真实会话、不请求模型。覆盖流式列表/长段落/多段落/代码、公式、高亮、自动吸底，以及快照与 delta 顺序、删除、会话切换、引用链接、HTML 转义、安全 URL、未知代码语言。测试打印输出耗时、帧间隔、主线程长任务、前后段处理耗时；机器负载不同会改变数值，不应把一次测试当成所有输入的性能保证。

### 本次修复的验证结果（2026-10-06）

`typecheck`、`build`、开发模式常规测试、开发模式长回复压力测试、生产页面测试均已通过。生产测试直接在 Electron 中加载构建后的 `file://` 页面，包含 Worker 的实际加载过程。

同一份 80 条连续列表输入的开发模式对比：

| 指标 | 修复前 | 修复后 |
|---|---:|---:|
| 输出过程耗时 | 10,208ms | 1,047ms |
| 后四分之一每批平均耗时 | 114.1ms | 7.2ms |
| 主线程 >50ms 长任务 | 83 次 | 0 次 |
| 帧间隔第 95 百分位 | 133ms | 17ms |

长回复压力测试覆盖 17,300 字符列表、20,640 字符长段落、8,770 字符多段落和 28,818 字符代码。列表、多段落、代码未出现主线程长任务；长段落出现一次约 52ms 的长任务，说明浏览器布局仍有成本，不能宣称所有长度和格式下都绝无卡顿。

最终生产测试通过 13 项功能回归断言，除上述内容外，还覆盖嵌套代码围栏闭合前后高亮、用户向上滚动后保持位置、回到底部后恢复自动跟随。测试中的输出过程耗时包含发送计时器和末尾等待，不是单次解析耗时，也不是模型生成速度。

当前测试为离线假内核验证；真实模型的网络延迟、分组大小与生成速度未由这些数据证明。后续如遇不同输入的卡顿，应保留输入与运行模式，先运行同类复现并测量主线程长任务，再判断是否需要调整。

### 流式气泡抖动修复（2026-10-06）

先前将原始后缀放在已格式化段落外，Worker 返回后又把它合并到段落内。这会反复制造额外一行，再撤掉这一行；气泡随内容改变宽度，加上吸底推迟到下一绘制帧，会进一步放大高度和滚动位置的跳动。

固定输入的开发模式复现中，短回复宽度变化约 595px；文字持续追加时，气泡高度下降 6 次，滚动位置后退 6 次。修复后同类输入的宽度变化、高度下降、滚动后退均为 0；代码续写也验证了当前行、真实换行与空行不会被丢失或移位。这些断言已加入 `test:stream`，且可以单独通过 `--layout-only` 执行；`--record-layout` 只记录数据，不做布局断言，便于对比旧实现。

注意：未闭合代码围栏的 HTML 会补一个末尾换行。续写同一行时移除这个合成换行，已有源码换行则保留；Worker 替换宿主 DOM 后，在绘制前重新挂载纯文本后缀。不要把后缀重新放到段落外，也不要用固定高度或滚动动画掩盖排版跳动。标题、表格、公式等结构在真正形成时仍可能合理改变高度，测试针对的是无结构变化的连续文字反复收缩。

### 回复等待与入场动效

- `ReplyPresentation.tsx` 在发送后显示紧凑的“等待回复”玻璃气泡，圆点通过 CSS 缩放、圆环、旋转和颜色变化呈现等待状态；收到用户消息回显前也能立即显示。
- `MessageView` 不为空正文、空思考或协议记账部件创建气泡。首条正文、思考、工具、文件或重试内容到来时，同一个气泡依次经历文字向左渐隐、宽度收至以圆环为中心的 38px 圆角方块、圆点消失、气泡展开承载正文。`ReplyPresentation` 根据 CSS 动画结束事件推进阶段，不另设定时器；后续 delta 不重新触发动效。
- 等待状态以当前一轮消息的可见内容判断，历史回复不能消除新请求的等待条。支持系统减少动态效果设置。错误、停止后的 idle、会话及工作空间切换会清理等待状态。
- `scripts/reply-ui-regressions.cjs` 随 `test:stream` 验证气泡同一 DOM 节点贯穿等待与正文、阶段顺序、空消息隐藏、首条思考过渡、后续增量不重放动画、下一轮等待及错误清理。测试使用假内核。
- 各轮用户消息及助手回复在 `App.tsx` 中保持固定的 React 父节点与稳定 key；新一轮发送不能把历史助手消息从当前回复容器移到另一容器，否则 Markdown Worker 生成的 DOM 会卸载重建并使页面跳动。发送前等待条也使用当前请求的稳定 key，以便用户消息回显后继续复用同一气泡。
- 展开阶段的玻璃气泡固定为 38px 高度，正文在宽度展开结束后才进入布局；否则正文在 38px 窄宽下先撑成高列，形成竖向玻璃残影。回归测试用长思考内容验证展开期间高度及上一轮 Markdown 节点的连续性。
- 气泡展开期间接收的文字继续保存在 SSE 消息状态中。展开结束后，`ReplyPresentation` 只对首批已收到的文本做一次最多 560ms 的逐帧追赶，并将期间新到的文字纳入当前追赶目标；总过渡低于用户要求的 0.75 秒。追上后撤掉可见字符上限，后续 SSE 文字立即按原速显示。仅影响本轮助手气泡，历史 Markdown 不重放。系统减少动态效果时跳过该过渡。

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

## 8. 会话列表、工作空间与删除（2026-10-06）

### 工作空间

- 左侧底部显示当前工作空间完整路径，超长时截断显示，鼠标悬停可查看完整值；上方的“切换工作空间”打开原生文件夹选择对话框。取消选择或选择相同目录保留当前对话。
- 初次启动使用进程工作目录；后续优先恢复 Electron `userData/workspace.json` 中的目录。主进程验证目录存在且为文件夹，保存真实绝对路径；设置损坏或目录已删除时回退到启动目录。
- SDK 客户端通过 `createOpencodeClient({ baseUrl, directory })` 建立目录上下文；会话列表另显式传入 `query.directory`，并按会话的 `directory` 再做精确过滤。不同文件夹分别隔离，即使位于同一个 Git 仓库或属于父子目录也不合并。
- 新建、历史读取、发送、停止和删除均使用当前目录的 SDK 客户端；SSE 连接使用 `/event?directory=...`。不要重新引入未带目录的原生发送/停止请求。
- 切换时立即关闭旧 SSE、使旧客户端失效，清理会话、消息、待提交增量、输入草稿、忙碌状态及目录配置，再加载新目录会话和配置。旧客户端返回的列表、历史、配置、新建结果及删除结果不能更新新工作空间。
- 兼容普通 SSE 事件和带 `directory/payload` 的事件封装；忽略其他目录的封装事件及会话生命周期事件。Windows 路径比较兼容大小写、斜杠和末尾分隔符，非 Windows 路径保持大小写区别。
- 切换工作空间不重启内核，也不主动中断原工作空间中已经发送的模型任务；切回后可以重新选择对应会话查看历史。
- `npm run test:workspace` 验证设置保存、恢复、失效回退和目录比较；`npm run test:stream` 增加 16 项工作空间界面与请求回归，使用假内核验证目录隔离、取消/失败选择、Unicode 路径、各类请求的目录参数，以及迟到的列表、历史和新建结果。

### 会话删除

- 在左侧会话条目上右键，点击“删除会话”，通过 SDK 的 `session.delete({ path: { id } })` 调用 `DELETE /session/{id}`。右键不改变当前选中的会话。
- 菜单限制在窗口可视范围内；点击外部、按 Escape/Tab、滚动会话列表、调整窗口大小或窗口失焦时关闭。
- 删除期间目标条目显示“正在删除…”，阻止重复请求；服务端确认成功后才移除列表项。删除失败保留会话并显示错误，404 视为会话已经删除。
- 删除当前会话时取消待提交增量及消息刷新，清空消息、当前会话和忙碌状态，返回初始对话界面；删除其他会话保留当前对话。
- `session.deleted` SSE 事件同样更新本地状态。会话列表请求检查请求版本及连接身份，并过滤已删除 ID，防止旧响应恢复已删除条目。
- `SessionContextMenu.tsx` 负责菜单展示；`App.tsx` 的 `deleteSession`、`forgetSession` 负责请求及状态清理。
- `npm run test:stream` 现包含 13 项会话删除回归断言，使用假内核验证菜单关闭与定位、请求目标、失败保留、重复点击、延迟响应、当前/非当前会话删除、404 和外部删除事件。该功能的类型检查、构建、开发模式回归已通过。

---

## 9. 待办 / 已知限制

- 格式化计算期间，新增后缀先以原始文本显示，Worker 返回后更新为 Markdown；超长单段落仍存在浏览器布局成本。
- 长代码块在闭合成围栏前不高亮（有意为之，换取流式性能）。
- 尚未做会话持久化 UI、工具调用结果富展示、多模态等增强。

---

## 10. 快速改动指引

| 想改什么 | 去哪里 |
|---|---|
| 界面 / SSE 接收 / 会话切换 / 自动滚动 | `src/renderer/src/App.tsx` |
| 工作空间路径显示 / 切换 / 目录请求上下文 | `src/renderer/src/App.tsx` |
| 原生文件夹选择 / 工作空间设置 IPC | `src/main/index.ts`、`src/preload/index.ts` |
| 工作空间持久化与路径验证 | `src/main/workspace.ts` |
| 工作空间路径比较 | `src/renderer/src/workspace-path.ts` |
| 会话右键菜单 / 菜单定位与关闭 | `src/renderer/src/SessionContextMenu.tsx` |
| 会话删除请求 / 删除后的状态清理 | `src/renderer/src/App.tsx` 的 `deleteSession`、`forgetSession` |
| 有序消息归并 / delta 与快照更新 | `src/renderer/src/stream-state.ts` |
| 即时文本 / Worker 调度 / DOM 片段复用 | `src/renderer/src/StreamingMarkdown.tsx` |
| Markdown 解析 / 公式与高亮 / 格式化缓存 | `src/renderer/src/markdown.worker.ts` |
| Worker 请求、响应与片段类型 | `src/renderer/src/markdown-types.ts` |
| Markdown / 玻璃样式 | `src/renderer/src/styles.css` |
| 流式性能与功能回归 | `scripts/stream-benchmark.mjs`、`scripts/stream-benchmark.cjs`、`scripts/stream-benchmark-preload.cjs` |
| 内核启动 / env / 二进制解析 | `src/main/opencode-server.ts` |
| 窗口 / IPC / 调试端口 | `src/main/index.ts` |
| 暴露给渲染进程的 API | `src/preload/index.ts` |
| 构建 / 别名 / 插件 | `electron.vite.config.ts` |

改动后**必须**运行：`npm run typecheck && npm run build`。
