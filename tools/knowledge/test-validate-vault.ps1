[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$validator = Join-Path $PSScriptRoot 'validate-vault.ps1'
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "cashin-vault-validator-$([Guid]::NewGuid())"

function Invoke-ValidatorCase {
  param([string]$RepositoryRoot)

  $outputFile = Join-Path $RepositoryRoot 'validator-output.txt'
  $process = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @(
    '-NoProfile',
    '-File', $validator,
    '-RepositoryRoot', $RepositoryRoot
  ) -Wait -PassThru -NoNewWindow -RedirectStandardOutput $outputFile -RedirectStandardError "$outputFile.error"
  $output = ((Get-Content -LiteralPath $outputFile -Raw -ErrorAction SilentlyContinue) + (Get-Content -LiteralPath "$outputFile.error" -Raw -ErrorAction SilentlyContinue)).Trim()
  return @{ ExitCode = $process.ExitCode; Output = $output }
}

function New-VaultCase {
  param([string]$Name, [string]$IndexContent, [hashtable]$Files = @{})

  $root = Join-Path $temporaryRoot $Name
  $vault = Join-Path $root 'docs/knowledge'
  New-Item -ItemType Directory -Path $vault -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $vault 'README.md') -Value $IndexContent -NoNewline
  Set-Content -LiteralPath (Join-Path $vault 'context-map.json') -Value '{"version":1,"routes":[]}' -NoNewline
  foreach ($entry in $Files.GetEnumerator()) {
    $path = Join-Path $vault $entry.Key
    New-Item -ItemType Directory -Path (Split-Path $path) -Force | Out-Null
    Set-Content -LiteralPath $path -Value $entry.Value -NoNewline
  }
  return $root
}

try {
  $validRoot = New-VaultCase 'valid' @'
# Índice

- [Com espaços](<fonte local.md> "Título")
- [Parênteses](folder/fonte(a).md)
- [Referência completa][fonte]
- [Referência colapsada][]
- [atalho]

[fonte]: referencia.md "Fonte"
[Referência colapsada]: colapsada.md
[atalho]: atalho.md
'@ @{
    'fonte local.md' = '# Fonte com espaços'
    'folder/fonte(a).md' = '# Fonte com parênteses'
    'referencia.md' = '# Fonte por referência'
    'colapsada.md' = '# Fonte por referência colapsada'
    'atalho.md' = '# Fonte por atalho'
  }
  $valid = Invoke-ValidatorCase $validRoot
  if ($valid.ExitCode -ne 0 -or $valid.Output -notmatch '5 links locais') {
    throw "Caso válido falhou: $($valid.Output)"
  }

  $missingTargetRoot = New-VaultCase 'missing-target' @'
# Índice

[Fonte ausente][fonte]

[fonte]: nao-existe.md
'@
  $missingTarget = Invoke-ValidatorCase $missingTargetRoot
  if ($missingTarget.ExitCode -eq 0 -or $missingTarget.Output -notmatch 'nao-existe.md') {
    throw "Destino ausente não foi rejeitado: $($missingTarget.Output)"
  }

  $undefinedReferenceRoot = New-VaultCase 'undefined-reference' @'
# Índice

[Fonte ausente][fonte]
'@
  $undefinedReference = Invoke-ValidatorCase $undefinedReferenceRoot
  if ($undefinedReference.ExitCode -eq 0 -or $undefinedReference.Output -notmatch 'não definida') {
    throw "Referência indefinida não foi rejeitada: $($undefinedReference.Output)"
  }

  Write-Output 'Regressões do validador do vault aprovadas: links inline complexos, referências e falhas fechadas.'
}
finally {
  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
