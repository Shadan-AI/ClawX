# uv 安装完成 - 后续步骤

## 当前状态

✅ uv 已经安装到：`C:\Users\gaom\.local\bin`  
❌ PATH 环境变量还没有生效

---

## 立即修复（当前 PowerShell 窗口）

在当前 PowerShell 窗口运行：

```powershell
$env:Path = "C:\Users\gaom\.local\bin;$env:Path"
```

然后验证：

```powershell
uv --version
```

**预期输出**：`uv 0.11.6`

---

## 永久修复（所有新窗口）

### 方法 1：使用 PowerShell 命令（推荐）

```powershell
# 获取当前用户 PATH
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")

# 添加 uv 路径（如果还没有）
if ($currentPath -notlike "*$env:USERPROFILE\.local\bin*") {
    $newPath = "$env:USERPROFILE\.local\bin;$currentPath"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "PATH 已更新！请重启 PowerShell 或重启电脑。"
} else {
    Write-Host "PATH 已经包含 uv 路径。"
}
```

### 方法 2：手动添加到系统 PATH

1. 按 `Win + R`，输入 `sysdm.cpl`，回车
2. 点击"高级"标签
3. 点击"环境变量"
4. 在"用户变量"部分，选择 `Path`，点击"编辑"
5. 点击"新建"
6. 输入：`C:\Users\gaom\.local\bin`
7. 点击"确定"保存所有对话框
8. 重启 PowerShell 或重启电脑

---

## 完整安装流程

### 1. 设置 PATH（当前窗口）

```powershell
$env:Path = "C:\Users\gaom\.local\bin;$env:Path"
```

### 2. 验证 uv

```powershell
uv --version
```

**预期输出**：`uv 0.11.6`

### 3. 安装 Python 3.12

```powershell
uv python install 3.12
```

**预期输出**：
```
Searching for Python 3.12...
Downloaded Python 3.12.x
Installed Python 3.12.x
```

### 4. 验证 Python

```powershell
uv python find 3.12
```

**预期输出**：Python 3.12 的路径

### 5. 重启 ClawX

- 完全退出 ClawX（右键托盘图标 → 退出）
- 重新启动 ClawX
- Gateway 应该自动启动

---

## 快速命令（复制粘贴）

```powershell
# 1. 设置 PATH
$env:Path = "C:\Users\gaom\.local\bin;$env:Path"

# 2. 验证 uv
uv --version

# 3. 安装 Python 3.12
uv python install 3.12

# 4. 验证 Python
uv python find 3.12

# 5. 永久添加到 PATH（可选）
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$env:USERPROFILE\.local\bin*") {
    $newPath = "$env:USERPROFILE\.local\bin;$currentPath"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Host "PATH 已永久更新！"
}
```

---

## 验证 Gateway 启动

### 方法 1：在 ClawX 中检查

1. 启动 ClawX
2. 查看侧边栏底部
3. 应该看到：🟢 **网关运行中**

### 方法 2：使用开发者工具

1. 在 ClawX 中按 `Ctrl+Shift+I`
2. 在 Console 中运行：
   ```javascript
   await window.electron.invoke('gateway:status')
   ```
3. 应该看到：
   ```json
   {
     "state": "running",
     "port": 18789,
     "pid": 12345
   }
   ```

### 方法 3：浏览器访问

打开浏览器，访问：http://localhost:18789

应该看到 Gateway 控制台界面。

---

## 如果还是不行

### 检查 1：uv 是否真的在 PATH 中

```powershell
$env:Path -split ';' | Select-String "\.local\\bin"
```

应该看到：`C:\Users\gaom\.local\bin`

### 检查 2：手动启动 Gateway

```powershell
cd D:\wmr\thinkgs\openme\openme
node openclaw.mjs gateway --port 18789 --token test --allow-unconfigured
```

观察错误信息。

### 检查 3：查看 ClawX 日志

```powershell
type "$env:APPDATA\ClawX\logs\main.log" | Select-Object -Last 50
```

---

## 常见问题

### Q: `uv --version` 还是找不到
**A:** 运行：
```powershell
$env:Path = "C:\Users\gaom\.local\bin;$env:Path"
```

### Q: Python 安装失败
**A:** 
```powershell
# 清理缓存
uv cache clean

# 重试
uv python install 3.12
```

### Q: Gateway 还是启动失败
**A:** 
1. 确保 uv 和 Python 都安装成功
2. 重启电脑（让所有环境变量生效）
3. 查看日志文件

---

## 下一步

完成上述步骤后：

1. ✅ uv 已安装并可用
2. ✅ Python 3.12 已安装
3. ✅ PATH 已设置（当前窗口或永久）
4. ✅ 重启 ClawX
5. ✅ Gateway 应该正常启动

然后你就可以：
- 使用聊天功能
- 看到半透明的输入框
- 看到输入框变大变小的效果

🎉 完成！
