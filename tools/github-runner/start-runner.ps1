# Starts the local runner if it is installed and not running. Used by the Windows Startup shortcut.
param([int]$WaitSeconds = 15)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'runner-common.ps1')

$result = Start-RunnerProcess -WaitSeconds $WaitSeconds
switch ($result) {
  'already-running' { Write-Output "Runner $RunnerName já está em execução." }
  'started' { Write-Output "Runner $RunnerName iniciado." }
  default { Write-Output "Runner $RunnerName em inicialização; consulte $LogDir\runner.log se não ficar online." }
}
