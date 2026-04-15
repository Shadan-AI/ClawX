# 数字员工技能功能实现文档

## 功能概述
为每个数字员工添加独立的技能管理功能，支持在UI界面中为员工添加/删除技能，并与数据库同步。同时提供官方员工模板，用户可以一键应用模板配置。

## 已完成的工作

### 1. 数据库层 ✅
- **文件**: `ai-chrome-ext-jeecg/jeecg-boot/db/migration/V20260414__add_im_user_skills.sql`
- **内容**: 在 `im_user` 表添加 `skills` 字段（TEXT类型，存储JSON数组）

### 2. 后端 API 层 ✅

#### 2.1 类型定义更新
- **文件**: `openme/openme/extensions/box-im/src/types.ts`
- **修改**: `BotInfo` 接口添加 `skills?: string[]` 字段

#### 2.2 API 客户端更新
- **文件**: `openme/openme/extensions/box-im/src/api-client.ts`
- **修改**:
  - `listBots()`: 添加 skills 字段映射，支持 JSON 字符串解析
  - `updateBotSkills()`: 新增函数，调用 `/bot/skills/{botId}` API 更新技能

#### 2.3 HTTP 处理器更新
- **文件**: `openme/openme/extensions/box-im/src/http-handler.ts`
- **修改**: 添加 `PUT /plugins/box-im/bots/:id/skills` 端点

### 3. 前端数据层 ✅

#### 3.1 类型定义更新
- **文件**: `ClawX/ClawX/src/stores/models.ts`
- **修改**:
  - `DigitalEmployee` 接口添加 `skills?: string[]` 字段
  - `ModelState` 接口添加 `updateEmployeeSkills` 方法

#### 3.2 Store 实现
- **文件**: `ClawX/ClawX/src/stores/models.ts`
- **修改**: 实现 `updateEmployeeSkills()` 方法
  - 调用后端 API 更新技能
  - 更新本地 state

## 待实现的工作

### 4. 员工模板功能 ⏳

#### 4.1 模板数据结构
```typescript
interface EmployeeTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  skills: string[];
  model?: string;
  isOfficial: boolean;
}
```

#### 4.2 官方模板定义
- **建议文件**: `ClawX/ClawX/src/data/employee-templates.ts`
- **内容**: 预定义的官方模板列表
  - 客服助手模板
  - 技术支持模板
  - 销售顾问模板
  - 内容创作模板
  - 数据分析模板

#### 4.3 模板 Store
- **文件**: `ClawX/ClawX/src/stores/templates.ts` (新建)
- **功能**:
  - `templates: EmployeeTemplate[]` - 模板列表
  - `fetchTemplates()` - 获取模板（本地或远程）
  - `applyTemplate(employeeId, templateId)` - 应用模板到员工

### 5. 前端 UI 层 ⏳

#### 5.1 数字员工页面更新
- **文件**: `ClawX/ClawX/src/pages/Agents/index.tsx`
- **需要添加**:
  1. 在员工卡片或详情中显示已分配的技能列表
  2. 添加"管理技能"按钮，打开技能管理对话框
  3. 添加"应用模板"按钮，打开模板选择对话框

#### 5.2 技能管理对话框组件
- **建议文件**: `ClawX/ClawX/src/components/agents/SkillsDialog.tsx`
- **功能**:
  - 显示当前员工的技能
  - 支持手动添加/删除技能
  - 显示"应用模板"按钮

#### 5.3 模板选择对话框组件
- **建议文件**: `ClawX/ClawX/src/components/agents/TemplateDialog.tsx`
- **功能**:
  - 显示所有可用模板（卡片形式）
  - 每个模板显示：
    - 图标和名称
    - 描述
    - 包含的技能列表
    - 推荐模型
  - 点击模板后预览效果
  - 确认应用按钮

#### 5.4 技能显示组件
- **建议文件**: `ClawX/ClawX/src/components/agents/SkillBadges.tsx`
- **功能**:
  - 接收 `skills: string[]` prop
  - 从 skills store 获取技能详情
  - 以 Badge 形式显示技能名称和图标

### 6. 同步机制 ⏳

#### 6.1 定期同步
- **文件**: `ClawX/ClawX/src/stores/models.ts`
- **需要添加**:
  - 在 `fetchDigitalEmployees()` 中自动获取最新的 skills 数据
  - 考虑添加定时刷新机制（如每5分钟）

#### 6.2 实时同步
- **可选**: 如果网站修改了技能，考虑通过 WebSocket 推送更新

## 数据流程图

```
┌─────────────────┐
│  数据库 im_user  │
│  skills (TEXT)  │
└────────┬────────┘
         │
         ↓
┌─────────────────────────┐
│  box-im API             │
│  GET /bot/list          │ ← 获取员工列表（含技能）
│  PUT /bot/skills/:id    │ ← 更新员工技能
└────────┬────────────────┘
         │
         ↓
┌─────────────────────────┐
│  ClawX Host API         │
│  /plugins/box-im/bots   │
│  /plugins/box-im/bots/  │
│    :id/skills           │
└────────┬────────────────┘
         │
         ↓
┌─────────────────────────┐      ┌──────────────────┐
│  models Store           │      │  templates Store │
│  digitalEmployees[]     │◄─────┤  templates[]     │
│  updateEmployeeSkills() │      │  applyTemplate() │
└────────┬────────────────┘      └──────────────────┘
         │
         ↓
┌─────────────────────────┐
│  Agents UI              │
│  - 显示技能列表          │
│  - 管理技能对话框        │
│  - 应用模板对话框        │
└─────────────────────────┘
```

