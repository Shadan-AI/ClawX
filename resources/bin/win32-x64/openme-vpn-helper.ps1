param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("install-start", "stop", "uninstall")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$ConfigPath
)

$ErrorActionPreference = "Stop"

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Quote-Arg([string]$Value) {
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Invoke-Elevated {
  $scriptPath = $PSCommandPath
  $args = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", (Quote-Arg $scriptPath),
    "-Action", (Quote-Arg $Action),
    "-ConfigPath", (Quote-Arg $ConfigPath)
  ) -join " "

  $proc = Start-Process -FilePath "powershell.exe" -ArgumentList $args -Verb RunAs -Wait -PassThru
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
    return $false
  }

  $logPath = Join-Path $env:TEMP "openme-wireguard-install.log"
  $args = @(
    "/i", $msiPath,
    "/qn",
    "/norestart",
    "/L*v", $logPath
  )

  $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList $args -Wait -PassThru -WindowStyle Hidden
  if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
    throw "Bundled WireGuard install failed with exit code $($proc.ExitCode). Log: $logPath"
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
  $proc = Start-Process -FilePath $WireGuardExe -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden
  if ($proc.ExitCode -ne 0 -and -not $IgnoreFailure) {
    throw "wireguard.exe $($Arguments -join ' ') failed with exit code $($proc.ExitCode)"
  }
}

if (-not (Test-Administrator)) {
  Invoke-Elevated
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
  throw "WireGuard config not found: $ConfigPath"
}

$wireGuardExe = Find-WireGuardExe
if (-not $wireGuardExe) {
  if (Install-BundledWireGuard) {
    $wireGuardExe = Find-WireGuardExe
  }
}

if (-not $wireGuardExe) {
  Write-Error "WireGuard for Windows was not found and bundled installation did not provide wireguard.exe."
  exit 20
}

$tunnelName = Get-TunnelName $ConfigPath
$serviceName = "WireGuardTunnel`$$tunnelName"

switch ($Action) {
  "install-start" {
    Invoke-WireGuard $wireGuardExe @("/uninstalltunnelservice", $tunnelName) -IgnoreFailure
    Invoke-WireGuard $wireGuardExe @("/installtunnelservice", $ConfigPath)
    & sc.exe config $serviceName start= delayed-auto | Out-Null
    $service = Get-Service -Name $serviceName -ErrorAction Stop
    if ($service.Status -ne "Running") {
      Start-Service -Name $serviceName -ErrorAction Stop
    }
  }
  "stop" {
    Stop-Service -Name $serviceName -ErrorAction SilentlyContinue
  }
  "uninstall" {
    Invoke-WireGuard $wireGuardExe @("/uninstalltunnelservice", $tunnelName) -IgnoreFailure
  }
}

exit 0
