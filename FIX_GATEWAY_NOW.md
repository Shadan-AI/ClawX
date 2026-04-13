# 修复 Gateway 启动问题 - 快速指南

## 问题诊断

你的 Gateway 启动失败是因为：**uv 没有安装**

uv 是 Python 包管理器，Gateway 需要它来管理 Python 环境和依赖。

---

## 快速修复（Windows）

### 方法 1：使用 PowerShell 安装（推荐）

1. **以管理员身份打开 PowerShell**
   - 按 `Win + X`
   - 选择"Windows PowerShell (管理员)"或"终端 (管理员)"

2. **运行安装命令**：
   ```powershell
   irm https://astral.sh/uv/install.ps1 | iex
   ```

3. **等待安装完成**（约 1-2 分钟）

4. **关闭并重新打开 PowerShell**（让 PATH 生效）

5. **验证安装**：
   ```powershell
   uv --version
   ```
   应该显示版本号，例如：`uv 0.5.0`

6. **安装 Python 3.12**：
   ```powershell
   uv python install 3.12
   ```

7. **重启 ClawX**

---

### 方法 2：使用 Scoop 安装

如果你已经安装了 Scoop：

```powershell
scoop install uv
uv python install 3.12
```

---

### 方法 3：使用 Chocolatey 安装

如果你已经安装了 Chocolatey：

```powershell
choco install uv
uv python install 3.12
```

---

### 方法 4：手动下载安装

1. 访问：https://github.com/astral-sh/uv/releases/latest
2. 下载 `uv-x86_64-pc-windows-msvc.zip`
3. 解压到 `C:\Program Files\uv\`
4. 添加到 PATH：
   - 右键"此电脑" → 属性 → 高级系统设置
   - 环境变量 → 系统变量 → Path → 编辑
   - 新建 → 输入 `C:\Program Files\uv`
   - 确定
5. 重启 PowerShell
6. 运行 `uv python install 3.12`

---

## 安装后验证

### 1. 检查 uv
```powershell
uv --version
```
**预期输出**：`uv 0.5.0` 或更高版本

### 2. 检查 Python
```powershell
uv python find 3.12
```
**预期输出**：Python 3.12 的路径

### 3. 重启 ClawX
- 完全退出 ClawX
- 重新启动
- Gateway 应该自动启动

---

## 如果还是不行

### 检查 1：PATH 环境变量

```powershell
$env:PATH -split ';' | Select-String uv
```

应该看到 uv 的路径。如果没有：
1. 重启 PowerShell
2. 或者重启电脑

### 检查 2：手动启动 Gateway

```powershell
cd ..\openme\openme
node openclaw.mjs gateway --port 18789 --token test --allow-unconfigured
```

观察错误信息。

### 检查 3：查看 ClawX 日志

```powershell
# 查看日志文件
type "$env:APPDATA\ClawX\logs\main.log" | Select-Object -Last 50
```

---

## 常见问题

### Q: 安装 uv 时提示"无法识别"
**A:** 需要以管理员身份运行 PowerShell

### Q: 安装后 `uv --version` 还是找不到
**A:** 
1. 关闭所有 PowerShell 窗口
2. 重新打开（让 PATH 生效）
3. 如果还是不行，重启电脑

### Q: Python 3.12 安装失败
**A:**
```powershell
# 清理缓存后重试
uv cache clean
uv python install 3.12
```

### Q: Gateway 还是启动失败
**A:** 查看详细日志：
```powershell
cd ClawX\ClawX
npm run dev
```
观察终端输出的错误信息

---

## 完整安装流程（从头开始）

如果你想完全重新安装：

```powershell
# 1. 安装 uv
irm https://astral.sh/uv/install.ps1 | iex

# 2. 关闭并重新打开 PowerShell

# 3. 验证 uv
uv --version

# 4. 安装 Python 3.12
uv python install 3.12

# 5. 验证 Python
uv python find 3.12

# 6. 进入 openme 目录
cd ..\openme\openme

# 7. 安装依赖
pnpm install

# 8. 构建
pnpm build

# 9. 进入 ClawX 目录
cd ..\..\ClawX\ClawX

# 10. 安装依赖
pnpm install

# 11. 启动开发服务器
npm run dev
```

---

## 验证 Gateway 启动成功

启动 ClawX 后，检查：

1. **侧边栏底部**：
   - 应该看到绿色圆点 + "网关运行中"

2. **开发者工具**（Ctrl+Shift+I）：
   ```javascript
   // 在 Console 中运行
   await window.electron.invoke('gateway:status')
   ```
   **预期输出**：
   ```json
   {
     "state": "running",
     "port": 18789,
     "pid": 12345
   }
   ```

3. **浏览器访问**：
   - 打开 http://localhost:18789
   - 应该看到 Gateway 控制台

---

## 需要帮助？

如果以上步骤都无法解决问题，请提供：

1. **uv 版本**：
   ```powershell
   uv --version
   ```

2. **Python 版本**：
   ```powershell
   uv python find 3.12
   ```

3. **ClawX 日志**：
   ```powershell
   type "$env:APPDATA\ClawX\logs\main.log" | Select-Object -Last 100
   ```

4. **手动启动输出**：
   ```powershell
   cd ..\openme\openme
   node openclaw.mjs gateway --port 18789 --token test --allow-unconfigured
   ```

将这些信息一起提供，我可以进一步帮你诊断。

---

## 总结

**问题**：Gateway 启动失败  
**原因**：uv 未安装  
**解决**：安装 uv + Python 3.12  
**命令**：
```powershell
irm https://astral.sh/uv/install.ps1 | iex
# 重启 PowerShell
uv python install 3.12
# 重启 ClawX
```

就这么简单！🎉
