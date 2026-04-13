# 聊天输入框展开/收起功能测试

## 功能说明

聊天输入框现在会根据滚动位置和焦点状态自动展开或收起：

- **展开状态**（大输入框）：
  - 当滚动到页面底部时
  - 或者当输入框获得焦点时
  
- **收起状态**（小输入框）：
  - 当向上滚动，不在页面底部时
  - 并且输入框没有焦点时

## 视觉变化

### 展开状态（isExpanded = true）
- 容器：`max-w-3xl p-4 pb-6`（更宽，更多内边距）
- 输入框边框：`shadow-md p-2`（阴影，更多内边距）
- 附件预览：完全可见
- Target 标签：完全可见
- Textarea：自动高度（最大 200px）

### 收起状态（isExpanded = false）
- 容器：`max-w-2xl px-4 py-2`（较窄，较少内边距）
- 输入框边框：`p-1`（较少内边距）
- 附件预览：`opacity-0 h-0`（隐藏）
- Target 标签：`opacity-0 h-0`（隐藏）
- Textarea：固定高度 `44px`

## 测试步骤

1. **打开聊天页面**
   - 输入框应该是展开状态（因为在底部）
   - 打开浏览器控制台，查看日志：`[Chat] Input state: { isAtBottom: true, isInputFocused: false, isInputExpanded: true }`

2. **发送几条消息**
   - 让页面有足够的内容可以滚动
   - 至少发送 5-10 条消息

3. **向上滚动**
   - 用鼠标滚轮或滚动条向上滚动
   - 当离开底部超过 100px 时，输入框应该收起
   - 控制台日志：`[Chat] Input state: { isAtBottom: false, isInputFocused: false, isInputExpanded: false }`
   - 视觉变化：输入框变窄、变小

4. **向下滚动回到底部**
   - 滚动回到页面底部
   - 输入框应该自动展开
   - 控制台日志：`[Chat] Input state: { isAtBottom: true, isInputFocused: false, isInputExpanded: true }`

5. **点击输入框（不在底部时）**
   - 向上滚动，让输入框收起
   - 点击输入框获得焦点
   - 输入框应该立即展开
   - 控制台日志：`[Chat] Input state: { isAtBottom: false, isInputFocused: true, isInputExpanded: true }`
   - 页面应该自动滚动到底部

6. **失去焦点（不在底部时）**
   - 点击页面其他地方，让输入框失去焦点
   - 如果不在底部，输入框应该收起
   - 控制台日志：`[Chat] Input state: { isAtBottom: false, isInputFocused: false, isInputExpanded: false }`

## 调试信息

代码中已添加 console.log，可以在浏览器控制台查看：

```javascript
// 每次状态变化时输出
[Chat] Input state: { isAtBottom: boolean, isInputFocused: boolean, isInputExpanded: boolean }

// 每次滚动时输出
[Chat] Scroll: { scrollTop: number, scrollHeight: number, clientHeight: number, isBottom: boolean }
```

## 常见问题

### Q: 我看不到任何变化
A: 确保页面有足够的内容可以滚动。如果消息太少，页面可能一直在底部，输入框会一直保持展开状态。

### Q: 输入框一直是展开的
A: 检查控制台日志，如果 `isAtBottom` 一直是 `true`，说明你一直在页面底部。尝试向上滚动。

### Q: 滚动时没有反应
A: 检查控制台是否有 `[Chat] Scroll:` 日志。如果没有，说明滚动事件没有触发，可能是滚动容器的问题。

### Q: 视觉变化太小，看不清楚
A: 主要变化是：
  - 容器宽度：`max-w-3xl` (48rem = 768px) → `max-w-2xl` (42rem = 672px)
  - 内边距：`p-4 pb-6` → `px-4 py-2`
  - 输入框内边距：`p-2` → `p-1`
  - Textarea 高度：自动 → 固定 44px

## 实现文件

- `ClawX/ClawX/src/pages/Chat/index.tsx` - 滚动检测和状态管理
- `ClawX/ClawX/src/pages/Chat/ChatInput.tsx` - 视觉变化实现
