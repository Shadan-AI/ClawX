# 方案：生产环境首次启动 LAN TLS 证书生成 + WSS/TLS 握手 + openclaw.json 配置

> 本文档描述将 prod 分支中已有的实现移植到当前工作分支（merged-fix-and-HEAD）的完整方案。
> **请确认后再执行。**

---

## 一、目标

1. 生产环境（`app.isPackaged === true`）**首次启动**时，用打包进去的 `mkcert.exe` 为本机所有 LAN IPv4（+ localhost/127.0.0.1/::1）生成受信任的 TLS 证书，写入 `~/.openclaw/certs/`。
2. 在 `~/.openclaw/openclaw.json` 中写入 `gateway.tls`、`gateway.bind`、`gateway.controlUi` 等字段，使 OpenClaw Gateway 以 HTTPS/WSS 模式监听所有网卡。
3. Electron 主进程与 Gateway 之间的 WebSocket 连接升级为 `wss://`。
4. 用户可通过 `https://<LAN-IP>:18789` 在局域网内访问 OpenClaw 控制台。

---

## 二、prod 分支的实现方式（已研究清楚）

### 2.1 新增文件

| 文件 | 作用 |
|------|------|
| `electron/utils/mkcert-certs.ts` | 封装 mkcert 调用：枚举 LAN IP、运行 `-install`（UAC）、生成证书、在 `~/.openclaw/.env` 写 `CLAWX_CERTS_INITIALIZED=true` 防重复 |
| `electron/utils/openclaw-gateway-tls.ts` | 读取 `openclaw.json` 中 `gateway.tls.enabled`，供 ws-client / manager 判断用 `ws://` 还是 `wss://` |
| `electron/utils/openclaw-config-watch.ts` | 监听 `~/.openclaw/` 目录变化，防止 Gateway 启动后覆写 `models.providers.*.baseUrl` 为 LAN 地址 |
| `scripts/copy-mkcert.mjs` | 构建时把 `../openme/mkcert.exe`（或从 GitHub 下载）复制到 `resources/tools/mkcert.exe` |

### 2.2 修改文件

| 文件 | 改动要点 |
|------|---------|
| `electron/utils/openclaw-auth.ts` | 新增 `ensureLanOriginsInConfig(port)`、`ensureGatewayTlsEnabledInConfig()`、`mergeAllowedOriginsFromTemplate()`、`mergeGatewayTlsFromTemplate()` 等函数 |
| `electron/gateway/config-sync.ts` | 在 `syncGatewayConfigBeforeLaunch()` 中调用上述两个 ensure 函数；import `startOpenClawConfigLanReconciliationWatcher` |
| `electron/gateway/ws-client.ts` | `localGatewayWsUrl()` 根据 `tls` 参数返回 `wss://` 或 `ws://`；`wsClientOptionsForLocalGateway()` 在 TLS 时设 `rejectUnauthorized: false`（本地自签证书） |
| `electron/gateway/manager.ts` | 启动/探测/连接前调用 `getGatewayTlsEnabledFromOpenClawConfig()` 决定协议 |
| `electron/main/index.ts` | `runBackgroundInit()` 中，在 Gateway 启动前调用 `ensureOpenClawMkcertCertsWindows()`；注册 `certificate-error` 事件允许 `127.0.0.1` 自签证书 |
| `electron-builder.yml` | `build` 脚本末尾加 `&& zx scripts/copy-mkcert.mjs`；`extraResources` 中 `resources/` 已覆盖 `resources/tools/mkcert.exe` |
| `package.json` | `build` / `package` 脚本末尾加 `&& zx scripts/copy-mkcert.mjs` |

### 2.3 openme/gateway.json 模板中的关键字段

```json
"gateway": {
  "mode": "local",
  "bind": "lan",
  "controlUi": {
    "allowedOrigins": [
      "https://im.shadanai.com",
      "https://shadanai.com",
      "https://127.0.0.1:18789",
      "http://127.0.0.1:18789",
      "https://18789-322.vnc.shadanai.com",
      "https://18789-322.vnc.im.shadanai.com"
    ],
    "dangerouslyAllowHostHeaderOriginFallback": true,
    "allowInsecureAuth": true,
    "dangerouslyDisableDeviceAuth": true
  },
  "tls": {
    "enabled": true,
    "autoGenerate": true,
    "certPath": "~/.openclaw/certs/localhost.pem",
    "keyPath": "~/.openclaw/certs/localhost-key.pem"
  }
}
```