## 官方模板示例

### 1. 客服助手模板
```typescript
{
  id: 'customer-service',
  name: '客服助手',
  description: '专业的客户服务，处理咨询、投诉和售后',
  icon: '👨‍💼',
  skills: [
    'web-search',      // 网络搜索
    'knowledge-base',  // 知识库查询
    'email',          // 邮件发送
    'calendar',       // 日程管理
  ],
  model: 'glm-5',
  isOfficial: true
}
```

### 2. 技术支持模板
```typescript
{
  id: 'tech-support',
  name: '技术支持',
  description: '解决技术问题，提供专业的技术指导',
  icon: '🔧',
  skills: [
    'code-interpreter', // 代码执行
    'web-search',       // 网络搜索
    'file-analysis',    // 文件分析
    'database-query',   // 数据库查询
  ],
  model: 'claude-sonnet-4-5',
  isOfficial: true
}
```

### 3. 内容创作模板
```typescript
{
  id: 'content-creator',
  name: '内容创作',
  description: '创作文章、文案、社交媒体内容',
  icon: '✍️',
  skills: [
    'web-search',      // 网络搜索
    'image-generation', // 图片生成
    'file-operations', // 文件操作
  ],
  model: 'glm-5',
  isOfficial: true
}
```

### 4. 数据分析模板
```typescript
{
  id: 'data-analyst',
  name: '数据分析',
  description: '分析数据、生成报表、可视化展示',
  icon: '📊',
  skills: [
    'code-interpreter', // 代码执行
    'file-analysis',    // 文件分析
    'database-query',   // 数据库查询
    'chart-generation', // 图表生成
  ],
  model: 'claude-sonnet-4-5',
  isOfficial: true
}
```

## API 接口说明

### GET /plugins/box-im/bots
**响应**:
```json
{
  "bots": [
    {
      "id": 1,
      "userName": "bot1",
      "nickName": "助手1",
      "headImage": "...",
      "openclawAgentId": "agent-1",
      "model": "glm-5",
      "nodeId": "node-1",
      "skills": ["skill-1", "skill-2"]
    }
  ]
}
```

### PUT /plugins/box-im/bots/:id/skills
**请求**:
```json
{
  "skills": ["skill-1", "skill-3", "skill-5"]
}
```

**响应**:
```json
{
  "success": true
}
```

## UI 交互流程

### 应用模板流程
```
1. 用户点击员工卡片的"管理技能"按钮
   ↓
2. 打开技能管理对话框
   ↓
3. 用户点击"应用模板"按钮
   ↓
4. 打开模板选择对话框，显示所有官方模板
   ↓
5. 用户选择一个模板（如"客服助手"）
   ↓
6. 显示模板详情和预览
   ↓
7. 用户点击"应用"按钮
   ↓
8. 调用 applyTemplate(employeeId, templateId)
   ↓
9. 更新员工的 skills 和 model（如果模板指定了）
   ↓
10. 关闭对话框，刷新员工列表
```

### 手动管理技能流程
```
1. 用户点击员工卡片的"管理技能"按钮
   ↓
2. 打开技能管理对话框
   ↓
3. 显示当前员工的技能列表
   ↓
4. 用户可以：
   - 点击"+"添加新技能
   - 点击技能的"×"删除技能
   ↓
5. 点击"保存"按钮
   ↓
6. 调用 updateEmployeeSkills(employeeId, skills)
   ↓
7. 关闭对话框，刷新员工列表
```

## 下一步行动

1. **执行数据库迁移**: 在 192.168.10.254 上运行 SQL 脚本
2. **创建模板数据**: 
   - 创建 `employee-templates.ts` 文件
   - 定义官方模板列表
3. **创建模板 Store**:
   - 创建 `templates.ts` store
   - 实现 `applyTemplate()` 方法
4. **实现 UI 组件**: 
   - 创建 TemplateDialog 组件
   - 创建 SkillsDialog 组件
   - 创建 SkillBadges 组件
   - 更新 Agents 页面
5. **测试流程**:
   - 测试应用模板
   - 测试手动添加/删除技能
   - 测试数据库同步
   - 测试多个员工独立管理技能

## 注意事项

1. **技能 ID 格式**: 使用 skill store 中的 skill.id 作为标识符
2. **空技能处理**: 新员工默认 skills 为空数组 `[]`
3. **模板更新**: 官方模板更新后，已应用模板的员工不会自动更新
4. **模型切换**: 应用模板时可选择是否同时切换模型
5. **错误处理**: UI 需要处理 API 调用失败的情况
6. **权限控制**: 确保只有授权用户可以修改员工技能
7. **模板扩展**: 未来可以支持用户自定义模板
