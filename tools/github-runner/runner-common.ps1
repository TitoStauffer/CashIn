# Shared settings and helpers for the local self-hosted runner that executes the agent Code Review
# and QA jobs (label "codex-plus"). Compatible with Windows PowerShell 5.1.
Set-StrictMode -Version Latest

$script:RunnerRepository = 'TitoStauffer/CashIn'
$script:RunnerName = 'cashin-codex-plus-windows'
# config.cmd always adds the default labels (self-hosted, Windows, X64); only custom labels go here.
$script:RunnerCustomLabels = 'codex-plus'

# Pinned official releases. Update version and SHA-256 together (see README).
$script:RunnerVersion = '2.338.2'
$script:RunnerSha256 = 'a1f17aa987fc8158bc7521d284912267a0d01b7c2c4684b33c86783b5e8221cc'
$script:PwshVersion = '7.6.9'
$script:PwshSha256 = 'ce7484804c0f0ad4dda10c958e71acdaf7eebfb22505c1b480f89e0e9f1da94d'

$script:InstallRoot = Join-Path $env:LOCALAPPDATA 'CashInGithubRunner'
$script:RunnerDir = Join-Path $script:InstallRoot 'runner'
$script:PwshDir = Join-Path $script:InstallRoot 'pwsh'
$script:ScriptsDir = Join-Path $script:InstallRoot 'scripts'
$script:LogDir = Join-Path $script:InstallRoot 'logs'
$script:CodexBinRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
$script:StartupShortcutName = 'CashIn GitHub Runner.lnk'
# Scripts copied to ScriptsDir by the installer. The SessionStart hook and the Startup shortcut run
# only these installed copies, never the copies in a working tree.
$script:InstalledScriptNames = @('runner-common.ps1', 'start-runner.ps1', 'ensure-runner.ps1')
# Written after an archive is fully extracted; records which pinned archive the folder holds.
$script:InstallMarkerName = '.cashin-archive-sha256'
$script:RunnerLogMaxBytes = 5MB

function Test-RunnerInstalled {
  return (Test-Path (Join-Path $script:RunnerDir '.runner')) -and (Test-Path (Join-Path $script:RunnerDir 'run.cmd'))
}

function Get-ListenerProcess {
  return @(Get-Process -Name 'Runner.Listener' -ErrorAction SilentlyContinue)
}

function Get-ProcessPath([object]$Process) {
  try { return [string]$Process.Path } catch { return $null }
}

# Splits Runner.Listener processes into this installation and any other one. A listener whose path
# cannot be read is treated as foreign, so an unknown listener never leads to a second one starting.
function Split-ListenerProcess {
  param([object[]]$Processes, [string]$ListenerPath)
  $own = @()
  $foreign = @()
  foreach ($process in @($Processes)) {
    $path = Get-ProcessPath $process
    if ($path -and [string]::Equals($path, $ListenerPath, [StringComparison]::OrdinalIgnoreCase)) { $own += $process }
    else { $foreign += $process }
  }
  return [pscustomobject]@{ Own = $own; Foreign = $foreign }
}

function Get-RunnerListenerState {
  return Split-ListenerProcess -Processes (Get-ListenerProcess) -ListenerPath (Join-Path $script:RunnerDir 'bin\Runner.Listener.exe')
}

function Get-RunnerProcess {
  return @((Get-RunnerListenerState).Own)
}

function Get-ExecutableVersion([string]$Path) {
  try {
    $raw = [Diagnostics.FileVersionInfo]::GetVersionInfo($Path).ProductVersion
    if ($raw -and $raw -match '^\s*(\d+(\.\d+){1,3})') { return [version]$Matches[1] }
  } catch {}
  return $null
}

# The Codex desktop app stores its CLI under a hash-named folder that changes on every update, so the
# executable is resolved on each start: highest file version first, newest write time as tie-breaker.
function Get-LatestCodexExecutable {
  if (-not (Test-Path $script:CodexBinRoot)) { return $null }
  $candidates = @(Get-ChildItem -Path $script:CodexBinRoot -Filter 'codex.exe' -Recurse -Depth 1 -ErrorAction SilentlyContinue)
  if ($candidates.Count -eq 0) { return $null }
  $zero = [version]'0.0'
  $best = $candidates |
    Sort-Object -Property @(
      @{ Expression = { $version = Get-ExecutableVersion $_.FullName; if ($version) { $version } else { $zero } }; Descending = $true },
      @{ Expression = { $_.LastWriteTime }; Descending = $true }
    ) |
    Select-Object -First 1
  return $best.FullName
}

