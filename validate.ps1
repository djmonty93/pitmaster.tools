$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot
$distRoot = Join-Path $repoRoot 'dist'

$errors = New-Object System.Collections.Generic.List[string]

function Add-Error {
  param([string]$Message)
  $errors.Add($Message)
}

function Test-XmlFile {
  param([string]$Path)
  try {
    [xml](Get-Content $Path -Raw) | Out-Null
    Write-Host "OK XML  $Path"
  } catch {
    Add-Error("Invalid XML: $Path`n$($_.Exception.Message)")
  }
}

function ConvertFrom-Jsonc {
  param([string]$Text)
  # JSONC normalizer: strip /* … */ block comments and // line comments, then
  # remove trailing commas before } or ]. String literals (which may contain
  # // or /*) are preserved by handling them as the first alternative in the
  # regex; the replacement keeps the original match when the captured group is
  # a string. This is enough for wrangler.jsonc-style configs and is much
  # smaller than a full JSONC tokenizer.
  $stringOrComment = '"(?:\\.|[^"\\])*"|/\*[\s\S]*?\*/|//[^\r\n]*'
  $stripped = [regex]::Replace(
    $Text,
    $stringOrComment,
    { param($m) if ($m.Value.StartsWith('"')) { $m.Value } else { '' } }
  )
  # Trailing commas before } or ]
  $stripped = [regex]::Replace($stripped, ',(\s*[}\]])', '$1')
  return $stripped
}

function Test-JsonFile {
  param([string]$Path)
  try {
    $raw = Get-Content $Path -Raw
    # .jsonc files may contain comments and trailing commas; normalize first.
    if ($Path -like '*.jsonc') {
      $raw = ConvertFrom-Jsonc -Text $raw
    }
    $raw | ConvertFrom-Json | Out-Null
    Write-Host "OK JSON $Path"
  } catch {
    Add-Error("Invalid JSON: $Path`n$($_.Exception.Message)")
  }
}

function Test-LocalLinks {
  param(
    [string]$BaseDirectory,
    [string[]]$Paths
  )

  $pattern = '<[^>' + "`r`n" + ']+\b(?:href|src)="([^"]+)"'
  foreach ($path in $Paths) {
    $fullPath = Join-Path $BaseDirectory $path
    $content = Get-Content $fullPath -Raw
    $matches = [regex]::Matches($content, $pattern)
    foreach ($match in $matches) {
      $target = $match.Groups[1].Value
      if (
        $target.StartsWith('http://') -or
        $target.StartsWith('https://') -or
        $target.StartsWith('mailto:') -or
        $target.StartsWith('data:') -or
        $target.StartsWith('#')
      ) {
        continue
      }

      $cleanTarget = $target.Split('#')[0].Split('?')[0]
      if ([string]::IsNullOrWhiteSpace($cleanTarget)) {
        continue
      }

      # Root URL '/' resolves to index.html
      if ($cleanTarget -eq '/') {
        $resolved = Join-Path $BaseDirectory 'index.html'
      } elseif ($cleanTarget.StartsWith('/')) {
        $resolved = Join-Path $BaseDirectory $cleanTarget.TrimStart('/')
      } else {
        $resolved = Join-Path (Split-Path -Parent $fullPath) $cleanTarget
      }

      # Clean URLs (no extension) resolve to <target>.html
      if (-not (Test-Path $resolved) -and -not [System.IO.Path]::HasExtension($resolved)) {
        $resolvedHtml = "$resolved.html"
        if (Test-Path $resolvedHtml) {
          $resolved = $resolvedHtml
        }
      }

      if (-not (Test-Path $resolved)) {
        Add-Error("Missing local link target in ${path}: $target")
      }
    }
    Write-Host "OK LINK $path"
  }
}

function Test-NoInjectPlaceholders {
  param(
    [string]$BaseDirectory,
    [string[]]$Paths
  )

  foreach ($path in $Paths) {
    $fullPath = Join-Path $BaseDirectory $path
    if (Select-String -Path $fullPath -Pattern '<!--\s*INJECT:' -Quiet) {
      Add-Error("Unresolved partial placeholder in ${path}")
    } else {
      Write-Host "OK INJ  $path"
    }
  }
}