**注意**：`openme/gateway.json` 模板里的 `322` 是占位硬编码，**不是动态 userId**。prod 分支没有实现动态 VNC URL 注入。本方案将额外实现这一功能（见 Step 4b）。

---

## 三、完整执行步骤

### Step 1：新增 `electron/utils/mkcert-certs.ts`

**mkcert.exe 直接来自 openclaw npm 包，无需额外复制。** `getOpenClawDir()` 已经处理好了路径：
- 生产环境：`<resourcesPath>/openclaw/mkcert.exe`（electron-builder extraResources 打包进去的）
- 开发环境：`node_modules/@shadanai/openclaw/mkcert.exe`

`resolveBundledMkcertExe()` 实现：

```typescript
function resolveBundledMkcertExe(): string | null {
  // 直接从 openclaw 包目录取，生产/开发通用
  const fromOpenClaw = join(getOpenClawDir(), 'mkcert.exe');
  if (existsSync(fromOpenClaw)) return fromOpenClaw;
  return null;
}
```

`ensureOpenClawMkcertCertsWindows()` 核心流程：

```
1. 仅 win32 执行
2. 读 ~/.openclaw/.env，若 CLAWX_CERTS_INITIALIZED=true 且证书文件存在 → 跳过
3. 删旧证书
4. 枚举 RFC1918 LAN IPv4（networkInterfaces）
5. execFileAsyncVisible(mkcert, ['-install'])  ← 弹 UAC 安装根 CA（一次性）
6. execFileAsync(mkcert, ['-cert-file', ..., '-key-file', ..., localhost, 127.0.0.1, ::1, ...lanIPs])
7. 写 CLAWX_CERTS_INITIALIZED=true 到 ~/.openclaw/.env
```

### Step 2：新增 `electron/utils/openclaw-gateway-tls.ts`

```typescript
// 读 openclaw.json → gateway.tls.enabled
export async function getGatewayTlsEnabledFromOpenClawConfig(): Promise<boolean>
```

### Step 3：新增 `electron/utils/openclaw-config-watch.ts`

```typescript
// 监听 ~/.openclaw 目录，防止 Gateway 覆写 models.providers.*.baseUrl
export function startOpenClawConfigLanReconciliationWatcher(): void
```

### Step 4：修改 `electron/utils/openclaw-auth.ts`

新增以下导出函数（从 prod 移植）：

- `ensureLanOriginsInConfig(port = 18789)` — 枚举 LAN IP，向 `gateway.controlUi.allowedOrigins` 注入 `https://<ip>:18789` 和 `http://<ip>:18789`
- `ensureGatewayTlsEnabledInConfig()` — 确保 `gateway.tls.enabled=true`、写 certPath/keyPath、设 `gateway.bind='lan'`
- `mergeAllowedOriginsFromTemplate()` — 内部辅助，合并模板中的 allowedOrigins（union）及三个 boolean 标志
- `mergeGatewayTlsFromTemplate()` — 内部辅助，从模板合并 tls 块

同时在 `syncGatewayTokenToConfig()` 中确保 `gateway.mode = 'local'`（已有）。

### Step 4b：新增 `ensureVncOriginsInConfig(userId, port)` 并在登录时调用

prod 分支模板里的 VNC URL 是硬编码 `322`，本方案额外实现动态 userId 注入。

在 `electron/utils/openclaw-auth.ts` 中新增：

