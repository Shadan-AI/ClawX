# feature1 分支功能说明

## 概述

本次在 `feature1` 分支（基于 `main`）上，从 `prod` 分支移植了三项核心功能：

1. npm 私有包 `@shadanai/openclaw` 替代公开包 `openclaw`
2. `openclaw.json` 写入字段扩展（LAN origins 受信源）
3. box-im 频道插件支持

> 注意：TLS 强制开启功能已移植但在 feature1 中**禁用**，原因见下方说明。

---

## 功能一：npm 私有包 `@shadanai/openclaw`

### 背景

`prod` 分支使用内部私有 fork `@shadanai/openclaw` 替代公开 npm 包 `openclaw`。
私有包内嵌了 `box-im` 等扩展，路径为 `@shadanai/openclaw/extensions/box-im`。

### 修改文件

#### `ClawX/package.json`

```diff
- "openclaw": "2026.4.1",
+ "@shadanai/openclaw": "latest",
```

将 `devDependencies` 中的固定版本公开包替换为私有包，使用 `latest` 标签保持自动跟进最新版本。

#### `ClawX/electron/utils/paths.ts`

`getOpenClawDir()` 在 dev 模式下原来硬编码返回 `node_modules/openclaw`，改为优先查找私有包：

```diff
- // Development: use node_modules/openclaw
- return join(__dirname, '../../node_modules/openclaw');

+ // Development: prefer private fork, fall back to public package
+ const privateDir = join(__dirname, '../../node_modules/@shadanai/openclaw');
+ if (existsSync(privateDir)) {
+   return privateDir;
+ }
+ return join(__dirname, '../../node_modules/openclaw');
```

这是网关能正确启动的关键——不修改此处，dev 模式下网关会用旧的公开包启动，与 `openclaw.json` 版本不兼容导致卡死。

#### `ClawX/scripts/bundle-openclaw.mjs`

打包脚本负责将 openclaw 及其所有依赖打包进 `build/openclaw/` 供 electron-builder 使用。

原来硬编码只查找 `node_modules/openclaw`，改为双路径回退逻辑：

```diff
- const openclawLink = path.join(NODE_MODULES, 'openclaw');
- if (!fs.existsSync(openclawLink)) {
-   echo`❌ node_modules/openclaw not found. Run pnpm install first.`;
-   process.exit(1);
- }
- const openclawReal = fs.realpathSync(openclawLink);

+ const openclawLinkCandidates = [
+   path.join(NODE_MODULES, '@shadanai', 'openclaw'),
+   path.join(NODE_MODULES, 'openclaw'),
+ ];
+ const openclawLink = openclawLinkCandidates.find((p) => fs.existsSync(p));
+ if (!openclawLink) {
+   echo`❌ OpenClaw package not found under node_modules (@shadanai/openclaw or openclaw). Run pnpm install first.`;
+   process.exit(1);
+ }
+ const openclawReal = fs.realpathSync(openclawLink);
+ let openclawPkgName = 'openclaw';
+ try {
+   const pkg = JSON.parse(fs.readFileSync(path.join(openclawReal, 'package.json'), 'utf8'));
+   if (typeof pkg.name === 'string' && pkg.name) openclawPkgName = pkg.name;
+ } catch { /* keep default */ }
```

同时将 BFS 遍历时的 `skipPkg` 从硬编码 `'openclaw'` 改为动态读取的 `openclawPkgName`：

```diff
- queue.push({ nodeModulesDir: openclawVirtualNM, skipPkg: 'openclaw' });
+ queue.push({ nodeModulesDir: openclawVirtualNM, skipPkg: openclawPkgName });
```

---

## 功能二：`openclaw.json` 字段扩展（LAN origins）

### 背景

`prod` 分支将本机 LAN IP 注入到 `gateway.controlUi.allowedOrigins`，使局域网内其他设备可以访问控制 UI。`prod` 分支还有 TLS 强制开启逻辑，但 feature1 的 ClawX 代码不支持 WSS 探测，因此 TLS 部分已移植但禁用。

### 修改文件

#### `ClawX/electron/utils/openclaw-auth.ts`

在文件顶部补充 `networkInterfaces` import：