function Test-UnresolvedTokens {
  param(
    [string]$BaseDirectory,
    [string[]]$Paths
  )

  foreach ($path in $Paths) {
    $fullPath = Join-Path $BaseDirectory $path
    # Renamed from $matches to avoid shadowing the automatic variable.
    $tokenMatches = Select-String -Path $fullPath -Pattern '\{\{[A-Z_]+\}\}'
    if ($tokenMatches) {
      foreach ($m in $tokenMatches) {
        Add-Error("Unresolved {{token}} in ${path}: $($m.Line.Trim())")
      }
    } else {
      Write-Host "OK TOK  $path"
    }
  }
}

function Test-ConsentBeforeAnalytics {
  # Asserts the Consent Mode v2 default-deny gtag call appears before any
  # googletagmanager.com or pagead2/adsbygoogle reference, per CLAUDE.md.
  param(
    [string]$BaseDirectory,
    [string[]]$Paths
  )

  foreach ($path in $Paths) {
    $fullPath = Join-Path $BaseDirectory $path
    $content = Get-Content $fullPath -Raw
    # Match either single- or double-quoted JS string literals so a future
    # double-quoted variant doesn't silently skip the ordering gate.
    $consentMatch = [regex]::Match($content, "gtag\(\s*['""]consent['""]\s*,\s*['""]default['""]")
    $consentIdx = if ($consentMatch.Success) { $consentMatch.Index } else { -1 }
    $analyticsIdx = @('googletagmanager.com', 'pagead2.googlesyndication') |
      ForEach-Object { $content.IndexOf($_) } |
      Where-Object { $_ -ge 0 } |
      Sort-Object |
      Select-Object -First 1
    if ($consentIdx -ge 0 -and $null -ne $analyticsIdx -and $analyticsIdx -lt $consentIdx) {
      Add-Error("Consent default must precede analytics loader in ${path}")
    } else {
      Write-Host "OK CON  $path"
    }
  }
}

