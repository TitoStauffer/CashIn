[CmdletBinding()]
param(
  [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
)

$ErrorActionPreference = "Stop"
$vaultRoot = Join-Path $RepositoryRoot "docs/knowledge"
$failures = [System.Collections.Generic.List[string]]::new()
$checkedLinks = 0

if (-not (Test-Path -LiteralPath $vaultRoot -PathType Container)) {
  throw "Vault não encontrado em $vaultRoot."
}

$markdownFiles = Get-ChildItem -LiteralPath $vaultRoot -Recurse -File -Filter "*.md" | Sort-Object FullName

foreach ($file in $markdownFiles) {
  $content = Get-Content -LiteralPath $file.FullName -Raw
  $headings = [regex]::Matches($content, "(?m)^#\s+.+$")

  if ($headings.Count -ne 1) {
    $failures.Add("$($file.FullName): esperado exatamente um título H1; encontrado $($headings.Count).")
  }

  foreach ($match in [regex]::Matches($content, "\[[^\]]+\]\(([^)]+)\)")) {
    $target = $match.Groups[1].Value.Trim()

    if ($target -match "^(?:https?://|mailto:|#)") {
      continue
    }

    $localTarget = ($target -split "#", 2)[0]
    if ([string]::IsNullOrWhiteSpace($localTarget)) {
      continue
    }

    $decodedTarget = [Uri]::UnescapeDataString($localTarget)
    $resolvedTarget = [IO.Path]::GetFullPath((Join-Path $file.DirectoryName $decodedTarget))
    $checkedLinks++

    if (-not (Test-Path -LiteralPath $resolvedTarget)) {
      $relativeFile = [IO.Path]::GetRelativePath($RepositoryRoot, $file.FullName)
      $failures.Add("${relativeFile}: link local inexistente '$target'.")
    }
  }

  $secretPatterns = @(
    "-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    "github_pat_[A-Za-z0-9_]{20,}",
    "gh[opsu]_[A-Za-z0-9]{20,}"
  )

  foreach ($pattern in $secretPatterns) {
    if ($content -match $pattern) {
      $relativeFile = [IO.Path]::GetRelativePath($RepositoryRoot, $file.FullName)
      $failures.Add("${relativeFile}: padrão de credencial detectado.")
    }
  }
}

if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Error $_ }
  exit 1
}

Write-Output "Vault validado: $($markdownFiles.Count) arquivos Markdown, $checkedLinks links locais e nenhum padrão de credencial detectado."
