# ClawX Feature Comparison: Cartoon (Stashed) vs Feature2 (Current)

## 概述

本文档对比了你在 Cartoon 分支保存的本地修改（stash@{0}）与当前 feature2 分支之间的功能差异。

**对比时间**: 2026-04-13  
**Stash 信息**: `stash@{0}: On Cartoon: 保存本地修改 - 2026-04-13 09:28`  
**当前分支**: feature2

---

## 缺失功能总结

### 1. 设备节点选择功能 (Device Node Selection)

**影响文件**: 
- `src/pages/BoxImGate/index.tsx` (+170 行)
- `electron/utils/box-im-sync.ts` (+55 行)

**功能描述**:
在 BoxImGate 登录页面中，用户可以选择要绑定的设备节点（管理网关）。这个功能允许用户：
- 查看所有可用的设备节点列表
- 查看每个节点的详细信息（名称、IP地址、平台、连接状态）
- 自动选择本地设备节点（基于平台匹配）
- 手动选择要绑定的设备节点
- 登录成功后将选择的 deviceNodeId 保存到配置文件

**技术实现**:

#### 前端 (BoxImGate/index.tsx)

1. **新增接口定义**:
```typescript
interface DeviceNode {
  nodeId: string;
  displayName?: string;
  platform?: string;
  remoteIp?: string;
  connected?: boolean;
}
```

2. **新增状态管理**:
```typescript
const [deviceNodes, setDeviceNodes] = useState<DeviceNode[]>([]);
const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
const [nodeMenuOpen, setNodeMenuOpen] = useState(false);
const nodeMenuRef = useRef<HTMLDivElement>(null);
```

3. **新增功能函数**:
```typescript
// 从 gateway 获取设备节点列表
async function fetchDeviceNodes(): Promise<DeviceNode[]> {
  const response = await invokeIpc('gateway:rpc', 'node.list', {});
  return response?.success && response.result?.nodes 
    ? response.result.nodes 
    : [];
}
```

4. **自动选择本地节点**:
- 当 gateway 运行时自动获取设备节点列表
- 根据当前平台（Windows/Mac/Linux）自动匹配并选择本地节点
- 优先选择已连接且平台匹配的节点

5. **UI 组件**:
- 设备节点下拉选择器
- 显示节点名称、IP地址、平台信息
- 显示连接状态（已连接/未连接）
- 点击外部自动关闭下拉菜单

6. **配置保存**:
登录成功后，将选择的 deviceNodeId 保存到 openclaw.json:
```typescript
const patch = {
  channels: {
    'box-im': {
      deviceNodeId: selectedNodeId,
    },
  },
};
await invokeIpc('gateway:rpc', 'config.patch', { 
  raw: JSON.stringify(patch), 
  baseHash 
});
```

#### 后端 (box-im-sync.ts)

1. **配置读取增强**:
```typescript
export async function getBoxImConfig(): Promise<{
  tokenKey: string | null;
  apiUrl: string;
  ownerUserId: number | null;
  accounts: Record<string, BoxImAccount>;
  deviceNodeId: string | null;  // 新增
}> {
  // ...
  const deviceNodeId = typeof boxIm.deviceNodeId === 'string' 
    && boxIm.deviceNodeId.length > 0
    ? boxIm.deviceNodeId 
    : null;
  return { tokenKey, apiUrl, ownerUserId, accounts, deviceNodeId };
}
```

2. **新增导出函数**:
```typescript
/**
 * Read deviceNodeId from openclaw.json — the selected device node for this gateway.
 */
export async function getDeviceNodeId(): Promise<string | null> {
  const { deviceNodeId } = await getBoxImConfig();
  return deviceNodeId;
}
```

3. **同步日志增强**:
```typescript
logger.info(`[box-im] Synced ${bots.length} bots from API, deviceNodeId: ${deviceNodeId || 'not set'}`);
```

---

### 2. 智能体身份文档自动更新 (Agent Identity Auto-Update)

**影响文件**: 
- `electron/utils/box-im-sync.ts` (syncBots 函数)

**功能描述**:
在同步数字员工（bots）时，自动更新每个 bot 的 IDENTITY.md 文件，使用 bot 的 nickName 作为身份名称。

**技术实现**:
```typescript
// Update IDENTITY.md for each bot with their nickName
for (const bot of bots) {
  const agentId = bot.openclawAgentId || bot.userName || `bot-${bot.id}`;
  const acct = newAccounts[agentId];
  const nickName = bot.nickName || agentId;
  const workspace = acct 
    ? `${process.env.HOME || process.env.USERPROFILE || homedir()}/.openclaw/workspace-${agentId}` 
    : undefined;
  await updateAgentIdentityMd(agentId, nickName, workspace);
}
```

**作用**:
- 确保每个数字员工的身份文档与其在 ai-im 系统中的昵称保持同步
- 提升用户体验，让 bot 的身份信息更加准确

---

### 3. Token 使用历史性能优化 (Token Usage Performance Optimization)

**影响文件**: 
- `electron/utils/token-usage.ts` (getRecentTokenUsageHistory 函数)
- `src/pages/Models/index.tsx` (API 调用)