function Test-HeadOrder {
  # Enforces the ordered head block required by CLAUDE.md. Three layers:
  #  1. Universal presence — every page must carry charset, viewport, title,
  #     description, canonical (no page is allowed to ship without them).
  #  2. Social presence — every non-minimal page must carry OG + Twitter tags.
  #     404.html is the only exempted minimal page today.
  #  3. Ordering — present tags must appear in the canonical sequence.
  param(
    [string]$BaseDirectory,
    [string[]]$Paths
  )

  $tagPatterns = @{
    'charset'             = '<meta\s+charset='
    'viewport'            = '<meta\s+name="viewport"'
    'title'               = '<title>'
    'description'         = '<meta\s+name="description"'
    'robots'              = '<meta\s+name="robots"'
    'canonical'           = '<link\s+rel="canonical"'
    'og:title'            = '<meta\s+property="og:title"'
    'og:description'      = '<meta\s+property="og:description"'
    'og:type'             = '<meta\s+property="og:type"'
    'og:url'              = '<meta\s+property="og:url"'
    'og:image'            = '<meta\s+property="og:image"'
    'twitter:card'        = '<meta\s+name="twitter:card"'
    'twitter:title'       = '<meta\s+name="twitter:title"'
    'twitter:description' = '<meta\s+name="twitter:description"'
    'twitter:image'       = '<meta\s+name="twitter:image"'
    'favicon'             = '<link\s+rel="icon"\s+href='
    'consent'             = "gtag\('consent', 'default'"
  }
  $universal = @('charset', 'viewport', 'title', 'description', 'canonical')
  $social    = @('og:title', 'og:description', 'og:type', 'og:url', 'og:image',
                 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image')
  $orderedTags = @(
    'charset', 'viewport', 'title', 'description', 'robots', 'canonical',
    'og:title', 'og:description', 'og:type', 'og:url', 'og:image',
    'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image',
    'favicon', 'consent'
  )
  # Minimal pages don't carry social metadata. Keep this list small and explicit.
  $minimalPages = @('404.html')

  foreach ($path in $Paths) {
    $fullPath = Join-Path $BaseDirectory $path
    $content = Get-Content $fullPath -Raw
    $headMatch = [regex]::Match($content, '(?s)<head>(.*?)</head>')
    if (-not $headMatch.Success) {
      Add-Error("No <head> block found in ${path}")
      continue
    }
    $head = $headMatch.Groups[1].Value
    $pageOk = $true

    # Presence: universal
    foreach ($name in $universal) {
      if ($head -notmatch $tagPatterns[$name]) {
        Add-Error("Missing required head tag '$name' in ${path}")
        $pageOk = $false
      }
    }
    # Presence: social (non-minimal only)
    $isMinimal = $minimalPages -contains $path
    if (-not $isMinimal) {
      foreach ($name in $social) {
        if ($head -notmatch $tagPatterns[$name]) {
          Add-Error("Missing required head tag '$name' in ${path}")
          $pageOk = $false
        }
      }
    }

    # Ordering
    $lastIdx = -1
    $lastName = '(start)'
    foreach ($name in $orderedTags) {
      $m = [regex]::Match($head, $tagPatterns[$name])
      if (-not $m.Success) { continue }
      if ($m.Index -lt $lastIdx) {
        Add-Error("Head tag out of order in ${path}: '$name' appears before '$lastName'")
        $pageOk = $false
        break
      }
      $lastIdx = $m.Index
      $lastName = $name
    }
    if ($pageOk) { Write-Host "OK HEAD $path" }
  }
}

# Auto-discover every dist HTML file recursively. Mirrors build.js's _src/
# walk so a newly added page is gated by every check without editing this list.
function Get-DistHtmlFiles {
  param([string]$BaseDirectory)
  if (-not (Test-Path $BaseDirectory)) { return @() }
  Get-ChildItem -Path $BaseDirectory -Filter '*.html' -Recurse -File |
    ForEach-Object {
      $rel = $_.FullName.Substring($BaseDirectory.Length).TrimStart('\', '/')
      $rel -replace '\\', '/'
    } |
    Sort-Object
}

Write-Host 'Building dist/ before validation...'
npm run build
if ($LASTEXITCODE -ne 0) {
  Add-Error('Build failed; dist/ was not generated successfully.')
}

if (-not (Test-Path (Join-Path $distRoot 'favicon.ico'))) {
  Add-Error('Missing favicon.ico in dist/.')
} else {
  Write-Host 'OK FILE dist/favicon.ico'
}

if (-not (Test-Path (Join-Path $distRoot 'og-image.png'))) {
  Add-Error('Missing og-image.png in dist/.')
} else {
  Write-Host 'OK FILE dist/og-image.png'
}

Test-XmlFile (Join-Path $distRoot 'sitemap.xml')
Test-JsonFile 'wrangler.jsonc'

$allHtmlFiles = @(Get-DistHtmlFiles -BaseDirectory $distRoot)

Test-LocalLinks -BaseDirectory $distRoot -Paths $allHtmlFiles
Test-NoInjectPlaceholders -BaseDirectory $distRoot -Paths $allHtmlFiles
Test-UnresolvedTokens -BaseDirectory $distRoot -Paths $allHtmlFiles
Test-ConsentBeforeAnalytics -BaseDirectory $distRoot -Paths $allHtmlFiles
Test-HeadOrder -BaseDirectory $distRoot -Paths $allHtmlFiles

if ($errors.Count -gt 0) {
  Write-Host ''
  Write-Host 'Validation failed:' -ForegroundColor Red
  foreach ($validationError in $errors) {
    Write-Host "- $validationError" -ForegroundColor Red
  }
  exit 1
}

Write-Host ''
Write-Host 'All validation checks passed.' -ForegroundColor Green
