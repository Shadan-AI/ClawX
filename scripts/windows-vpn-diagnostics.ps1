param(
  [switch]$IncludeEventLog = $true,
  [int]$LogTail = 160
)

$ErrorActionPreference = "Continue"

function Write-Section([string]$Title) {
  Write-Host ""
  Write-Host "==== $Title ===="
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Write-FileProbe([string]$Label, [string]$Path) {
  $exists = Test-Path -LiteralPath $Path
  Write-Host "$Label exists=$exists path=$Path"
  if ($exists) {
    try {
      $item = Get-Item -LiteralPath $Path
      Write-Host "  size=$($item.Length) lastWrite=$($item.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))"
    } catch {
      Write-Host "  statError=$($_.Exception.Message)"
    }
  }
}

function Get-OpenMeInstallRoots {
  $roots = @(
    (Join-Path $env:LOCALAPPDATA "Programs\OpenMe"),
    (Join-Path $env:ProgramFiles "OpenMe"),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} "OpenMe" })
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }

  $processRoots = Get-Process -Name "OpenMe", "openme", "ClawX", "clawx" -ErrorAction SilentlyContinue |
    ForEach-Object {
      try {
        if ($_.Path) { Split-Path -Parent $_.Path }
      } catch {
        $null
      }
    } |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }

  return @($roots + $processRoots) | Select-Object -Unique
}

function Get-OpenMeDataRoots {
  return @(
    (Join-Path $env:APPDATA "OpenMe"),
    (Join-Path $env:APPDATA "openme"),
    (Join-Path $env:APPDATA "ClawX"),
    (Join-Path $env:APPDATA "clawx"),
    (Join-Path $env:LOCALAPPDATA "OpenMe"),
    (Join-Path $env:LOCALAPPDATA "openme"),
    (Join-Path $env:LOCALAPPDATA "ClawX"),
    (Join-Path $env:LOCALAPPDATA "clawx")
  ) | Where-Object { $_ } | Select-Object -Unique
}

function Write-RedactedWireGuardConfig([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }

  Write-Host "--- config content with private key redacted: $Path ---"
  try {
    Get-Content -LiteralPath $Path | ForEach-Object {
      if ($_ -match '^\s*PrivateKey\s*=') {
        "PrivateKey = ***REDACTED***"
      } else {
        $_
      }
    }
  } catch {
    Write-Host "readConfigError=$($_.Exception.Message)"
  }
  Write-Host "--- end config ---"
}

Write-Section "OpenMe VPN Diagnostics"
Write-Host "Time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "User: $env:USERDOMAIN\$env:USERNAME"
Write-Host "IsAdmin: $(Test-Administrator)"
try {
  $os = Get-CimInstance Win32_OperatingSystem
  Write-Host "OS: $($os.Caption) $($os.Version) build=$($os.BuildNumber)"
} catch {
  Write-Host "OS query failed: $($_.Exception.Message)"
}
Write-Host "PowerShell: $($PSVersionTable.PSVersion)"
Write-Host "ProcessArch: $env:PROCESSOR_ARCHITECTURE"

Write-Section "OpenMe Processes"
Get-Process -Name "OpenMe", "openme", "ClawX", "clawx", "Electron" -ErrorAction SilentlyContinue |
  Select-Object Id, ProcessName, Path, StartTime |
  Format-List

Write-Section "OpenMe Install Roots"
$installRoots = @(Get-OpenMeInstallRoots)
if ($installRoots.Count -eq 0) {
  Write-Host "No common OpenMe install root found."
} else {
  $installRoots | ForEach-Object { Write-Host $_ }
}

Write-Section "Packaged VPN Files"
$helperCandidates = @()
$msiCandidates = @()
foreach ($root in $installRoots) {
  $helperCandidates += Join-Path $root "resources\bin\openme-vpn-helper.ps1"
  $helperCandidates += Join-Path $root "resources\app.asar.unpacked\resources\bin\openme-vpn-helper.ps1"
  $msiCandidates += Join-Path $root "resources\bin\wireguard-amd64-0.6.1.msi"
  $msiCandidates += Join-Path $root "resources\app.asar.unpacked\resources\bin\wireguard-amd64-0.6.1.msi"
}
if ($helperCandidates.Count -eq 0) {
  $helperCandidates += "No install root found; cannot infer helper path."
}
foreach ($path in ($helperCandidates | Select-Object -Unique)) {
  if ($path -like "No install root*") {
    Write-Host $path
  } else {
    Write-FileProbe "helper" $path
  }
}
foreach ($path in ($msiCandidates | Select-Object -Unique)) {
  Write-FileProbe "msi" $path
}