```diff
- import { homedir } from 'os';
+ import { homedir, networkInterfaces } from 'os';
```

在文件末尾新增两个导出函数（均已移植，TLS 函数暂不调用）：

**`ensureLanOriginsInConfig(port = 18789)`** — 已启用

扫描本机所有网络接口，找出私有 LAN IPv4 地址（`192.168.x.x`、`10.x.x.x`、`172.16-31.x.x`），
将对应的 `https://<ip>:<port>` 和 `http://<ip>:<port>` 写入 `openclaw.json` 的
`gateway.controlUi.allowedOrigins` 数组（幂等，已存在的不重复添加）。

**`ensureGatewayTlsEnabledInConfig()`** — 已移植，暂不调用

确保 `openclaw.json` 中 `gateway.tls` 字段存在且已启用，写入标准证书路径，并将 `gateway.bind` 设为 `"lan"`。

> 此函数已移植但在 `syncGatewayConfigBeforeLaunch` 中被注释掉。原因：feature1 的 `ws-client.ts` 健康检查只支持 `ws://`，若开启 TLS 网关会监听 `wss://`，导致健康检查永远无法通过，网关卡死。prod 分支有完整的 WSS 探测支持，feature1 暂未移植该部分。

#### `ClawX/electron/gateway/config-sync.ts`

更新 import，引入新增的两个函数：

```diff
- import { syncGatewayTokenToConfig, syncBrowserConfigToOpenClaw,
-   syncSessionIdleMinutesToOpenClaw, sanitizeOpenClawConfig } from '../utils/openclaw-auth';
+ import { syncGatewayTokenToConfig, syncBrowserConfigToOpenClaw,
+   syncSessionIdleMinutesToOpenClaw, sanitizeOpenClawConfig,
+   ensureGatewayTlsEnabledInConfig, ensureLanOriginsInConfig } from '../utils/openclaw-auth';
```

在 `syncGatewayConfigBeforeLaunch` 中，TLS 调用被注释，LAN origins 正常启用：

```typescript
// TLS 强制开启已注释 — feature1 的 ws-client.ts 不支持 wss:// 探测
// if (process.platform === 'win32') {
//   await ensureGatewayTlsEnabledInConfig();
// }

// 注入本机 LAN IP 到受信源列表
try {
  await ensureLanOriginsInConfig(18789);
} catch (err) {
  logger.warn('Failed to inject LAN origins into gateway config:', err);
}
```

`ensureExtensionDepsResolvable` 函数也做了修复，防止 extension 依赖覆盖 openclaw 自身的包：

```typescript
// 先扫描 openclaw virtual store 里已有的包，extension 依赖不会覆盖 openclaw 自己的包
const ownedByOpenclaw = new Set<string>();
// ... 扫描 openclawVirtualNM
// 创建 symlink 前先检查
if (ownedByOpenclaw.has(pkg.name)) continue;
```

---

## 功能三：box-im 频道插件

### 背景

`box-im` 是 `prod` 分支内置的企业 IM 频道插件，其源码位于私有包
`@shadanai/openclaw/extensions/box-im` 内，不在公开 npm registry 上单独发布。

### 修改文件

#### `ClawX/scripts/bundle-openclaw-plugins.mjs`

在 `PLUGINS` 数组中新增 `box-im` 条目：

```diff
  const PLUGINS = [
    { npmName: '@soimy/dingtalk', pluginId: 'dingtalk' },
    { npmName: '@wecom/wecom-openclaw-plugin', pluginId: 'wecom' },
    { npmName: '@larksuite/openclaw-lark', pluginId: 'feishu-openclaw-plugin' },
    { npmName: '@tencent-weixin/openclaw-weixin', pluginId: 'openclaw-weixin' },
+   {
+     npmName: '@openclaw/box-im',
+     pluginId: 'box-im',
+     sourcePath: path.join(NODE_MODULES, '@shadanai', 'openclaw', 'extensions', 'box-im'),
+   },
  ];
```

`bundleOnePlugin` 函数同步更新，支持 `sourcePath` 参数：当提供时直接使用该路径而不去 `node_modules` 查找，依赖收集仍走 pnpm virtual store BFS。

#### `ClawX/electron/gateway/config-sync.ts`

