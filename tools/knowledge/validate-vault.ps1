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

function Test-MarkdownEscaped {
  param([string]$Value, [int]$Index)

  $backslashes = 0
  for ($cursor = $Index - 1; $cursor -ge 0 -and $Value[$cursor] -eq '\'; $cursor--) {
    $backslashes++
  }
  return $backslashes % 2 -eq 1
}

function Find-MarkdownClosingDelimiter {
  param([string]$Value, [int]$Start, [char]$Opening, [char]$Closing)

  $depth = 0
  for ($cursor = $Start; $cursor -lt $Value.Length; $cursor++) {
    if ($Value[$cursor] -eq '\') {
      $cursor++
      continue
    }
    if ($Value[$cursor] -eq $Opening) {
      $depth++
    }
    if ($Value[$cursor] -eq $Closing) {
      $depth--
      if ($depth -eq 0) {
        return $cursor
      }
    }
  }
  return -1
}

function Skip-MarkdownWhitespace {
  param([string]$Value, [int]$Start)

  $cursor = $Start
  while ($cursor -lt $Value.Length -and ($Value[$cursor] -eq ' ' -or $Value[$cursor] -eq "`t")) {
    $cursor++
  }
  return $cursor
}

function Read-MarkdownInlineDestination {
  param([string]$Line, [int]$Start)

  $cursor = Skip-MarkdownWhitespace $Line $Start
  if ($cursor -ge $Line.Length) {
    return $null
  }

  if ($Line[$cursor] -eq '<') {
    $destinationStart = ++$cursor
    while ($cursor -lt $Line.Length -and $Line[$cursor] -ne '>') {
      if ($Line[$cursor] -eq '\') {
        $cursor++
      }
      $cursor++
    }
    if ($cursor -ge $Line.Length -or $Line[$cursor] -ne '>') {
      return $null
    }
    $target = $Line.Substring($destinationStart, $cursor - $destinationStart)
    $cursor++
  }
  else {
    $destinationStart = $cursor
    $nestedParentheses = 0
    while ($cursor -lt $Line.Length) {
      $character = $Line[$cursor]
      if ($character -eq '\') {
        $cursor += 2
        continue
      }
      if ($character -eq '(') {
        $nestedParentheses++
      }
      elseif ($character -eq ')') {
        if ($nestedParentheses -eq 0) {
          break
        }
        $nestedParentheses--
      }
      if (($character -eq ' ' -or $character -eq "`t") -and $nestedParentheses -eq 0) {
        break
      }
      $cursor++
    }
    if ($nestedParentheses -ne 0) {
      return $null
    }
    $target = $Line.Substring($destinationStart, $cursor - $destinationStart)
  }

  $afterDestination = $cursor
  $cursor = Skip-MarkdownWhitespace $Line $cursor
  if ($cursor -lt $Line.Length -and $Line[$cursor] -eq ')') {
    return @{ Target = $target; End = $cursor }
  }
  if ($cursor -eq $afterDestination -or $cursor -ge $Line.Length) {
    return $null
  }

  $titleStart = $Line[$cursor]
  if ($titleStart -eq '(') {
    $titleEnd = ')'
  }
  elseif ($titleStart -eq '"' -or $titleStart -eq "'") {
    $titleEnd = $titleStart
  }
  else {
    return $null
  }

  $cursor++
  while ($cursor -lt $Line.Length -and $Line[$cursor] -ne $titleEnd) {
    if ($Line[$cursor] -eq '\') {
      $cursor++
    }
    $cursor++
  }
  if ($cursor -ge $Line.Length -or $Line[$cursor] -ne $titleEnd) {
    return $null
  }
  $cursor = Skip-MarkdownWhitespace $Line ($cursor + 1)
  if ($cursor -ge $Line.Length -or $Line[$cursor] -ne ')') {
    return $null
  }
  return @{ Target = $target; End = $cursor }
}

function Remove-MarkdownCode {
  param([string]$Content)

  $fenceMarker = $null
  $fenceLength = 0
  $result = [System.Collections.Generic.List[string]]::new()
  foreach ($line in ($Content -split "`r?`n")) {
    $fenceMatch = [regex]::Match($line, '^[ \t]{0,3}(`{3,}|~{3,})')
    if ($null -ne $fenceMarker) {
      if ($fenceMatch.Success -and $fenceMatch.Groups[1].Value[0] -eq $fenceMarker -and $fenceMatch.Groups[1].Value.Length -ge $fenceLength -and
          $line.Substring($fenceMatch.Length) -match '^[ \t]*$') {
        $fenceMarker = $null
        $fenceLength = 0
      }
      $result.Add('')
      continue
    }
    if ($fenceMatch.Success) {
      $fenceMarker = $fenceMatch.Groups[1].Value[0]
      $fenceLength = $fenceMatch.Groups[1].Value.Length
      $result.Add('')
      continue
    }
    $result.Add([regex]::Replace($line, '(`+)([^`\r\n]*?)\1', 'CODE'))
  }
  return $result -join "`n"
}

