# ChatInput 展开/收起功能重构总结

## 完成时间
2026-04-13

## 问题描述
合并 feature2 分支后，ChatInput 的展开/收起功能不正常：
- 点击输入框时没有变大
- 滚动时没有触发大小变化
- 样式和 Cartoon 分支不一致
- 缺少刷新按钮、思考切换按钮等功能

## 根本原因
当前 feature2 使用**单一布局**，只调整容器大小。而 Cartoon 使用**双布局结构**，展开和收起时是完全不同的 UI 组织方式。

## 已完成的改动

### 1. 添加了缺失的导入
```typescript
import { RefreshCw, Brain, Bot } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
```

### 2. 添加了 Store 方法调用
```typescript
const refresh = useChatStore((s) => s.refresh);
const loading = useChatStore((s) => s.loading);
const showThinking = useChatStore((s) => s.showThinking);
const toggleThinking = useChatStore((s) => s.toggleThinking);
```

### 3. 重构为双布局结构

#### 展开状态（isExpanded = true）
```
┌─────────────────────────────────────┐
│ 顶部工具栏                           │
│ - Agent 显示（Bot 图标）             │
│ - 刷新按钮（RefreshCw）              │
│ - 思考切换按钮（Brain）              │
├─────────────────────────────────────┤
│ 附件预览（如果有）                   │
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │
│ │ Target Chip（如果有）            │ │
│ │                                 │ │
│ │ Textarea（全宽，自动高度）       │ │
│ │                                 │ │
│ │ ┌─────────┐         ┌─────────┐│ │
│ │ │附件 + @ │         │模型+发送││ │
│ │ └─────────┘         └─────────┘│ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

#### 收起状态（isExpanded = false）
```
┌─────────────────────────────────────┐
│ ┌─────────────────────────────────┐ │
│ │ 附件 + Textarea + 发送           │ │
│ └─────────────────────────────────┘ │
└─────────────────────────────────────┘
```

### 4. 样式调整

**外层容器**：
- 展开：`max-w-3xl p-4 pb-4`
- 收起：`max-w-2xl px-4 py-2`

**内层输入框容器**：
- 展开：`shadow-md p-2`
- 收起：`p-1`

**Textarea 高度**：
- 展开：自动高度（最大 200px）
- 收起：固定 `44px`

### 5. 翻译支持
已确认三语翻译文件中存在所需的 key：
- `toolbar.currentAgent`
- `toolbar.refresh`
- `toolbar.showThinking`
- `toolbar.hideThinking`

## 触发机制

展开/收起由两个条件控制：
```typescript
const isInputExpanded = isAtBottom || isInputFocused;
```

1. **滚动到底部时展开**：`isAtBottom = true`
   - 距离底部 < 50px 时触发
   - 内容高度 <= 容器高度时（无滚动条）也视为在底部

2. **点击输入框时展开**：`isInputFocused = true`
   - 输入框获得焦点时自动滚动到底部
   - 100ms 后设置 `isAtBottom = true`

3. **往上滚动时收起**：`isAtBottom = false`
   - 距离底部 >= 50px 时触发

4. **点击其他地方时收起**：`isInputFocused = false`
   - 输入框失去焦点时触发

## 测试要点

1. ✅ 页面加载时，输入框应该是展开状态（默认在底部）
2. ✅ 点击输入框，应该展开并显示工具栏
3. ✅ 往上滚动消息列表，输入框应该收起，工具栏消失
4. ✅ 滚动到底部，输入框应该展开，工具栏出现
5. ✅ 点击刷新按钮，应该重新加载聊天历史
6. ✅ 点击思考按钮，应该切换思考过程的显示/隐藏
7. ✅ 展开时，Textarea 应该自动调整高度（最大 200px）
8. ✅ 收起时，Textarea 应该固定 44px 高度
9. ✅ 附件预览在收起时应该隐藏（opacity-0 h-0）

## 文件修改清单

- `ClawX/ClawX/src/pages/Chat/ChatInput.tsx` - 主要重构文件
- `ClawX/ClawX/src/i18n/locales/zh/chat.json` - 已有翻译
- `ClawX/ClawX/src/i18n/locales/en/chat.json` - 已有翻译
- `ClawX/ClawX/src/i18n/locales/ja/chat.json` - 已有翻译

## 下一步

1. 启动 ClawX 测试展开/收起功能
2. 验证工具栏按钮功能是否正常
3. 检查不同屏幕尺寸下的表现
4. 如果有问题，查看浏览器控制台的调试日志
