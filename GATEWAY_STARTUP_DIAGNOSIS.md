# Gateway 启动失败诊断

## 常见原因

Gateway 启动失败通常是以下几个原因之一：

### 1. OpenClaw 包不存在
**错误信息**：`OpenClaw package not found`

**检查方法**：
```bash
# 开发环境
ls -la node_modules/@shadanai/openclaw
ls -la node_modules/openclaw

# 生产环境（打包后）
ls -la resources/openclaw
```

**解决方案**：
```bash
# 重新安装依赖
pnpm install

# 或者清理后重装
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

---

### 2. OpenClaw 未构建
**错误信息**：`OpenClaw entry script not found`

**检查方法**：
```bash
# 检查 openclaw.mjs 是否存在
ls -la node_modules/@shadanai/openclaw/openclaw.mjs
ls -la node_modules/openclaw/openclaw.mjs

# 检查 dist 目录
ls -la node_modules/@shadanai/openclaw/dist
```

**解决方案**：
```bash
# 进入 openme 目录构建
cd ../openme/openme
pnpm install
pnpm build

# 或者使用 link
cd ../openme/openme
pnpm link --global
cd ../../ClawX/ClawX
pnpm link --global @shadanai/openclaw
```

---

### 3. Python 环境未就绪
**错误信息**：`Python 3.12 not found`

**检查方法**：
```bash
# 检查 uv 是否安装
uv --version

# 检查 Python 3.12
uv python find 3.12
```

**解决方案**：
```bash
# 安装 uv（如果没有）
# Windows (PowerShell)
irm https://astral.sh/uv/install.ps1 | iex

# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# 安装 Python 3.12
uv python install 3.12
```

---

### 4. 端口被占用
**错误信息**：`Port 18789 already in use`

**检查方法**：
```bash
# Windows
netstat -ano | findstr :18789

# macOS/Linux
lsof -i :18789
```

**解决方案**：
```bash
# Windows - 杀死占用端口的进程
taskkill /PID <PID> /F

# macOS/Linux
kill -9 <PID>

# 或者在 ClawX 设置中更改端口
```

---

### 5. 权限问题
**错误信息**：`EACCES` 或 `Permission denied`

**检查方法**：
```bash
# 检查 ~/.openclaw 目录权限
ls -la ~/.openclaw

# 检查 node_modules 权限
ls -la node_modules/@shadanai/openclaw
```

**解决方案**：
```bash
# 修复权限
chmod -R 755 ~/.openclaw
chmod -R 755 node_modules/@shadanai/openclaw

# Windows 上以管理员身份运行
```

---

### 6. 依赖缺失
**错误信息**：`Cannot find module` 或 `MODULE_NOT_FOUND`

**检查方法**：
```bash
# 检查 openme 依赖
cd ../openme/openme
pnpm list

# 检查 ClawX 依赖
cd ../../ClawX/ClawX
pnpm list
```

**解决方案**：
```bash
# 重新安装所有依赖
cd ../openme/openme
rm -rf node_modules pnpm-lock.yaml
pnpm install
pnpm build

cd ../../ClawX/ClawX
rm -rf node_modules pnpm-lock.yaml
pnpm install
```

---

## 诊断步骤

### 步骤 1：检查 OpenClaw 状态

在 ClawX 中打开开发者工具（Ctrl+Shift+I），在 Console 中运行：

```javascript
// 检查 OpenClaw 状态
await window.electron.invoke('openclaw:getStatus')
```

**预期输出**：
```json
{
  "packageExists": true,
  "isBuilt": true,
  "entryPath": "/path/to/openclaw.mjs",
  "version": "x.x.x"
}
```

**如果 `packageExists: false`**：
- OpenClaw 包不存在，需要安装

**如果 `isBuilt: false`**：
- OpenClaw 未构建，需要运行 `pnpm build`

---

### 步骤 2：检查 Gateway 日志

**开发环境**：
```bash
# 查看 Electron 主进程日志
# 日志会输出到终端

# 或者查看日志文件
# Windows
type %APPDATA%\ClawX\logs\main.log

# macOS
cat ~/Library/Logs/ClawX/main.log

