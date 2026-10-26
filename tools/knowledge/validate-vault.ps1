[CmdletBinding()]
param(
  [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
)

$ErrorActionPreference = "Stop"
$vaultRoot = Join-Path $RepositoryRoot "docs/knowledge"
$repositoryRootPrefix = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$vaultRootPrefix = [IO.Path]::GetFullPath($vaultRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
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

    if (-not $resolvedTarget.StartsWith($repositoryRootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $resolvedTarget -PathType Leaf)) {
      $relativeFile = [IO.Path]::GetRelativePath($RepositoryRoot, $file.FullName)
      $failures.Add("${relativeFile}: link local deve apontar para um arquivo existente '$target'.")
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

$contextMapPath = Join-Path $vaultRoot "context-map.json"
if (Test-Path -LiteralPath $contextMapPath -PathType Leaf) {
  try {
    $contextMap = Get-Content -LiteralPath $contextMapPath -Raw | ConvertFrom-Json -Depth 16
  }
  catch {
    $failures.Add("docs/knowledge/context-map.json: JSON inválido.")
    $contextMap = $null
  }

  if ($null -ne $contextMap) {
    if ($contextMap.version -ne 1 -or $contextMap.routes -isnot [array]) {
      $failures.Add("docs/knowledge/context-map.json: esperado version 1 e um array routes.")
    }
    else {
      foreach ($route in @($contextMap.routes)) {
        $paths = @($route.paths)
        $documents = @($route.documents)
        if ($route.paths -isnot [array] -or $route.documents -isnot [array] -or $paths.Count -eq 0 -or $documents.Count -eq 0) {
          $failures.Add("docs/knowledge/context-map.json: toda rota deve declarar paths e documents.")
          continue
        }

        foreach ($pattern in $paths) {
          if ($pattern -isnot [string] -or [string]::IsNullOrWhiteSpace($pattern) -or $pattern.StartsWith('/') -or $pattern.Contains('..') -or $pattern.Contains('\')) {
            $failures.Add("docs/knowledge/context-map.json: padrão de caminho inválido '$pattern'.")
          }
        }

        foreach ($document in $documents) {
          if ($document -isnot [string] -or -not $document.StartsWith('docs/knowledge/') -or -not $document.EndsWith('.md')) {
            $failures.Add("docs/knowledge/context-map.json: documento fora do vault ou não Markdown '$document'.")
            continue
          }
          $resolvedDocument = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot $document))
          if (-not $resolvedDocument.StartsWith($vaultRootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $resolvedDocument -PathType Leaf)) {
            $failures.Add("docs/knowledge/context-map.json: documento inexistente ou inseguro '$document'.")
          }
        }
      }

      if ($null -ne $contextMap.catalogs) {
        if ($contextMap.catalogs -isnot [array]) {
          $failures.Add("docs/knowledge/context-map.json: catalogs deve ser um array.")
        }
        else {
          foreach ($catalog in @($contextMap.catalogs)) {
            if ($catalog -isnot [string] -or -not $catalog.StartsWith('docs/knowledge/') -or -not $catalog.EndsWith('.md')) {
              $failures.Add("docs/knowledge/context-map.json: catálogo fora do vault ou não Markdown '$catalog'.")
              continue
            }
            $resolvedCatalog = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot $catalog))
            if (-not $resolvedCatalog.StartsWith($vaultRootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $resolvedCatalog -PathType Leaf)) {
              $failures.Add("docs/knowledge/context-map.json: catálogo inexistente ou inseguro '$catalog'.")
            }
          }
        }
      }
    }
  }
}

if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Error $_ }
  exit 1
}

Write-Output "Vault validado: $($markdownFiles.Count) arquivos Markdown, $checkedLinks links locais, mapa de contexto válido e nenhum padrão de credencial detectado."
