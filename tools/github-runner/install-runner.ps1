# Installs (or repairs) the local self-hosted runner used by the agent Code Review and QA jobs.
# Idempotent: downloads are verified by SHA-256, a folder is re-extracted when it does not hold a
# complete extraction of the pinned archive, an existing registration is kept unless -Reregister is
# passed, and the Startup shortcut and installed helper scripts are refreshed on every run.
# Run it only from an up-to-date checkout of master: the installed scripts are the ones the
# SessionStart hook and the Startup shortcut execute.
# Requires an authenticated GitHub CLI (gh) with admin access to the repository. No administrator
# rights are needed: everything lives under %LOCALAPPDATA%\CashInGithubRunner.
param(
  [switch]$Reregister,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runner-common.ps1')
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Install-VerifiedArchive {
  param(
    [string]$Url,
    [string]$ExpectedSha256,
    [string]$Destination,
    [string]$Marker
  )
  if (Test-ArchiveInstalled -Destination $Destination -Marker $Marker -ExpectedSha256 $ExpectedSha256) {
    Write-Output "Já instalado: $Destination"
    return
  }
  # Re-extracting over a running listener would replace files in use.
  if (@(Get-RunnerProcess).Count -gt 0) {
    throw "$Destination precisa ser reinstalado, mas o runner está em execução. Encerre o processo Runner.Listener e rode o instalador novamente."
  }
  $downloads = Join-Path $InstallRoot 'downloads'
  New-Item -ItemType Directory -Force -Path $downloads | Out-Null
  $archive = Join-Path $downloads ([IO.Path]::GetFileName($Url))
  if (-not (Test-Path $archive) -or (Get-FileHash $archive -Algorithm SHA256).Hash -ne $ExpectedSha256.ToUpperInvariant()) {
    Write-Output "Baixando $Url"
    $previousProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest -Uri $Url -OutFile $archive -UseBasicParsing } finally { $ProgressPreference = $previousProgress }
  }
  $actual = (Get-FileHash $archive -Algorithm SHA256).Hash
  if ($actual -ne $ExpectedSha256.ToUpperInvariant()) {
    Remove-Item $archive -Force
    throw "SHA-256 inválido para $Url (esperado $ExpectedSha256, obtido $actual). Download descartado."
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Expand-Archive -Path $archive -DestinationPath $Destination -Force
  Remove-Item $archive -Force
  # Written last, so an interrupted extraction is repaired on the next run.
  Write-ArchiveMarker -Destination $Destination -ExpectedSha256 $ExpectedSha256
}

function Register-Runner {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'GitHub CLI (gh) não encontrado.' }
  $token = (& gh api -X POST "repos/$RunnerRepository/actions/runners/registration-token" --jq '.token' 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $token) {
    throw "Não foi possível obter o token de registro. Confira 'gh auth status' e se a conta é admin de $RunnerRepository."
  }
  Push-Location $RunnerDir
  try {
    # The runner reads any input from ACTIONS_RUNNER_INPUT_<NAME>, so the token never appears on the
    # config.cmd command line (visible in the process list); it lives only in this process environment.
    $env:ACTIONS_RUNNER_INPUT_TOKEN = $token
    # --replace takes over an offline registration with the same name instead of creating a duplicate.
    & .\config.cmd --unattended --replace --url "https://github.com/$RunnerRepository" `
      --name $RunnerName --labels $RunnerCustomLabels --work '_work' | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "config.cmd falhou com código $LASTEXITCODE." }
  } finally {
    Remove-Item Env:\ACTIONS_RUNNER_INPUT_TOKEN -ErrorAction SilentlyContinue
    Pop-Location
    $token = $null
  }
}

function Install-HelperScripts {
  New-Item -ItemType Directory -Force -Path $ScriptsDir | Out-Null
  foreach ($file in $InstalledScriptNames) {
    Copy-Item -Path (Join-Path $PSScriptRoot $file) -Destination (Join-Path $ScriptsDir $file) -Force
  }
}

function Install-StartupShortcut {
  $startup = [Environment]::GetFolderPath('Startup')
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut((Join-Path $startup $StartupShortcutName))
  $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $shortcut.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $ScriptsDir 'start-runner.ps1')`""
  $shortcut.WorkingDirectory = $ScriptsDir
  $shortcut.WindowStyle = 7
  $shortcut.Save()
}

if (@(Get-RunnerProcess).Count -gt 0 -and $Reregister) {
  throw 'O runner está em execução. Encerre o processo Runner.Listener antes de usar -Reregister.'
}

# The agents run with Claude Code by default; Codex is only an optional fallback (AGENT_RUNTIME=codex).
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Write-Warning 'Claude Code CLI não encontrado no PATH. Instale e faça login no Claude Code; sem ele os agentes de Code Review e QA falharão.'
}
if (-not (Get-LatestCodexExecutable)) {
  Write-Output "Codex CLI não encontrado em $CodexBinRoot; ele só é necessário com AGENT_RUNTIME=codex."
}

Install-VerifiedArchive `
  -Url "https://github.com/actions/runner/releases/download/v$RunnerVersion/actions-runner-win-x64-$RunnerVersion.zip" `
  -ExpectedSha256 $RunnerSha256 -Destination $RunnerDir -Marker 'config.cmd'
Install-VerifiedArchive `
  -Url "https://github.com/PowerShell/PowerShell/releases/download/v$PwshVersion/PowerShell-$PwshVersion-win-x64.zip" `
  -ExpectedSha256 $PwshSha256 -Destination $PwshDir -Marker 'pwsh.exe'

if ($Reregister -or -not (Test-RunnerInstalled)) {
  Register-Runner
} else {
  Write-Output "Registro existente mantido para $RunnerName."
}

Install-HelperScripts
Install-StartupShortcut
Write-Output "Atalho de inicialização atualizado: $StartupShortcutName"

if (-not $NoStart) {
  $result = Start-RunnerProcess -WaitSeconds 20
  if ($result -eq 'foreign-listener') {
    Write-Warning 'Há um processo Runner.Listener de outra instalação em execução; o runner não foi iniciado para evitar um segundo listener. Encerre-o e rode start-runner.ps1.'
  } else {
    Write-Output "Runner: $result. Log: $LogDir\runner.log"
  }
}