```typescript
/**
 * 登录成功后，将用户专属 VNC URL 注入 gateway.controlUi.allowedOrigins。
 * 格式：https://18789-<userId>.vnc.shadanai.com
 *       https://18789-<userId>.vnc.im.shadanai.com
 */
export async function ensureVncOriginsInConfig(userId: number, port = 18789): Promise<void> {
  if (!userId || userId <= 0) return;
  return withConfigLock(async () => {
    const config = await readOpenClawJson();
    if (!config.gateway || typeof config.gateway !== 'object') return;
    const gw = config.gateway as Record<string, unknown>;
    if (!gw.controlUi || typeof gw.controlUi !== 'object') {
      gw.controlUi = {};
    }
    const cui = gw.controlUi as Record<string, unknown>;
    const existing = Array.isArray(cui.allowedOrigins)
      ? (cui.allowedOrigins as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const toAdd = [
      `https://${port}-${userId}.vnc.shadanai.com`,
      `https://${port}-${userId}.vnc.im.shadanai.com`,
    ].filter((o) => !existing.includes(o));
    if (toAdd.length === 0) return;
    // 移除旧的同端口 VNC 条目（userId 可能变化）
    const vncPattern = new RegExp(`^https://${port}-\\d+\\.vnc\\.(im\\.)?shadanai\\.com$`);
    const cleaned = existing.filter((o) => !vncPattern.test(o));
    cui.allowedOrigins = [...cleaned, ...toAdd];
    await writeOpenClawJson(config);
  });
}
```

在 `electron/utils/wx-auth.ts` 的 `persistLoginResult` 函数末尾（`writeOpenClawConfig` 之后）调用：

```typescript
// 5. 注入用户专属 VNC origins（best-effort）
if (userId && userId > 0) {
  try {
    await ensureVncOriginsInConfig(userId, 18789);
  } catch (err) {
    console.warn('[wx-auth] VNC origins inject failed (non-fatal):', err);
  }
}
```

### Step 5：修改 `electron/gateway/config-sync.ts`

在 `syncGatewayConfigBeforeLaunch()` 中，`syncGatewayTokenToConfig` 之后加：

```typescript
// Windows: 确保 gateway.tls 已启用
if (process.platform === 'win32') {
  try {
    await ensureGatewayTlsEnabledInConfig();
  } catch (err) {
    logger.warn('Failed to ensure gateway TLS config:', err);
  }
}

// 注入当前机器 LAN IP 到 controlUi.allowedOrigins
try {
  await ensureLanOriginsInConfig(18789);
} catch (err) {
  logger.warn('Failed to inject LAN origins into gateway config:', err);
}

// 启动 watcher 防止 Gateway 覆写 models.providers baseUrl
startOpenClawConfigLanReconciliationWatcher();
```

同时在 import 区加入新函数和 watcher。

### Step 6：修改 `electron/gateway/ws-client.ts`

```typescript
function localGatewayWsUrl(port: number, tls: boolean): string {
  const proto = tls ? 'wss' : 'ws';
  return `${proto}://127.0.0.1:${port}/ws`;
}

function wsClientOptionsForLocalGateway(tls: boolean): ClientOptions | undefined {
  if (!tls) return undefined;
  return { rejectUnauthorized: false }; // 本地 mkcert 自签证书
}
```

所有调用 `probeGatewayReady` / `connectGatewaySocket` / `waitForGatewayReady` 的地方传入 `tls` 参数。

### Step 7：修改 `electron/gateway/manager.ts`

在 `findExistingGateway`、`waitForReady`、`connect` 等关键节点前调用：

```typescript
const tls = await getGatewayTlsEnabledFromOpenClawConfig();
```

然后将 `tls` 传给 ws-client 函数。

### Step 8：修改 `electron/main/index.ts`

1. 顶部 import：
   ```typescript
   import { ensureOpenClawMkcertCertsWindows } from '../utils/mkcert-certs';
   ```

2. `runBackgroundInit()` 最前面（Gateway 启动前）：
   ```typescript
   if (process.platform === 'win32') {
     try {
       const mk = await ensureOpenClawMkcertCertsWindows();
       if (mk.ok && !mk.skipped) logger.info(`[mkcert] TLS certs ready: ${mk.certDir}`);
       else if (mk.skipped) logger.debug(`[mkcert] skipped: ${mk.reason}`);
       else logger.warn(`[mkcert] ${mk.error}`);
     } catch (e) {
       logger.warn('[mkcert] ensure certs failed:', e);
     }
   }
   ```

3. 注册 `certificate-error` 事件（允许本地自签证书）：
   ```typescript
   app.on('certificate-error', (event, _wc, url, _err, _cert, callback) => {
     if (url.startsWith('https://127.0.0.1:') || url.startsWith('https://localhost:')) {
       event.preventDefault();
       callback(true);
     } else {
       callback(false);
     }
   });
   ```

### Step 9：~~新增 `scripts/copy-mkcert.mjs`~~（不需要）

mkcert.exe 已经在 `@shadanai/openclaw` npm 包里，electron-builder 的 `extraResources` 把整个 `build/openclaw/` 打包为 `<resourcesPath>/openclaw/`，mkcert.exe 随之一起进去。**无需额外的 copy 脚本。**

### Step 10：`package.json` 无需修改

不再需要 `&& zx scripts/copy-mkcert.mjs`。

### Step 11：确认 `electron-builder.yml`

`extraResources` 中已有：
```yaml
- from: resources/
  to: resources/
  filter:
    - "**/*"