**功能描述**:
优化 token 使用历史的读取性能，避免读取过多文件导致性能问题。

**技术改进**:

#### 后端优化 (token-usage.ts)

1. **默认限制**:
```typescript
const maxEntries = typeof limit === 'number' && Number.isFinite(limit)
  ? Math.max(Math.floor(limit), 0)
  : 200; // default cap to avoid reading all files
```

2. **文件读取优化**:
```typescript
// Only read the most recent files needed
const filesToRead = files.slice(0, Math.min(files.length, maxEntries * 2));

// Read files concurrently
const allEntries = await Promise.all(
  filesToRead.map(async (file) => {
    try {
      const content = await readFile(file.filePath, 'utf8');
      return parseUsageEntriesFromJsonl(content, {
        sessionId: file.sessionId,
        agentId: file.agentId,
      });
    } catch (error) {
      logger.debug(`Failed to read token usage transcript ${file.filePath}:`, error);
      return [];
    }
  })
);

const results = allEntries.flat();
results.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
return results.slice(0, maxEntries);
```

**改进点**:
- 限制读取文件数量（最多 maxEntries * 2 个文件）
- 并发读取文件，提升性能
- 统一排序和截取逻辑

#### 前端优化 (Models/index.tsx)

```typescript
// 添加 limit 参数
const entries = await hostApiFetch<UsageHistoryEntry[]>(
  '/api/usage/recent-token-history?limit=200'
);
```

**性能提升**:
- 避免读取所有历史文件
- 减少内存占用
- 提升响应速度

---

## 功能对比表

| 功能 | Cartoon (Stashed) | Feature2 (Current) | 状态 |
|------|-------------------|-------------------|------|
| 设备节点选择 | ✅ 完整实现 | ❌ 缺失 | **缺失** |
| 自动选择本地节点 | ✅ 支持 | ❌ 不支持 | **缺失** |
| deviceNodeId 配置保存 | ✅ 支持 | ❌ 不支持 | **缺失** |
| 智能体身份文档自动更新 | ✅ 支持 | ❌ 不支持 | **缺失** |
| Token 使用历史性能优化 | ✅ 已优化 | ❌ 未优化 | **缺失** |
| 并发读取文件 | ✅ 支持 | ❌ 不支持 | **缺失** |
| 默认读取限制 | ✅ 200条 | ❌ 无限制 | **缺失** |

---

## 代码统计

### 修改文件数量
- 4 个文件被修改

### 代码行数变化
- `electron/utils/box-im-sync.ts`: +55 行
- `electron/utils/token-usage.ts`: +37 行修改
- `src/pages/BoxImGate/index.tsx`: +170 行
- `src/pages/Models/index.tsx`: +1 行修改

**总计**: 约 242 行新增，22 行删除

---

## 迁移建议

### 优先级 1: 设备节点选择功能
这是最重要的功能，涉及用户体验和系统架构。建议：
1. 先迁移 `box-im-sync.ts` 中的 deviceNodeId 相关代码
2. 再迁移 `BoxImGate/index.tsx` 中的 UI 和逻辑
3. 测试设备节点选择和保存功能

### 优先级 2: 性能优化
Token 使用历史的性能优化对大量使用场景很重要：
1. 迁移 `token-usage.ts` 的并发读取逻辑
2. 更新 `Models/index.tsx` 的 API 调用参数

### 优先级 3: 智能体身份文档更新
这是一个增强功能，可以最后迁移：
1. 确保 `updateAgentIdentityMd` 函数存在
2. 在 `syncBots` 函数中添加身份文档更新逻辑

---

## 恢复步骤

如果要将这些功能恢复到 feature2 分支：

```bash
# 1. 查看 stash 内容
git stash show 'stash@{0}' -p

# 2. 应用 stash（可能需要解决冲突）
git stash apply 'stash@{0}'

# 3. 或者选择性地应用特定文件
git checkout 'stash@{0}' -- electron/utils/box-im-sync.ts
git checkout 'stash@{0}' -- electron/utils/token-usage.ts
git checkout 'stash@{0}' -- src/pages/BoxImGate/index.tsx
git checkout 'stash@{0}' -- src/pages/Models/index.tsx

# 4. 测试功能
npm run dev

# 5. 提交更改
git add .
git commit -m "feat: 迁移设备节点选择、性能优化等功能从 Cartoon 分支"
```

---

## 注意事项

1. **依赖检查**: 确保 feature2 分支有所有必要的依赖（如 lucide-react 图标）
2. **API 兼容性**: 确认 gateway 的 `node.list` RPC 方法在 feature2 分支中可用
3. **配置结构**: 验证 openclaw.json 的配置结构是否兼容
4. **测试覆盖**: 迁移后需要全面测试设备节点选择流程

---

## 相关文档

- [ai-im/feature6-migration-plan.md](../../ai-im/feature6-migration-plan.md) - Box-IM 插件迁移方案
- [openme node-list-types.ts](../../openme/openme/src/shared/node-list-types.ts) - 设备节点类型定义

---

**文档生成时间**: 2026-04-13  
**作者**: Kiro AI Assistant
