<#
  Sicher veroeffentlichen: erst Review (Geheimnisse/interne Angaben), dann Commit,
  dann Push, dann optional Tag v<manifest.version>.

  Aufruf:
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -Message "feat: ..."
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -Message "..." -Tag
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish.ps1 -Message "..." -Tag -History

  Bricht ab, wenn das LOKALE Review-Skript tools\.local\scan-secrets.ps1 fehlt oder
  harte Treffer findet. Das Skript liegt bewusst nicht im Repo (es enthaelt interne
  Infrastruktur-Muster) und wird per .gitignore ausgeschlossen.
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
$scanFile = Join-Path $PSScriptRoot '.local\scan-secrets.ps1'
if (-not (Test-Path -LiteralPath $scanFile)) {
  Write-Output "ABBRUCH: lokales Review-Skript tools/.local/scan-secrets.ps1 fehlt - nicht publishen."
  exit 1
}
$scanArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scanFile)
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