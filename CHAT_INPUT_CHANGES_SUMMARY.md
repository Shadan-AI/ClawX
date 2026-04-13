# 聊天输入框展开/收起功能 - 修改总结

## 修改的文件

### 1. `src/pages/Chat/ChatInput.tsx`

#### 新增 Props
```typescript
interface ChatInputProps {
  // ... 原有 props
  isExpanded?: boolean;           // 新增：控制展开/收起状态
  onFocusChange?: (focused: boolean) => void;  // 新增：焦点变化回调
}
```

#### Textarea 高度逻辑修改
**之前**：始终自动调整高度
```typescript
useEffect(() => {
  if (textareaRef.current) {
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
  }
}, [input]);
```

**之后**：根据 `isExpanded` 状态调整
```typescript
useEffect(() => {
  if (textareaRef.current) {
    if (isExpanded) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    } else {
      textareaRef.current.style.height = '44px';  // 收起时固定高度
    }
  }
}, [input, isExpanded]);
```

#### 容器样式修改
**之前**：根据 `isEmpty` 调整宽度
```typescript
<div className={cn(
  "p-4 pb-6 w-full mx-auto transition-all duration-300",
  isEmpty ? "max-w-3xl" : "max-w-4xl"
)}>
```

**之后**：根据 `isExpanded` 调整宽度和内边距
```typescript
<div className={cn(
  "w-full mx-auto transition-all duration-300",
  isExpanded ? "max-w-3xl p-4 pb-6" : "max-w-2xl px-4 py-2"
)}>
```

#### 附件预览隐藏
**之前**：始终显示
```typescript
<div className="flex gap-2 mb-3 flex-wrap">
```

**之后**：收起时隐藏
```typescript
<div className={cn(
  "flex gap-2 mb-3 flex-wrap transition-all duration-300",
  !isExpanded && "opacity-0 h-0 mb-0 overflow-hidden"
)}>
```

#### 输入框边框样式
**之前**：固定样式
```typescript
<div className={`relative bg-white dark:bg-card rounded-[28px] shadow-sm border p-1.5 ...`}>
```

**之后**：根据 `isExpanded` 调整内边距和阴影
```typescript
<div className={cn(
  "relative bg-white dark:bg-card rounded-[28px] shadow-sm border transition-all",
  dragOver ? 'border-primary ring-1 ring-primary' : 'border-black/10 dark:border-white/10',
  isExpanded ? "shadow-md p-2" : "p-1"
)}>
```

#### Target 标签隐藏
**之前**：始终显示
```typescript
<div className="px-2.5 pt-2 pb-1">
```

**之后**：收起时隐藏
```typescript
<div className={cn(
  "px-2.5 pt-2 pb-1 transition-all duration-300",
  !isExpanded && "opacity-0 h-0 py-0 overflow-hidden"
)}>
```

#### 焦点事件处理
**新增**：通知父组件焦点状态变化
```typescript
<Textarea
  // ... 其他 props
  onFocus={() => onFocusChange?.(true)}
  onBlur={() => onFocusChange?.(false)}
/>
```

---

### 2. `src/pages/Chat/index.tsx`

#### 新增状态管理
```typescript
const [isAtBottom, setIsAtBottom] = useState(true);
const [isInputFocused, setIsInputFocused] = useState(false);
const isInputExpanded = isAtBottom || isInputFocused;
```

**逻辑**：
- `isAtBottom`：用户是否滚动到页面底部（距离底部 < 100px）
- `isInputFocused`：输入框是否获得焦点
- `isInputExpanded`：只要满足其中一个条件，输入框就展开

#### 滚动检测
```typescript
const handleScroll = useCallback(() => {
  if (scrollRef.current) {
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isBottom = scrollHeight - scrollTop - clientHeight < 100;
    setIsAtBottom(isBottom);
    console.log('[Chat] Scroll:', { scrollTop, scrollHeight, clientHeight, isBottom });
  }
}, [scrollRef]);

useEffect(() => {
  const scrollElement = scrollRef.current;
  if (scrollElement) {
    scrollElement.addEventListener('scroll', handleScroll);
    return () => scrollElement.removeEventListener('scroll', handleScroll);
  }
}, [handleScroll, scrollRef]);
```

#### 初始状态检测
```typescript
useLayoutEffect(() => {
  if (scrollRef.current) {
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isBottom = scrollHeight - scrollTop - clientHeight < 100;
    setIsAtBottom(isBottom);
  }
}, [currentSessionKey, scrollRef]);
```

#### 焦点时自动滚动到底部
```typescript
const scrollToBottom = useCallback(() => {
  if (scrollRef.current) {
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }
}, [scrollRef]);

useEffect(() => {
  if (isInputFocused) {
    scrollToBottom();
  }
}, [isInputFocused, scrollToBottom]);
```

#### 调试日志
```typescript
useEffect(() => {
  console.log('[Chat] Input state:', { isAtBottom, isInputFocused, isInputExpanded });
}, [isAtBottom, isInputFocused, isInputExpanded]);
```

#### 传递 Props 给 ChatInput
```typescript
<ChatInput
  onSend={sendMessage}
  onStop={abortRun}
  disabled={!isGatewayRunning}
  sending={sending}
  isExpanded={isInputExpanded}        // 新增
  onFocusChange={setIsInputFocused}   // 新增
/>
```

---

## 功能行为总结

### 展开条件（满足任一即可）
1. 用户滚动到页面底部（距离底部 < 100px）
2. 输入框获得焦点

### 收起条件（同时满足）
1. 用户不在页面底部（距离底部 >= 100px）
2. 输入框没有焦点

### 视觉变化对比

| 属性 | 展开状态 | 收起状态 |
|------|---------|---------|
| 容器宽度 | `max-w-3xl` (768px) | `max-w-2xl` (672px) |
| 容器内边距 | `p-4 pb-6` | `px-4 py-2` |
| 输入框边框内边距 | `p-2` | `p-1` |
| 输入框阴影 | `shadow-md` | `shadow-sm` |
| Textarea 高度 | 自动（最大 200px） | 固定 44px |
| 附件预览 | 完全可见 | `opacity-0 h-0`（隐藏） |
| Target 标签 | 完全可见 | `opacity-0 h-0`（隐藏） |

### 过渡动画
所有变化都有 `transition-all duration-300` 平滑过渡效果。

---

## 测试方法

1. **确保有足够内容**：发送多条消息，让页面可以滚动
2. **向上滚动**：输入框应该变小（收起）
3. **向下滚动到底部**：输入框应该变大（展开）
4. **点击输入框**：即使不在底部，输入框也应该展开并自动滚动到底部
5. **失去焦点**：如果不在底部，输入框应该收起

---

## 调试

打开浏览器控制台（F12），查看日志：

```
[Chat] Input state: { isAtBottom: true, isInputFocused: false, isInputExpanded: true }
[Chat] Scroll: { scrollTop: 0, scrollHeight: 1200, clientHeight: 800, isBottom: false }
```

这些日志可以帮助你理解当前状态和滚动位置。
