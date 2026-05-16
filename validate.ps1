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
    $matches = Select-String -Path $fullPath -Pattern '\{\{[A-Z_]+\}\}'
    if ($matches) {
      foreach ($m in $matches) {
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
    $consentIdx  = $content.IndexOf("gtag('consent', 'default'")
    $analyticsIdx = [Math]::Min(
      ($content.IndexOf('googletagmanager.com') + [int]($content.IndexOf('googletagmanager.com') -lt 0) * [int]::MaxValue),
      ($content.IndexOf('pagead2.googlesyndication') + [int]($content.IndexOf('pagead2.googlesyndication') -lt 0) * [int]::MaxValue)
    )
    if ($consentIdx -ge 0 -and $analyticsIdx -lt [int]::MaxValue -and $analyticsIdx -lt $consentIdx) {
      Add-Error("Consent default must precede analytics loader in ${path}")
    } else {
      Write-Host "OK CON  $path"
    }
  }
}

function Test-HeadOrder {
  # Enforces the ordered head block required by CLAUDE.md: each present tag
  # must appear in the expected sequence. Missing tags are skipped (so minimal
  # pages like 404.html don't trip the check); only mis-ordering fails.
  param(
    [string]$BaseDirectory,
    [string[]]$Paths
  )

  $expectedTags = @(
    @{ name = 'charset';       pattern = '<meta\s+charset=' },
    @{ name = 'viewport';      pattern = '<meta\s+name="viewport"' },
    @{ name = 'title';         pattern = '<title>' },
    @{ name = 'description';   pattern = '<meta\s+name="description"' },
    @{ name = 'robots';        pattern = '<meta\s+name="robots"' },
    @{ name = 'canonical';     pattern = '<link\s+rel="canonical"' },
    @{ name = 'og:title';      pattern = '<meta\s+property="og:title"' },
    @{ name = 'og:description';pattern = '<meta\s+property="og:description"' },
    @{ name = 'og:type';       pattern = '<meta\s+property="og:type"' },
    @{ name = 'og:url';        pattern = '<meta\s+property="og:url"' },
    @{ name = 'og:image';      pattern = '<meta\s+property="og:image"' },
    @{ name = 'twitter:card';  pattern = '<meta\s+name="twitter:card"' },
    @{ name = 'twitter:title'; pattern = '<meta\s+name="twitter:title"' },
    @{ name = 'twitter:description'; pattern = '<meta\s+name="twitter:description"' },
    @{ name = 'twitter:image'; pattern = '<meta\s+name="twitter:image"' },
    @{ name = 'favicon';       pattern = '<link\s+rel="icon"\s+href=' },
    @{ name = 'consent';       pattern = "gtag\('consent', 'default'" }
  )

  foreach ($path in $Paths) {
    $fullPath = Join-Path $BaseDirectory $path
    $content = Get-Content $fullPath -Raw
    $headMatch = [regex]::Match($content, '(?s)<head>(.*?)</head>')
    if (-not $headMatch.Success) {
      Add-Error("No <head> block found in ${path}")
      continue
    }
    $head = $headMatch.Groups[1].Value

    $lastIdx = -1
    $lastName = '(start)'
    $pageOk = $true
    foreach ($tag in $expectedTags) {
      $m = [regex]::Match($head, $tag.pattern)
      if (-not $m.Success) { continue }
      if ($m.Index -lt $lastIdx) {
        Add-Error("Head tag out of order in ${path}: '$($tag.name)' appears before '$lastName'")
        $pageOk = $false
        break
      }
      $lastIdx = $m.Index
      $lastName = $tag.name
    }
    if ($pageOk) { Write-Host "OK HEAD $path" }
  }
}

$htmlFiles = @(
  '404.html',
  'about.html',
  'bbq-cost-calculator.html',
  'brisket-calculator.html',
  'brisket-yield-calculator.html',
  'brine-calculator.html',
  'catering-calculator.html',
  'cook-time-coordinator.html',
  'pork-shoulder-calculator.html',
  'index.html',
  'charcoal-calculator.html',
  'dry-rub-calculator.html',
  'meat-per-person.html',
  'privacy-policy.html',
  'rib-calculator.html',
  'tools.html',
  'turkey-smoking-calculator.html',
  'terms-of-service.html'
)

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

# Auto-discover every page under dist/smoke-weather/ so the 50 generated metro
# pages (and any hand-authored siblings like index.html / disclosures.html)
# get the same link + INJECT validation as the hardcoded site pages.
$smokeWeatherDir = Join-Path $distRoot 'smoke-weather'
$smokeWeatherFiles = @()
if (Test-Path $smokeWeatherDir) {
  $smokeWeatherFiles = Get-ChildItem -Path $smokeWeatherDir -Filter '*.html' |
    Sort-Object Name |
    ForEach-Object { "smoke-weather/$($_.Name)" }
}
# Step 15 (F19): same auto-discovery for the seasonal/ subdirectory — the four
# winter/spring/summer/fall placeholder pages live here and need the same
# link + INJECT validation as the smoke-weather siblings.
$seasonalDir = Join-Path $distRoot 'seasonal'
$seasonalFiles = @()
if (Test-Path $seasonalDir) {
  $seasonalFiles = Get-ChildItem -Path $seasonalDir -Filter '*.html' |
    Sort-Object Name |
    ForEach-Object { "seasonal/$($_.Name)" }
}
$allHtmlFiles = $htmlFiles + $smokeWeatherFiles + $seasonalFiles

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