```
这会自动打包 `resources/tools/mkcert.exe`，**无需额外修改**。

---

## 四、运行时流程（生产环境首次启动）

```
app.whenReady()
  └─ initialize()
       └─ runBackgroundInit()
            ├─ [win32] ensureOpenClawMkcertCertsWindows()
            │    ├─ 读 ~/.openclaw/.env → CLAWX_CERTS_INITIALIZED 未设置
            │    ├─ 找到 <resourcesPath>/resources/tools/mkcert.exe
            │    ├─ 枚举 LAN IP（如 192.168.1.100）
            │    ├─ mkcert -install  ← 弹 UAC，安装根 CA 到系统信任库
            │    ├─ mkcert -cert-file ~/.openclaw/certs/localhost.pem
            │    │         -key-file  ~/.openclaw/certs/localhost-key.pem
            │    │         localhost 127.0.0.1 ::1 192.168.1.100
            │    └─ 写 CLAWX_CERTS_INITIALIZED=true → ~/.openclaw/.env
            │
            ├─ syncGatewayConfigBeforeLaunch()
            │    ├─ seedOpenClawJsonFromTemplateIfMissing()  ← 首次：从 gateway.json 模板生成
            │    ├─ mergeOpenClawJsonFromTemplateForMissingSections()
            │    ├─ ensureGatewayTlsEnabledInConfig()
            │    │    └─ openclaw.json: gateway.tls.enabled=true, certPath/keyPath, bind=lan
            │    ├─ ensureLanOriginsInConfig(18789)
            │    │    └─ openclaw.json: gateway.controlUi.allowedOrigins += https://192.168.1.100:18789
            │    └─ startOpenClawConfigLanReconciliationWatcher()
            │
            └─ gatewayManager.start()
                 ├─ getGatewayTlsEnabledFromOpenClawConfig() → true
                 ├─ waitForGatewayReady({ port: 18789, tls: true })
                 │    └─ probeGatewayReady → wss://127.0.0.1:18789/ws
                 └─ connectGatewaySocket({ tls: true })
                      └─ new WebSocket('wss://127.0.0.1:18789/ws', { rejectUnauthorized: false })
```

**第二次启动**：`CLAWX_CERTS_INITIALIZED=true` 且证书文件存在 → mkcert 步骤直接跳过。

**用户扫码登录后**（`persistLoginResult` 触发）：

```
persistLoginResult(tokenKey, userId=322, ...)
  ├─ writeOpenClawConfig(cfg)  ← 写 ownerAuth / shadan provider
  └─ ensureVncOriginsInConfig(322, 18789)
       └─ openclaw.json: gateway.controlUi.allowedOrigins +=
            "https://18789-322.vnc.shadanai.com"
            "https://18789-322.vnc.im.shadanai.com"
            （同时移除旧的同端口 VNC 条目，防止 userId 变化后残留）
