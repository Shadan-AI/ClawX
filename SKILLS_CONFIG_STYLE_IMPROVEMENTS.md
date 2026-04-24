# 技能配置页面样式优化方案

## 🎨 设计理念
- 现代化渐变背景
- 柔和的阴影和边框
- 流畅的动画过渡
- 清晰的视觉层次

## 📋 优化清单

### 1. 整体布局
```tsx
// 添加渐变背景
className="flex flex-col gap-4 h-full p-6 bg-gradient-to-br from-background via-background to-muted/20"
```

### 2. 顶部员工选择器
```tsx
// 优化卡片样式
className="p-6 rounded-2xl border border-border/50 bg-gradient-to-br from-card via-card to-muted/30 shadow-lg backdrop-blur-sm"

// 优化图标容器
className="h-12 w-12 rounded-xl bg-gradient-to-br from-primary/20 via-primary/10 to-transparent border border-primary/20 shadow-sm"
```

### 3. 下拉菜单
```tsx
// 优化下拉菜单背景
className="bg-card/95 backdrop-blur-xl border border-border/50 rounded-xl shadow-2xl"

// 优化选项hover效果
className="hover:bg-gradient-to-r hover:from-primary/10 hover:to-primary/5"
```

### 4. 按钮样式
```tsx
// 主按钮 - 添加渐变
className="bg-gradient-to-r from-primary to-primary/90 hover:from-primary/90 hover:to-primary shadow-lg hover:shadow-xl transition-all duration-200"

// 次要按钮
className="border-2 hover:border-primary/50 hover:bg-primary/5 transition-all duration-200"
```

### 5. 模板卡片
```tsx
// 模板列表容器
className="p-5 rounded-2xl border border-border/50 bg-gradient-to-br from-card to-muted/20 shadow-md"

// 单个模板卡片
className="p-4 rounded-xl border-2 border-transparent hover:border-primary/30 bg-gradient-to-br from-card to-muted/10 hover:shadow-lg transition-all duration-300"

// 推荐模板
className="border-primary/40 bg-gradient-to-br from-primary/5 to-primary/10 shadow-md"
```

### 6. 技能卡片
```tsx
// 已选技能
className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-primary/10 to-primary/5 border-2 border-primary/30 hover:border-primary/50 hover:shadow-md transition-all duration-200"

// 可用技能
className="p-4 rounded-xl border-2 border-border/50 hover:border-primary/40 bg-card hover:bg-gradient-to-br hover:from-card hover:to-primary/5 hover:shadow-lg transition-all duration-300"
```

### 7. MD编辑器区域
```tsx
// 编辑器容器
className="rounded-xl border-2 border-border/50 bg-card shadow-inner overflow-hidden"

// 工具栏
className="flex items-center gap-2 p-3 bg-gradient-to-r from-muted/50 to-muted/30 border-b border-border/50"

// 文件标签
className="px-4 py-2 rounded-lg bg-gradient-to-r from-primary to-primary/90 text-primary-foreground shadow-sm"
className="px-4 py-2 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
```

### 8. 状态标识
```tsx
// 使用模板
className="bg-gradient-to-r from-blue-500/10 to-blue-400/10 text-blue-600 border-blue-500/30"

// 已自定义
className="bg-gradient-to-r from-green-500/10 to-green-400/10 text-green-600 border-green-500/30"

// 本地文件
className="bg-gradient-to-r from-gray-500/10 to-gray-400/10 text-gray-600 border-gray-500/30"
```

### 9. 动画效果
```tsx
// 页面进入动画
<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.3 }}
>

// 卡片hover动画
<motion.div
  whileHover={{ scale: 1.02, y: -2 }}
  transition={{ type: "spring", stiffness: 300 }}
>

// 按钮点击动画
<motion.button
  whileTap={{ scale: 0.95 }}
>
```

### 10. 搜索框
```tsx
className="h-11 rounded-xl border-2 border-border/50 bg-card/50 backdrop-blur-sm focus:border-primary/50 focus:bg-card focus:shadow-lg transition-all duration-200"
```

## 🎯 实施优先级

1. **高优先级**（立即实施）
   - 整体背景渐变
   - 顶部卡片样式
   - 按钮渐变效果
   - 模板卡片样式

2. **中优先级**（后续优化）
   - 技能卡片动画
   - 下拉菜单优化
   - 状态标识美化

3. **低优先级**（锦上添花）
   - 微交互动画
   - 加载状态优化
   - 过渡效果细节
