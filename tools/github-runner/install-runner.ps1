# Installs (or repairs) the local self-hosted runner used by the Codex Code Review and QA jobs.
# Idempotent: downloads are verified by SHA-256, an existing registration is kept unless -Reregister
# is passed, and the Startup shortcut and helper scripts are refreshed on every run.
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
  if (Test-Path (Join-Path $Destination $Marker)) {
    Write-Output "Já instalado: $Destination"
    return
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
}

function Register-Runner {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'GitHub CLI (gh) não encontrado.' }
  $token = (& gh api -X POST "repos/$RunnerRepository/actions/runners/registration-token" --jq '.token' 2>$null)
  if ($LASTEXITCODE -ne 0 -or -not $token) {
    throw "Não foi possível obter o token de registro. Confira 'gh auth status' e se a conta é admin de $RunnerRepository."
  }
  Push-Location $RunnerDir
  try {
    # --replace takes over an offline registration with the same name instead of creating a duplicate.
    & .\config.cmd --unattended --replace --url "https://github.com/$RunnerRepository" --token $token `
      --name $RunnerName --labels $RunnerCustomLabels --work '_work' | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "config.cmd falhou com código $LASTEXITCODE." }
  } finally {
    Pop-Location
    $token = $null
  }
}

function Install-HelperScripts {
  New-Item -ItemType Directory -Force -Path $ScriptsDir | Out-Null
  foreach ($file in 'runner-common.ps1', 'start-runner.ps1') {
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

if (-not (Get-LatestCodexExecutable)) {
  Write-Warning "Codex CLI não encontrado em $CodexBinRoot. Instale o app Codex e faça login; o runner não executará os jobs sem ele."
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
  Write-Output "Runner: $result. Log: $LogDir\runner.log"
}