```

---

## 五、最终 openclaw.json gateway 字段示例

（以 userId=322、LAN IP=192.168.1.100 为例）

```json
"gateway": {
  "mode": "local",
  "bind": "lan",
  "auth": { "mode": "token", "token": "<clawx-token>" },
  "controlUi": {
    "allowedOrigins": [
      "https://im.shadanai.com",
      "https://shadanai.com",
      "https://127.0.0.1:18789",
      "http://127.0.0.1:18789",
      "https://192.168.1.100:18789",
      "http://192.168.1.100:18789",
      "https://18789-322.vnc.shadanai.com",
      "https://18789-322.vnc.im.shadanai.com",
      "file://"
    ],
    "dangerouslyAllowHostHeaderOriginFallback": true,
    "allowInsecureAuth": true,
    "dangerouslyDisableDeviceAuth": true
  },
  "tls": {
    "enabled": true,
    "autoGenerate": true,
    "certPath": "~/.openclaw/certs/localhost.pem",
    "keyPath": "~/.openclaw/certs/localhost-key.pem"
  }
}
```

VNC URL 中的 `322` 来自扫码登录后 `persistLoginResult` 拿到的 `userId`，每次登录后动态更新（旧条目自动清除）。

---

## 六、涉及文件清单

### 新增（从 prod 移植，精简版）
- `electron/utils/mkcert-certs.ts` — mkcert 路径直接用 `getOpenClawDir()`，无需 copy 脚本
- `electron/utils/openclaw-gateway-tls.ts`
- `electron/utils/openclaw-config-watch.ts`

### 修改
- `electron/utils/openclaw-auth.ts` — 新增 5 个函数（含 `ensureVncOriginsInConfig`）
- `electron/utils/wx-auth.ts` — `persistLoginResult` 末尾调用 `ensureVncOriginsInConfig(userId)`
- `electron/gateway/config-sync.ts` — 调用 TLS/LAN ensure 函数 + watcher
- `electron/gateway/ws-client.ts` — 支持 `tls` 参数，切换 ws/wss
- `electron/gateway/manager.ts` — 读取 TLS 配置，传给 ws-client
- `electron/main/index.ts` — 调用 mkcert + certificate-error 事件
- `electron-builder.yml` — 无需修改（openclaw 包已含 mkcert.exe，随 extraResources 打包）

### 无需修改/新增
- `scripts/copy-mkcert.mjs` — 不需要，mkcert.exe 已在 openclaw npm 包内
- `package.json` — build/package 脚本无需改动

---

## 七、注意事项

1. **UAC 弹窗**：`mkcert -install` 在 Windows 上需要管理员权限，会弹 UAC。这是一次性操作（首次启动），之后 `CLAWX_CERTS_INITIALIZED=true` 跳过。
2. **跳过开关**：设置环境变量 `CLAWX_SKIP_MKCERT=1` 可完全跳过；`CLAWX_REGENERATE_MKCERT=1` 可强制重新生成。
3. **非 Windows**：`ensureOpenClawMkcertCertsWindows()` 在非 win32 平台直接返回 `{ ok: true, skipped: true }`，不影响 macOS/Linux。
4. **`rejectUnauthorized: false`**：仅用于 `127.0.0.1` 本地连接（Electron 主进程 → Gateway），不影响外部 HTTPS 安全性。
5. **LAN IP 动态注入**：每次启动都会重新枚举 LAN IP 并追加到 `allowedOrigins`（去重），适应 IP 变化。
6. **mkcert.exe 来源**：直接用 `getOpenClawDir()` 找到 openclaw npm 包里自带的 `mkcert.exe`，生产环境是 `<resourcesPath>/openclaw/mkcert.exe`，开发环境是 `node_modules/@shadanai/openclaw/mkcert.exe`。**不需要额外的 copy 脚本或 `resources/tools/` 目录。**
7. **VNC URL 动态注入**：用户扫码登录成功后，`persistLoginResult` 拿到 `userId`，调用 `ensureVncOriginsInConfig(userId)` 写入 `https://18789-<userId>.vnc.shadanai.com` 和 `https://18789-<userId>.vnc.im.shadanai.com`。同时用正则清除旧的同端口 VNC 条目，防止 userId 变化后残留脏数据。模板里的 `322` 占位条目会在首次登录后被替换。
