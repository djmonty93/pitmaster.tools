$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoRoot

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
  param([string[]]$Paths)

  $pattern = '<[^>' + "`r`n" + ']+\b(?:href|src)="([^"]+)"'
  foreach ($path in $Paths) {
    $content = Get-Content $path -Raw
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
        Join-Path $repoRoot $cleanTarget.TrimStart('/')
      } else {
        Join-Path (Split-Path -Parent (Join-Path $repoRoot $path)) $cleanTarget
      }

      if (-not (Test-Path $resolved)) {
        Add-Error("Missing local link target in ${path}: $target")
      }
    }
    Write-Host "OK LINK $path"
  }
}

$htmlFiles = @(
  'brine-calculator.html',
  'cook-time-coordinator.html',
  'index.html',
  'charcoal-calculator.html',
  'dry-rub-calculator.html',
  'meat-per-person.html',
  'privacy-policy.html',
  'terms-of-service.html'
)

if (-not (Test-Path 'favicon.ico')) {
  Add-Error('Missing favicon.ico at repo root.')
} else {
  Write-Host 'OK FILE favicon.ico'
}

Test-XmlFile 'sitemap.xml'
Test-JsonFile 'wrangler.jsonc'
Test-LocalLinks $htmlFiles

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