# Job steps inherit the environment of the process that starts the runner. The Windows runner
# does not apply a ".path" file to job steps, so PATH and CODEX_EXECUTABLE are set on this process.
function Set-RunnerEnvironment {
  # Claude Code is the default agent runtime; the Codex CLI is optional and only used when
  # AGENT_RUNTIME=codex, so its absence must not prevent the runner from starting.
  $codex = Get-LatestCodexExecutable
  $pwshPath = Join-Path $script:PwshDir 'pwsh.exe'
  if (-not (Test-Path $pwshPath)) {
    throw "PowerShell 7 portátil não encontrado em $script:PwshDir. Rode install-runner.ps1 novamente."
  }

  $pathEntries = @($script:PwshDir)
  foreach ($scope in 'User', 'Machine') {
    $value = [Environment]::GetEnvironmentVariable('Path', $scope)
    if ($value) { $pathEntries += $value.Split(';') | Where-Object { $_ } }
  }
  $env:Path = ($pathEntries | Select-Object -Unique) -join ';'
  if ($codex) { $env:CODEX_EXECUTABLE = $codex }
  return $codex
}

# Keeps one previous log. Only called while no listener of this installation is running.
function Invoke-RunnerLogRotation {
  param([string]$LogPath, [long]$MaxBytes = $script:RunnerLogMaxBytes)
  if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt $MaxBytes) {
    try {
      Move-Item -Path $LogPath -Destination "$LogPath.1" -Force -ErrorAction Stop
      return $true
    } catch {
      # A cmd.exe left by an earlier run.cmd can still hold the log open (DEV-80). Rotation is
      # housekeeping: failing it must never stop the runner from starting.
      Write-Warning "Não foi possível rotacionar $LogPath ($($_.Exception.Message)); o runner segue sem rotacionar o log."
      return $false
    }
  }
  return $false
}

# Normalizes the registration token gh returns: exactly one non-empty line, in the shape GitHub issues.
# A multi-line answer would otherwise become an array that passes a truthiness check and is exported with
# its lines joined (DEV-80). Returns $null for anything else, so the caller fails with a clear message.
function ConvertTo-RunnerRegistrationToken {
  param([object[]]$Output)
  $lines = @($Output | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
  if ($lines.Count -ne 1) { return $null }
  if ($lines[0] -notmatch '^[A-Za-z0-9_-]{20,256}$') { return $null }
  return $lines[0]
}

# Entries a re-extraction must keep in the runner folder: the registration, its credentials, the job
# workspace and the diagnostics. Everything else came from the previous archive.
$script:PreservedRunnerEntries = @('.runner', '.credentials', '.credentials_rsaparams', '.env', '.path', '_work', '_diag')

# Removes what a previous extraction left, so binaries dropped from the new archive do not survive the
# update next to the new ones (DEV-80). Only called while no listener of this installation is running.
function Clear-ExtractionTarget {
  param([string]$Destination, [string[]]$Preserve = $script:PreservedRunnerEntries)
  if (-not (Test-Path -LiteralPath $Destination)) { return }
  Get-ChildItem -LiteralPath $Destination -Force |
    Where-Object { $Preserve -notcontains $_.Name } |
    Remove-Item -Recurse -Force
}

function Start-RunnerProcess {
  param([int]$WaitSeconds = 0)

  if (-not (Test-RunnerInstalled)) {
    throw "Runner não instalado em $script:RunnerDir. Rode tools/github-runner/install-runner.ps1."
  }
  $state = Get-RunnerListenerState
  if (@($state.Own).Count -gt 0) { return 'already-running' }
  if (@($state.Foreign).Count -gt 0) { return 'foreign-listener' }

  [void](Set-RunnerEnvironment)
  New-Item -ItemType Directory -Force -Path $script:LogDir | Out-Null
  $log = Join-Path $script:LogDir 'runner.log'
  [void](Invoke-RunnerLogRotation -LogPath $log)
  $runCmd = Join-Path $script:RunnerDir 'run.cmd'
  Start-Process -FilePath $env:ComSpec `
    -ArgumentList '/d', '/c', "`"`"$runCmd`" >> `"$log`" 2>&1`"" `
    -WorkingDirectory $script:RunnerDir `
    -WindowStyle Hidden | Out-Null

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  while ($WaitSeconds -gt 0 -and (Get-Date) -lt $deadline) {
    if (@(Get-RunnerProcess).Count -gt 0) { return 'started' }
    Start-Sleep -Milliseconds 500
  }
  return $(if (@(Get-RunnerProcess).Count -gt 0) { 'started' } else { 'starting' })
}

# True when the folder holds a complete extraction of exactly this pinned archive.
function Test-ArchiveInstalled {
  param([string]$Destination, [string]$Marker, [string]$ExpectedSha256)
  $markerPath = Join-Path $Destination $script:InstallMarkerName
  if (-not (Test-Path (Join-Path $Destination $Marker)) -or -not (Test-Path $markerPath)) { return $false }
  $recorded = (Get-Content -Path $markerPath -Raw -ErrorAction SilentlyContinue)
  return ($null -ne $recorded) -and [string]::Equals($recorded.Trim(), $ExpectedSha256, [StringComparison]::OrdinalIgnoreCase)
}

function Write-ArchiveMarker {
  param([string]$Destination, [string]$ExpectedSha256)
  Set-Content -Path (Join-Path $Destination $script:InstallMarkerName) -Value $ExpectedSha256.ToLowerInvariant() -Encoding ASCII
}
