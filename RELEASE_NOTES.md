# Huarnessy v0.2.0

Windows x64 便携版。解压 `Huarnessy-v0.2.0-win-x64.zip` 后运行目录中的 `Huarnessy.exe`。

## 内核兼容与连接诊断更新

- 保留 OpenCode 1.x，新增 OpenCode TUI 2.0.32 的 REST、鉴权和原生 SSE 适配。包括会话、模型与 Agent、文件附件、命令与技能、停止、压缩、撤回与恢复、权限和表单交互。
- 标题栏显示连接阶段，首次连接展示进度和耗时。失败时展示原因与处理建议；会话历史、模型和配置读取失败也会出现在界面中。
- 新增“选择内核”和“恢复自动选择”。自动优先级为用户选择、OPENCODE_BIN、Clonely 托管内核、PATH；手动选择会保存，失效时明确提示。
- 点击连接状态可查看路径、版本、启动阶段、退出信息、HTTP 请求状态和脱敏日志，并复制诊断报告。报告不包含连接凭据和请求体。
- 修复启动请求无限等待、旧启动结果覆盖新状态、初始状态订阅竞态，以及健康接口成功却事件连接尚未就绪时允许发送的问题。
- 2.x 断线后自动重连，并补查历史和待交互请求。文本结束快照不会重复追加；工作空间切换会取消旧请求和事件订阅。

连接实测版本为 **1.18.29 和 2.0.32**，覆盖真实内核启动、浏览器 SDK 和 SSE，以及生产版 `file://` 跨域鉴权。聊天功能通过独立假内核回归验证，没有发送真实模型请求；不以测试耗时代表真实模型速度。其他 2.x 版本会检查协议后尝试连接，不保证所有版本均兼容。

本更新不附带内核，不自动安装、升级或降级 OpenCode，也不迁移用户配置。现有用户需要运行新版客户端；分发便携版请使用 `npm run package:release` 重新打包。

验证入口：`npm run typecheck`、`npm run build`、`npm run test:kernel`、`npm run test:workspace`、`npm run test:kernel-ui`（可加 `--production`），以及 `npm run test:stream` 的常规、`--large` 和 `--production` 模式。真实内核检查使用 `test:kernel-ui -- --production --real`，二进制路径配置见 AgentReadme。