Write-Section "WireGuard Runtime"
$wireGuardExeCandidates = @(
  "$env:ProgramFiles\WireGuard\wireguard.exe",
  $(if (${env:ProgramFiles(x86)}) { "${env:ProgramFiles(x86)}\WireGuard\wireguard.exe" })
) | Where-Object { $_ } | Select-Object -Unique
foreach ($path in $wireGuardExeCandidates) {
  Write-FileProbe "wireguard.exe" $path
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    try {
      $version = & $path /version 2>&1
      Write-Host "  version=$version"
    } catch {
      Write-Host "  versionError=$($_.Exception.Message)"
    }
  }
}

Write-Section "OpenMe VPN Config"
$dataRoots = @(Get-OpenMeDataRoots)
$configCandidates = @()
foreach ($root in $dataRoots) {
  $configCandidates += Join-Path $root "vpn\clawx-wg0.conf"
  $configCandidates += Join-Path $root "vpn\wireguard.key"
}
$configCandidates = $configCandidates | Select-Object -Unique
foreach ($path in $configCandidates) {
  Write-FileProbe "vpn-file" $path
  if ($path -like "*.conf") {
    Write-RedactedWireGuardConfig $path
  }
}

Write-Section "WireGuard Tunnel Services"
$services = Get-CimInstance Win32_Service -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "WireGuardTunnel*" }
if (-not $services) {
  Write-Host "No WireGuardTunnel service found."
} else {
  $services | Select-Object Name, State, StartMode, ExitCode, ProcessId, PathName | Format-List
}

Write-Section "WireGuard Adapters"
Get-NetAdapter -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "*WireGuard*" -or $_.InterfaceDescription -like "*WireGuard*" -or $_.Name -like "*clawx*" } |
  Select-Object Name, InterfaceDescription, Status, MacAddress, LinkSpeed |
  Format-List

Write-Section "WireGuard IP Configuration"
Get-NetIPConfiguration -ErrorAction SilentlyContinue |
  Where-Object {
    $_.InterfaceAlias -like "*WireGuard*" -or
    $_.InterfaceDescription -like "*WireGuard*" -or
    $_.InterfaceAlias -like "*clawx*"
  } |
  Format-List

Write-Section "Routes Containing VPN Subnets"
Get-NetRoute -ErrorAction SilentlyContinue |
  Where-Object {
    $_.InterfaceAlias -like "*WireGuard*" -or
    $_.InterfaceAlias -like "*clawx*" -or
    $_.DestinationPrefix -like "10.*" -or
    $_.DestinationPrefix -like "172.16.*" -or
    $_.DestinationPrefix -like "192.168.*"
  } |
  Select-Object DestinationPrefix, NextHop, InterfaceAlias, RouteMetric, ifIndex |
  Sort-Object InterfaceAlias, DestinationPrefix |
  Format-Table -AutoSize

Write-Section "OpenMe VPN Helper Log"
$helperLog = "C:\ProgramData\OpenMe\vpn-helper.log"
Write-FileProbe "helper-log" $helperLog
if (Test-Path -LiteralPath $helperLog -PathType Leaf) {
  Get-Content -LiteralPath $helperLog -Tail $LogTail
}

Write-Section "WireGuard Install Log"
$installLog = Join-Path $env:TEMP "openme-wireguard-install.log"
Write-FileProbe "wireguard-install-log" $installLog
if (Test-Path -LiteralPath $installLog -PathType Leaf) {
  Get-Content -LiteralPath $installLog -Tail $LogTail
}

if ($IncludeEventLog) {
  Write-Section "Recent Service Control Manager Events"
  Get-WinEvent -LogName System -MaxEvents 300 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProviderName -match "Service Control Manager" -and
      ($_.Message -match "WireGuard|clawx-wg0|OpenMe")
    } |
    Select-Object TimeCreated, Id, ProviderName, Message |
    Format-List
}

Write-Section "Manual Status Command Hint"
Write-Host "Get-CimInstance Win32_Service | Where-Object Name -eq 'WireGuardTunnel`$clawx-wg0' | Select-Object Name,State,StartMode,ExitCode,PathName | Format-List"

Write-Section "Done"
