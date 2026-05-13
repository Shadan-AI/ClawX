param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("install-start", "stop", "uninstall", "status")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$ConfigPath
)

$ErrorActionPreference = "Stop"

$LogDir = Join-Path $env:ProgramData "OpenMe"
$LogPath = Join-Path $LogDir "vpn-helper.log"

function Write-Log([string]$Message) {
  try {
    if (-not (Test-Path -LiteralPath $LogDir -PathType Container)) {
      New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }
    $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $Message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch {
    # Logging must never break VPN startup.
  }
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Quote-Arg([string]$Value) {
  if ($Value.Contains('"')) {
    throw "Argument contains unsupported quote character: $Value"
  }
  return '"' + $Value + '"'
}

function Invoke-Elevated {
  Write-Log "Requesting elevation: action=$Action config=$ConfigPath"
  $scriptPath = $PSCommandPath
  $powershellPath = Join-Path $PSHOME "powershell.exe"
  if (-not (Test-Path -LiteralPath $powershellPath -PathType Leaf)) {
    $powershellPath = "powershell.exe"
  }
  $elevatedArgs = @(
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", (Quote-Arg $scriptPath),
    "-Action", (Quote-Arg $Action),
    "-ConfigPath", (Quote-Arg $ConfigPath)
  ) -join " "

  $proc = Start-Process -FilePath $powershellPath -ArgumentList $elevatedArgs -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  exit $proc.ExitCode
}

function Find-WireGuardExe {
  $candidates = @()
  if ($env:CLAWX_WIREGUARD_BIN) {
    $candidates += $env:CLAWX_WIREGUARD_BIN
  }
  if ($PSScriptRoot) {
    $candidates += (Join-Path $PSScriptRoot "wireguard.exe")
  }
  if ($env:ProgramFiles) {
    $candidates += (Join-Path $env:ProgramFiles "WireGuard\wireguard.exe")
  }
  if (${env:ProgramFiles(x86)}) {
    $candidates += (Join-Path ${env:ProgramFiles(x86)} "WireGuard\wireguard.exe")
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  return $null
}

function Wait-WireGuardExe {
  for ($i = 0; $i -lt 15; $i++) {
    $exe = Find-WireGuardExe
    if ($exe) {
      return $exe
    }
    Start-Sleep -Seconds 1
  }

  return $null
}

function Find-BundledWireGuardMsi {
  $candidates = @()
  if ($env:CLAWX_WIREGUARD_MSI) {
    $candidates += $env:CLAWX_WIREGUARD_MSI
  }
  if ($PSScriptRoot) {
    $candidates += (Join-Path $PSScriptRoot "wireguard-amd64-0.6.1.msi")
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  return $null
}

function Install-BundledWireGuard {
  $msiPath = Find-BundledWireGuardMsi
  if (-not $msiPath) {
    Write-Log "Bundled WireGuard MSI not found"
    return $false
  }

  $logPath = Join-Path $env:TEMP "openme-wireguard-install.log"
  Write-Log "Installing bundled WireGuard MSI: $msiPath log=$logPath"
  $msiArgs = @(
    "/i", $msiPath,
    "/qn",
    "/norestart",
    "/L*v", $logPath
  )

  & msiexec.exe @msiArgs | Out-Null
  $exitCode = $LASTEXITCODE
  Write-Log "WireGuard MSI exit code: $exitCode"
  if ($exitCode -ne 0 -and $exitCode -ne 3010) {
    throw "Bundled WireGuard install failed with exit code $exitCode. Log: $logPath"
  }

  return $true
}

function Get-TunnelName([string]$Path) {
  $name = [IO.Path]::GetFileNameWithoutExtension($Path)
  $name = $name -replace '[^A-Za-z0-9_=+.-]', '-'
  if ([string]::IsNullOrWhiteSpace($name)) {
    throw "Invalid tunnel config name: $Path"
  }
  return $name
}

function Invoke-WireGuard([string]$WireGuardExe, [string[]]$Arguments, [switch]$IgnoreFailure) {
  Write-Log "Running wireguard.exe $($Arguments -join ' ')"
  & $WireGuardExe @Arguments | Out-Null
  $exitCode = $LASTEXITCODE
  Write-Log "wireguard.exe exit code: $exitCode"
  if ($exitCode -ne 0 -and -not $IgnoreFailure) {
    throw "wireguard.exe $($Arguments -join ' ') failed with exit code $exitCode"
  }
}

function Write-ServiceStatus([string]$ServiceName) {
  $svc = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
  if (-not $svc) {
    Write-Log "Service not found: $ServiceName"
    Write-Output "service=$ServiceName state=missing"
    return $false
  }

  Write-Log "Service status: name=$($svc.Name) state=$($svc.State) startMode=$($svc.StartMode) exitCode=$($svc.ExitCode) path=$($svc.PathName)"
  Write-Output "service=$($svc.Name) state=$($svc.State) startMode=$($svc.StartMode) exitCode=$($svc.ExitCode)"
  Write-Output "path=$($svc.PathName)"
  return $true
}

function Wait-ServiceRunning([string]$ServiceName) {
  for ($i = 0; $i -lt 20; $i++) {
    $svc = Get-Service -Name $ServiceName -ErrorAction Stop
    if ($svc.Status -eq "Running") {
      Write-Log "Service is running: $ServiceName"
      return
    }
    Start-Sleep -Seconds 1
  }

  $svc = Get-Service -Name $ServiceName -ErrorAction Stop
  throw "Service did not reach Running state: $ServiceName status=$($svc.Status)"
}

Write-Log "Helper start: action=$Action config=$ConfigPath admin=$(Test-Administrator)"

if (-not (Test-Administrator)) {
  Invoke-Elevated
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
  throw "WireGuard config not found: $ConfigPath"
}

$wireGuardExe = Find-WireGuardExe
if (-not $wireGuardExe) {
  if (Install-BundledWireGuard) {
    $wireGuardExe = Wait-WireGuardExe
  }
}

if (-not $wireGuardExe) {
  Write-Log "WireGuard executable unavailable after lookup/install"
  Write-Error "WireGuard for Windows was not found and bundled installation did not provide wireguard.exe."
  exit 20
}
Write-Log "Using WireGuard executable: $wireGuardExe"

$tunnelName = Get-TunnelName $ConfigPath
$serviceName = "WireGuardTunnel`$$tunnelName"
Write-Log "Tunnel name=$tunnelName service=$serviceName"

switch ($Action) {
  "install-start" {
    Invoke-WireGuard $wireGuardExe @("/uninstalltunnelservice", $tunnelName) -IgnoreFailure
    Invoke-WireGuard $wireGuardExe @("/installtunnelservice", $ConfigPath)
    & sc.exe config $serviceName start= delayed-auto | Out-Null
    $scExitCode = $LASTEXITCODE
    Write-Log "sc.exe config exit code: $scExitCode"
    if ($scExitCode -ne 0) {
      throw "sc.exe config failed with exit code $scExitCode for service $serviceName"
    }
    $service = Get-Service -Name $serviceName -ErrorAction Stop
    if ($service.Status -ne "Running") {
      Start-Service -Name $serviceName -ErrorAction Stop
    }
    Wait-ServiceRunning $serviceName
    Write-ServiceStatus $serviceName | Out-Null
  }
  "stop" {
    Stop-Service -Name $serviceName -ErrorAction SilentlyContinue
    Write-ServiceStatus $serviceName | Out-Null
  }
  "uninstall" {
    Invoke-WireGuard $wireGuardExe @("/uninstalltunnelservice", $tunnelName) -IgnoreFailure
    Write-ServiceStatus $serviceName | Out-Null
  }
  "status" {
    Write-ServiceStatus $serviceName | Out-Host
  }
}

Write-Log "Helper complete: action=$Action service=$serviceName"
exit 0
