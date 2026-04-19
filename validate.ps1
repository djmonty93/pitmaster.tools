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

function Test-JsonFile {
  param([string]$Path)
  try {
    Get-Content $Path -Raw | ConvertFrom-Json | Out-Null
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

      $resolved = if ($cleanTarget.StartsWith('/')) {
        Join-Path $BaseDirectory $cleanTarget.TrimStart('/')
      } else {
        Join-Path (Split-Path -Parent $fullPath) $cleanTarget
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
Test-LocalLinks -BaseDirectory $distRoot -Paths $htmlFiles
Test-NoInjectPlaceholders -BaseDirectory $distRoot -Paths $htmlFiles

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
