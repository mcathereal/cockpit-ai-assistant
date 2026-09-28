<#
  Sicher veroeffentlichen: erst Review (Geheimnisse/interne Angaben), dann Commit,
  dann Push, dann optional Tag v<manifest.version>.

  Aufruf:
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -Message "feat: ..."
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -Message "..." -Tag
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -Message "..." -Tag -History

  Bricht ab, wenn tools\scan-secrets.ps1 harte Treffer findet.
#>
param(
  [Parameter(Mandatory = $true)][string]$Message,
  [switch]$Tag,
  [switch]$History,
  [switch]$Strict,
  [string]$Remote = 'origin',
  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repo

Write-Output "== 1/4 Review (scan-secrets) =="
$scanArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'scan-secrets.ps1'))
if ($History) { $scanArgs += '-History' }
if ($Strict) { $scanArgs += '-Strict' }
& powershell @scanArgs
if ($LASTEXITCODE -ne 0) {
  Write-Output "ABBRUCH: Review hat harte Treffer gemeldet - nichts wird committet."
  exit 1
}

Write-Output "== 2/4 Commit =="
git add -A
git commit -m $Message
if ($LASTEXITCODE -ne 0) { Write-Output "Kein Commit (nichts zu tun?)."; }

Write-Output "== 3/4 Push =="
git push $Remote $Branch
if ($LASTEXITCODE -ne 0) { Write-Output "ABBRUCH: Push fehlgeschlagen."; exit 1 }

if ($Tag) {
  $version = (Get-Content -LiteralPath (Join-Path $repo 'manifest.json') -Raw | ConvertFrom-Json).version
  $t = "v$version"
  Write-Output "== 4/4 Tag $t =="
  if (git tag -l $t) { Write-Output "Tag $t existiert lokal schon." }
  else { git tag -a $t -m "Release $t" }
  git push $Remote $t
}
Write-Output "Fertig."
exit 0