更新 `CHANNEL_PLUGIN_MAP`，类型定义扩展支持可选的 `devOpenclawExtensionRel` 字段，
并添加 `box-im` 映射：

```diff
- const CHANNEL_PLUGIN_MAP: Record<string, { dirName: string; npmName: string }> = {
+ const CHANNEL_PLUGIN_MAP: Record<
+   string,
+   { dirName: string; npmName: string; devOpenclawExtensionRel?: string }
+ > = {
    dingtalk: { dirName: 'dingtalk', npmName: '@soimy/dingtalk' },
    wecom: { dirName: 'wecom', npmName: '@wecom/wecom-openclaw-plugin' },
    feishu: { dirName: 'feishu-openclaw-plugin', npmName: '@larksuite/openclaw-lark' },
    'openclaw-weixin': { dirName: 'openclaw-weixin', npmName: '@tencent-weixin/openclaw-weixin' },
+   'box-im': {
+     dirName: 'box-im',
+     npmName: '@openclaw/box-im',
+     devOpenclawExtensionRel: 'extensions/box-im',
+   },
  };
```

`BUILTIN_CHANNEL_EXTENSIONS` 移除 `qqbot`（main 分支误加，qqbot 应走插件安装流程）：

```diff
- const BUILTIN_CHANNEL_EXTENSIONS = ['discord', 'telegram', 'qqbot'];
+ const BUILTIN_CHANNEL_EXTENSIONS = ['discord', 'telegram'];
```

dev 模式回退逻辑支持从 `@shadanai/openclaw` 内部路径加载 box-im：

```typescript
let npmPkgPath = join(process.cwd(), 'node_modules', ...npmName.split('/'));
if (
  pluginInfo.devOpenclawExtensionRel &&
  !existsSync(fsPath(join(npmPkgPath, 'openclaw.plugin.json')))
) {
  const alt = join(
    process.cwd(), 'node_modules', '@shadanai', 'openclaw',
    pluginInfo.devOpenclawExtensionRel,
  );
  if (existsSync(fsPath(join(alt, 'openclaw.plugin.json')))) {
    npmPkgPath = alt;
  }
}
```

---

## 修改文件汇总

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `ClawX/package.json` | 依赖替换 | `openclaw` → `@shadanai/openclaw: latest` |
| `ClawX/electron/utils/paths.ts` | 逻辑修改 | `getOpenClawDir()` dev 模式优先返回 `@shadanai/openclaw` 路径 |
| `ClawX/scripts/bundle-openclaw.mjs` | 逻辑修改 | 双路径回退解析私有包，动态读取包名 |
| `ClawX/scripts/bundle-openclaw-plugins.mjs` | 新增条目 + 逻辑修改 | 插件列表加入 `box-im`；`bundleOnePlugin` 支持 `sourcePath` 直接路径模式 |
| `ClawX/electron/gateway/config-sync.ts` | 多处修改 | 插件映射表扩展、LAN origins 调用、extension 依赖保护、dev 回退路径 |
| `ClawX/electron/utils/openclaw-auth.ts` | 新增函数 | `ensureLanOriginsInConfig`（启用）、`ensureGatewayTlsEnabledInConfig`（移植但暂不调用） |

---

## 运行时行为变化

- dev 模式下网关入口自动指向 `@shadanai/openclaw`，不再使用旧的公开包
- 每次网关启动前，本机 LAN IP 会被自动写入受信源列表，局域网设备可直接访问控制 UI（端口 18789）
- `box-im` 插件在开发模式下从 `@shadanai/openclaw/extensions/box-im` 加载，打包模式下从 `build/openclaw-plugins/box-im` 加载
- extension 依赖不再覆盖 openclaw 自身的包版本（修复了 `file-type` 版本冲突导致网关崩溃的问题）

---

## 已知限制

- TLS / WSS 支持未完整移植：`ensureGatewayTlsEnabledInConfig` 已移植但禁用。若需启用，还需同步移植 prod 分支的 `ws-client.ts` WSS 探测逻辑（`probeGatewayReady` 的 `tls` 参数支持）和 `getGatewayTlsEnabledFromOpenClawConfig` 工具函数。