# Linux
cat ~/.config/ClawX/logs/main.log
```

**生产环境**：
```bash
# 打开应用后，查看日志文件位置
# 在 ClawX 中：Help → Show Logs
```

---

### 步骤 3：手动启动 Gateway

尝试手动启动 Gateway 来查看详细错误：

```bash
# 进入 openme 目录
cd ../openme/openme

# 手动启动 Gateway
node openclaw.mjs gateway --port 18789 --token test-token --allow-unconfigured
```

**观察输出**：
- 如果成功启动，会看到 `Gateway listening on port 18789`
- 如果失败，会看到具体的错误信息

---

### 步骤 4：检查环境变量

```bash
# 检查 PATH
echo $PATH  # macOS/Linux
echo %PATH%  # Windows

# 检查 NODE_PATH
echo $NODE_PATH  # macOS/Linux
echo %NODE_PATH%  # Windows

# 检查 Python
python3 --version
uv python find 3.12
```

---

### 步骤 5：运行 OpenClaw Doctor

OpenClaw 自带诊断工具：

```bash
cd ../openme/openme
node openclaw.mjs doctor
```

这会检查：
- Python 环境
- 依赖完整性
- 配置文件
- 权限问题

---

## 快速修复脚本

### Windows (PowerShell)

```powershell
# 完整重置和重装
cd ClawX\ClawX
Remove-Item -Recurse -Force node_modules, pnpm-lock.yaml -ErrorAction SilentlyContinue

cd ..\..\openme\openme
Remove-Item -Recurse -Force node_modules, pnpm-lock.yaml -ErrorAction SilentlyContinue
pnpm install
pnpm build

cd ..\..\ClawX\ClawX
pnpm install

# 检查 OpenClaw
node -e "console.log(require.resolve('@shadanai/openclaw/package.json'))"
```

### macOS/Linux (Bash)

```bash
# 完整重置和重装
cd ClawX/ClawX
rm -rf node_modules pnpm-lock.yaml

cd ../../openme/openme
rm -rf node_modules pnpm-lock.yaml
pnpm install
pnpm build

cd ../../ClawX/ClawX
pnpm install

# 检查 OpenClaw
node -e "console.log(require.resolve('@shadanai/openclaw/package.json'))"
```

---

## 常见错误信息对照表

| 错误信息 | 原因 | 解决方案 |
|---------|------|---------|
| `OpenClaw package not found` | OpenClaw 未安装 | `pnpm install` |
| `OpenClaw entry script not found` | OpenClaw 未构建 | `cd openme && pnpm build` |
| `Python 3.12 not found` | Python 环境未就绪 | `uv python install 3.12` |
| `Port 18789 already in use` | 端口被占用 | 杀死占用进程或更改端口 |
| `EACCES` / `Permission denied` | 权限问题 | `chmod -R 755` 或以管理员运行 |
| `Cannot find module` | 依赖缺失 | `pnpm install` |
| `MODULE_NOT_FOUND` | 模块路径错误 | 检查 pnpm link 或重装 |
| `spawn ENOENT` | 可执行文件不存在 | 检查 PATH 或重装 |
| `ETIMEDOUT` | 网络超时 | 检查代理设置或网络连接 |

---

## 获取帮助

如果以上方法都无法解决问题，请提供以下信息：

1. **操作系统和版本**：
   ```bash
   # Windows
   systeminfo | findstr /B /C:"OS Name" /C:"OS Version"
   
   # macOS
   sw_vers
   
   # Linux
   lsb_release -a
   ```

2. **Node.js 版本**：
   ```bash
   node --version
   npm --version
   pnpm --version
   ```

3. **OpenClaw 状态**：
   ```javascript
   await window.electron.invoke('openclaw:getStatus')
   ```

4. **Gateway 日志**：
   - 复制最近的错误日志

5. **手动启动输出**：
   ```bash
   cd openme/openme
   node openclaw.mjs gateway --port 18789 --token test --allow-unconfigured
   ```

6. **环境变量**：
   ```bash
   echo $PATH
   echo $NODE_PATH
   ```

将这些信息一起提供，可以更快地定位问题。
