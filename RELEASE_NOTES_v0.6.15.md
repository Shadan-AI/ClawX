# ClawX Release Notes

发布日期：2026-04-21

## 🐛 Bug Fixes

### 修复 "Processing tool results..." 卡住问题
- **问题**：智能体调用工具后卡在 "Processing tool results..." 状态，无法继续
- **根源**：`pendingFinal` 状态被错误设置为 `true` 且未清除
- **修复**：
  - 将 `runtime-event-handlers.ts` 中多处 `pendingFinal: true` 改为 `pendingFinal: false`
  - 添加 30 秒超时保护机制，防止永久卡住
  - 在工具执行完成时正确清除 `pendingFinal` 状态
  - 添加取消按钮，允许用户手动中断卡住的操作

### 修复 chat.history RPC 超时问题
- **问题**：用户加载会话历史时频繁遇到 "RPC timeout: chat.history" 错误
- **根源**：会话文件较大或磁盘 I/O 慢时，60 秒超时不够用
- **修复**：
  - 将 `chat.history` RPC 超时时间从 30 秒增加到 60 秒
  - 添加超时错误的智能处理：
    - 新会话超时时直接显示空会话，不报错
    - 尝试 fallback 到 cron 会话历史
  - 改进错误处理逻辑，避免误报错误

### 过滤 HEARTBEAT 系统消息
- **问题**：用户看到内部 HEARTBEAT 检查消息："Read HEARTBEAT.md if it exists..."
- **修复**：在前端过滤掉包含 "Read HEARTBEAT.md" 或 "HEARTBEAT_OK" 的系统消息
- **保留功能**：HEARTBEAT 机制仍然启用，只是不在 UI 中显示

### 优化技能安装逻辑
- **改进**：技能安装时检查 SKILL.md 中的 `name` 字段，防止重复安装同名技能
- **验证**：安装前验证文件夹是否包含有效的 SKILL.md 文件
- **错误提示**：提供更清晰的错误信息，指导用户如何解决冲突

### 改进错误处理
- **添加**：在 gateway 通知处理中增加 error phase 的专门处理
- **日志**：添加更多调试日志，便于排查问题

## 📝 技术改进

### 代码质量
- 添加超时保护机制，防止状态永久卡住
- 改进错误恢复逻辑
- 增强日志输出，便于问题诊断

### 用户体验
- 减少误报错误，避免用户困惑
- 隐藏内部系统消息，保持界面整洁
- 提供取消按钮，增强用户控制感

## 🔧 修改的文件

### 前端
- `src/stores/chat/runtime-event-handlers.ts` - 修复 pendingFinal 状态管理
- `src/stores/chat/history-actions.ts` - 增加超时时间和错误处理
- `src/stores/chat.ts` - 添加超时保护机制
- `src/pages/Chat/index.tsx` - 过滤 HEARTBEAT 消息，添加取消按钮
- `src/stores/gateway.ts` - 改进错误处理

### 后端
- `electron/main/ipc-handlers.ts` - 优化技能安装验证逻辑

## ⚠️ 注意事项

1. 此版本主要修复稳定性问题，建议所有用户升级
2. 如果仍然遇到超时问题，请检查：
   - 会话文件大小（位于 `~/.openclaw/agents/main/sessions/`）
   - 磁盘性能
   - 杀毒软件是否扫描 `.openclaw` 目录

## 🚀 升级说明

直接安装新版本即可，无需额外配置。