function Normalize-MarkdownReferenceLabel {
  param([string]$Label)
  return ([regex]::Replace($Label.Trim(), '\s+', ' ')).ToLowerInvariant()
}

function Get-MarkdownLinks {
  param([string]$Content)

  $markdown = Remove-MarkdownCode $Content
  $targets = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $definitions = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
  $definitionPattern = '(?m)^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]+)>|(\S+))(?:[ \t]+(?:"[^"\r\n]*"|''[^''\r\n]*''|\([^)]*\)))?[ \t]*$'

  foreach ($match in [regex]::Matches($markdown, $definitionPattern)) {
    $label = Normalize-MarkdownReferenceLabel $match.Groups[1].Value
    $target = if ($match.Groups[2].Success) { $match.Groups[2].Value.Trim() } else { $match.Groups[3].Value.Trim() }
    if ([string]::IsNullOrWhiteSpace($label) -or [string]::IsNullOrWhiteSpace($target)) {
      continue
    }
    if ($definitions.ContainsKey($label) -and $definitions[$label] -ne $target) {
      throw "Definições de link Markdown conflitantes: $($match.Groups[1].Value)."
    }
    $definitions[$label] = $target
  }

  foreach ($line in ($markdown -split "`n")) {
    $cursor = 0
    while ($cursor -lt $line.Length) {
      $labelStart = $line.IndexOf('[', $cursor)
      if ($labelStart -lt 0) {
        break
      }
      if (Test-MarkdownEscaped $line $labelStart) {
        $cursor = $labelStart + 1
        continue
      }
      $labelEnd = Find-MarkdownClosingDelimiter $line $labelStart '[' ']'
      if ($labelStart -gt 0 -and $line[$labelStart - 1] -eq '!' -and -not (Test-MarkdownEscaped $line ($labelStart - 1))) {
        $cursor = if ($labelEnd -lt 0) { $labelStart + 1 } else { $labelEnd + 1 }
        continue
      }
      if ($labelEnd -lt 0 -or $labelEnd + 1 -ge $line.Length -or $line[$labelEnd + 1] -ne '(') {
        $cursor = $labelStart + 1
        continue
      }
      $parsed = Read-MarkdownInlineDestination $line ($labelEnd + 2)
      if ($null -eq $parsed) {
        throw 'Link Markdown inline não suportado ou malformado.'
      }
      if (-not [string]::IsNullOrWhiteSpace($parsed.Target)) {
        $unescaped = [regex]::Replace($parsed.Target, '\\([!"#$%&''()*+,\-./:;<=>?@\[\\\]^_`{|}~])', '$1')
        [void]$targets.Add($unescaped)
      }
      $cursor = $parsed.End + 1
    }
  }

  foreach ($match in [regex]::Matches($markdown, '(?<!!)\[([^\]\r\n]+)\]\[([^\]\r\n]*)\]')) {
    $rawLabel = if ([string]::IsNullOrWhiteSpace($match.Groups[2].Value)) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    $label = Normalize-MarkdownReferenceLabel $rawLabel
    if (-not $definitions.ContainsKey($label)) {
      throw "Referência de link Markdown não definida: $label."
    }
    [void]$targets.Add($definitions[$label])
  }

  foreach ($match in [regex]::Matches($markdown, '(?<![!\]])\[([^\]\r\n]+)\](?![\[(:])')) {
    $label = Normalize-MarkdownReferenceLabel $match.Groups[1].Value
    if ($definitions.ContainsKey($label)) {
      [void]$targets.Add($definitions[$label])
    }
  }

  return @($targets)
}

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

  try {
    $markdownLinks = Get-MarkdownLinks $content
  }
  catch {
    $relativeFile = [IO.Path]::GetRelativePath($RepositoryRoot, $file.FullName)
    $failures.Add("${relativeFile}: $($_.Exception.Message)")
    $markdownLinks = @()
  }

  foreach ($markdownLink in $markdownLinks) {
    $target = $markdownLink.Trim()

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
