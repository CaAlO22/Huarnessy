# AgentReadme

> 面向后续 AI Agent 的快速上手指南。读完本文即可理解本项目的目标、架构、关键机制与已踩过的坑，避免重复调查。

---

## 1. 项目是什么

**OpencodeHUI** 是一个用 **Electron + React 从零编写的 opencode 图形客户端**。

- 不修改开放源代码内核，而是把官方 `opencode` 作为**本地 HTTP/SSE 服务**拉起（`opencode serve`），前端通过官方 SDK + 原生 `EventSource` 与之交互。
- 定位是 **WebUI 外壳**：内核负责会话/模型/工具执行，外壳负责界面与流式展示。
- 视觉风格为「液态玻璃」（窗口内部 CSS `backdrop-filter`，不穿透桌面、不依赖 Win32/DWM）。
- 侧栏与聊天区外层面板使用固定的毛玻璃；顶部「设置 → 对话气泡折射」控制用户消息、等待气泡及助手步骤/回复气泡的实验性曲面折射，偏好保存在 `hui.liquidGlass`。`LiquidGlass.tsx` 按每个气泡的尺寸与圆角生成 PNG 置换图：边缘折射带按短边约 16% 计算，位移在带的内外边界归零、中段最强；RGB 三次采样产生真实背景色散，采样位移随折射带厚度缩放，避免短气泡出现过强的彩边。镜面反光由曲面法线生成，只占折射带靠外的一小段，强度低于最初的大面板版本。尺寸变化经 ResizeObserver 防抖后更新，置换图的宽、高分别上限 384px，使很长的回复不会把横向圆角压成几像素。SVG 滤镜 URL 必须以内联样式引用，确保生产构建的独立 CSS 文件不会把片段标识相对自身解析。**主聊天框自身不能再有 `backdrop-filter`**：它会成为后代气泡的 Backdrop Root，挡住框外壁纸。现在毛玻璃由主框的第一个子元素 `.hui-chat-pane-backdrop` 绘制，消息滚动区与输入区作为其上方的兄弟层；侧栏仍直接模糊。模糊滤镜以内联样式声明，以免生产版计算结果为 `none`。`npm run test:stream -- --production --screenshot --visual-only` 会在 `out/` 生成带运行编号的普通背景与斜线背景对照截图，后者暂时撤除主面板模糊以凸显气泡的折射；视觉检查与完整流式测试应分别执行。
- 气泡顶部的位移向**气泡内侧**取样。若沿外法线取样，靠近聊天框顶部的气泡会把框的边线拉进折射带，形成一条不相关的彩弧。液态气泡的实体浅色描边和内侧亮线也已移除，只保留较弱的法线反光；否则平滑渐变背景下，描边比真实像素位移更显眼。`scripts/reply-ui-regressions.cjs` 会检查置换图上沿的纵向通道确实指向内部。平滑纯渐变缺少高频纹理，实际几何位移的可见性天然低于有线条/文字的背景；不能靠固定彩色边线假装它发生了明显折射。

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
| 界面字体 | 本地打包的 Noto Sans SC Variable（SIL OFL 1.1；授权副本在 `src/renderer/public/licenses/`） |
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
│  ├─ composer-regressions.cjs # 输入区附件、伸缩、选择面板及 Question 回归
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
npm run app          # 从 out/ 的独立快照启动，不监听源码（用于“用它改本项目”）
npm run app:build    # 先构建再按快照启动
npm run test:stream  # 假内核驱动的 Electron 流式性能与功能回归
npm run test:workspace # 工作空间设置与目录隔离的单元验证
```

- `npm run dev` 会监听 `src/`：改渲染层触发 HMR 重载、改主进程直接重启 Electron。若正用该窗口与本项目对话，源码改动会打断当前窗口。需要一边改源码一边保持对话窗口存活时，用 `npm run app`（或 `npm run app:build`）：`scripts/run-standalone.mjs` 把 `out/` 拷贝到仓库外的稳定目录（Windows 为 `%LOCALAPPDATA%\OpencodeHUI\standalone`）再启动，之后 `npm run build` 覆盖仓库内 `out/` 不会影响运行中的实例。该快照仍是独立进程，带自己的 `opencode serve` 内核，与 VSCode 内的 opencode 实例互不影响。要看到新的源码改动，需重新执行 `npm run app:build` 并接受新窗口替换旧窗口。

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
8. 自动吸底在 ResizeObserver 的布局后、绘制前阶段更新滚动位置，同时跟踪文字增长和异步排版，并区分用户滚动与排版引起的滚动事件。此处不再另排下一帧，避免先显示旧位置再跳到底部。助手气泡占满聊天滚动区的可用宽度，用户气泡仍限制在 82%，滚动区预留滚动条位置；普通消息表面不叠加第二层背景模糊，启用实验效果时仅气泡使用边缘折射。
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
- 同一轮中的每条可见 assistant 消息对应一次模型调用。当前最后一次调用保持普通回复气泡，不标为“步骤”；下一条 assistant 消息出现可见内容后，上一条才变成自动折叠的“步骤 N”。步骤标题按工具类型汇总调用次数并沿用工具配色，收起时宽度随摘要内容变化；可手动重新展开，后续增量不会反复覆盖手动状态。折叠只隐藏内容，不卸载 Markdown DOM；加载历史时最后一条保持普通回复。
- 超长步骤列表由 `StepList` 做第二级收纳：每轮至少保留最近 3 个板块独立显示，更早的完整 10 步按从第 1 步起的固定区间收成“步骤 1–10”式摘要，并显示彩色工具调用总数。打开区间后仍可逐步展开；区间关闭动画完成后卸载隐藏的步骤 DOM，减少长会话负担。新区间仅在用户跟随对话底部时自动形成；用户上滚查看历史时延后收纳，返回底部再更新。`scripts/step-range-regressions.cjs` 用 23 个假调用验证编号、摘要、展开、阅读历史时的稳定性和最终回复。
- 步骤展开和收起使用非线性的宽度与网格行高过渡；正文、思考及 ToolCall 随后渐显和轻微位移。折叠时内容保持在 DOM 中并设为不可聚焦，系统启用减少动态效果时将过渡缩至 1ms。不要恢复 `hidden` 切换，否则面板会瞬间跳变。
- `LiquidGlass` 的置换图按元素尺寸生成，尺寸变化后重新采样。展开/收起期间元素逐帧改变大小，若仍沿用旧的“等尺寸稳定后再更新”策略，折叠时的小图会被拉伸到变宽的盒子上，把低分辨率的边缘放大成锯齿。因此 `useLiquidGlassMap` 在 `ResizeObserver` 回调里用 `element.getAnimations()` 判断当前是否有过渡/动画：有则每帧刷新置换图，没有（如流式正文持续长高）则沿用尾随防抖，避免逐帧重算拖慢流式。映射图生成也做了优化（复用画布、安全内部区域早退、去掉 `Math.hypot`/多余 `Math.pow`）。`test:stream` 在步骤展开中途断言图宽高至少为元素的 60%，防止回退成拉伸折叠图。
- 折叠内容虽压至零高，仍可能参与 `fit-content` 的固有宽度计算；`.hui-call-reveal` 通过 `contain: inline-size` 隔离这部分宽度，让收起气泡及悬停区域只包住步骤标题和摘要。`test:stream` 验证最终宽度；`--screenshot` 生成正常与悬停的步骤截图供视觉核对。
- 步骤悬停仅提亮整个面板的边框，不在标题按钮内另画一层矩形背景；否则宽度展开时会出现双层高亮。展开和收起的内容透明度与尺寸过渡同步，避免中途出现大片空玻璃。`--screenshot` 也保存展开、收起约 130ms 的中途帧。
- `ReplyPresentation` 仍复用等待气泡完成入场动画；进入正文阶段后外层承托整轮回复的玻璃背景撤除，每条调用自己承载玻璃表面，避免所有步骤被一块大玻璃包住。
- 顶部“设置”中的“面板透明度”滑杆统一控制主面板、侧栏、输入框、消息气泡、步骤和工具调用的底色强度，默认 55%，保存于渲染进程的 `localStorage`（`hui.panelTransparency`）。当前回复和折叠步骤使用同一套玻璃底色、边框与阴影，透明度变化只影响面板底色，不改变文字透明度。
- 顶部“设置 → 背景”可切换深灰纯色、黑灰流动与深色底的彩色流动，保存在 `localStorage` 的 `hui.backgroundMode`，默认彩色流动。彩色模式使用 GradFlow 的 WebGL `wave` 连续渐变；黑灰模式改由 `MottledBackground.tsx` 的多尺度值噪声与坐标扰动生成暗色斑驳纹理，不再使用会形成周期性横波的 `wave`。黑灰画布按窗口 65% 分辨率、约 25 FPS 绘制，暗部为近黑，亮部限于炭灰；纯色底色是 `#090a0d` 且不挂载画布。两个画布都在页面隐藏、不可见或系统减少动态效果时停止逐帧绘制。背景偏好与面板透明度独立，切换工作空间时保留。
- 顶部“设置 → 对话正文字号”滑杆即时调整 `.hui-md` 正文（13–20px，步长 0.5px，默认 15.5px），保存于 `localStorage` 的 `hui.chatFontSize`。Worker 将行内和行间公式里的 `\frac` 转成 `\dfrac`，并同步 remark-math 的渲染节点，让嵌套分式也使用清楚的展示样式。独占段落的公式改为左对齐的行间布局；嵌在文字中的公式仍保持行内。行间公式增加上下留白，避免分式被裁切。代码块保持自己的固定字体。`--screenshot` 的 `math-preview.png` 使用假内核复现带嵌套分母的 Z 变换推导，供排版目视检查。
- 用户消息气泡下方提供“复制”“撤回”。复制的是原始文本（保留 Markdown 源码）。撤回可选任意用户轮次，调用当前工作空间的 `session.revert({ messageID })`；opencode 会同时回退该轮及之后的回复与相关工作区文件改动。服务端通过会话的 `revert.messageID` 保留撤回边界，客户端据此隐藏该边界后的历史消息；输入框上方显示撤回轮数和“恢复撤回”，后者调用 `session.unrevert`。切换会话后读取 `session.get` 恢复边界；发出新一轮对话后不再提供恢复按钮，待内核清理已撤回消息。撤回进行中禁止重复点击，失败保持原对话，切换会话/工作空间时忽略迟到结果。`scripts/message-actions-regressions.cjs` 使用假内核覆盖这些操作。
- 底部 Agent/模型选择改用向上展开的玻璃菜单，带开关动画；输入框随内容增长，最高 192px，之后在输入框内部滚动。粘贴、拖拽和“＋”文件选择可添加图片或文件，发送时按 SDK 的 `FilePartInput` 用 data URL 与文本一起提交，单文件上限 25 MB。切换工作空间时清空待发送附件和未完成的文件读取。
- 界面正文统一使用随应用打包的 Noto Sans SC Variable；代码块、行内代码、工作空间路径和 KaTeX 保持各自的等宽/数学字体。字体 CSS 在 `main.tsx` 引入，构建后的字体文件无需联网加载；发布产物同时包含 `licenses/noto-sans-sc-OFL.txt`。
- `question.asked` SSE 事件及 `question.list` 用于显示当前会话的待答问题；弹出的玻璃询问框支持单选、多选和自定义回答，以当前目录调用 `question.reply` / `question.reject`。切换会话时重新读取待答列表，并忽略旧请求的迟到响应。Question 工具气泡仅显示状态，不再展开原始 JSON。`scripts/composer-regressions.cjs` 用假内核验证这些交互。

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
