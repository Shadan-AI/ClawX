# 启动 ClawX 开发模式

## 问题说明

你遇到的 `error: remote origin already exists` 是构建脚本的缓存问题，不影响开发模式。

---

## 快速启动（推荐）

直接运行开发模式，不需要完整构建：

```powershell
# 1. 设置 PATH（如果还没设置）
$env:Path = "C:\Users\gaom\.local\bin;$env:Path"

# 2. 进入 ClawX 目录
cd ClawX\ClawX

# 3. 启动开发模式
npm run dev
```

开发模式会：
- 自动准备预装技能（不会触发 git 错误）
- 启动 Vite 开发服务器
- 启动 Electron
- 自动启动 Gateway

---

## 如果还是有 git 错误

清理缓存后重试：

```powershell
# 清理预装技能缓存
Remove-Item -Recurse -Force build\preinstalled-skills -ErrorAction SilentlyContinue

# 清理 git 缓存
Remove-Item -Recurse -Force .git\modules\build -ErrorAction SilentlyContinue

# 重新启动
npm run dev
```

---

## 完整构建（仅在需要打包时）

如果你需要完整构建（打包成可执行文件），先清理缓存：

```powershell
# 1. 清理所有缓存
Remove-Item -Recurse -Force build -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force dist-electron -ErrorAction SilentlyContinue

# 2. 重新构建
pnpm run build
```

---

## 验证 Gateway 启动

启动开发模式后，检查：

### 1. 终端输出

应该看到：
```
Gateway process started (pid=12345)
Gateway listening on port 18789
```

### 2. ClawX 界面

- 侧边栏底部：🟢 **网关运行中**
- 输入框：半透明背景，可以输入

### 3. 浏览器测试

打开：http://localhost:18789

应该看到 Gateway 控制台。

---

## 如果 Gateway 还是启动失败

### 检查 1：uv 和 Python

```powershell
# 设置 PATH
$env:Path = "C:\Users\gaom\.local\bin;$env:Path"

# 检查 uv
uv --version

# 检查 Python
uv python find 3.12
```

如果 Python 不存在：
```powershell
uv python install 3.12
```

### 检查 2：手动测试 Gateway

```powershell
cd ..\openme\openme
node openclaw.mjs gateway --port 18789 --token test --allow-unconfigured
```

观察错误信息。

### 检查 3：查看日志

```powershell
# 开发模式的日志会直接输出到终端
# 或者查看日志文件
type "$env:APPDATA\OpenMe\logs\main.log" | Select-Object -Last 50
```

---

## 常见错误

### 错误 1：`uv: command not found`
```powershell
$env:Path = "C:\Users\gaom\.local\bin;$env:Path"
```

### 错误 2：`Python 3.12 not found`
```powershell
uv python install 3.12
```

### 错误 3：`Port 18789 already in use`
```powershell
# 查找占用进程
netstat -ano | findstr :18789

# 杀死进程
taskkill /PID <PID> /F
```

### 错误 4：`Cannot find module '@shadanai/openclaw'`
```powershell
# 重新安装依赖
pnpm install
```

---

## 总结

**不要运行 `pnpm run build`**，那是用来打包的。

**只需要运行 `npm run dev`** 就可以开发和测试了。

```powershell
# 完整启动流程
$env:Path = "C:\Users\gaom\.local\bin;$env:Path"
cd ClawX\ClawX
npm run dev
```

就这么简单！🎉
