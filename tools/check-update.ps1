<#
  Prueft, ob auf GitHub eine neuere Version liegt als die installierte.
  Gedacht fuer installierte Kopien (Batch: tools\check-update.cmd).

  Aufruf:
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\check-update.ps1
  Exit 0 = aktuell, 2 = Update verfuegbar, 1 = Fehler.
#>
param([string]$Repo = 'mcathereal/cockpit-ai-assistant')

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $root 'manifest.json'
if (-not (Test-Path -LiteralPath $manifest)) { Write-Output "manifest.json nicht gefunden: $manifest"; exit 1 }
try { $local = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version } catch { Write-Output "manifest.json nicht lesbar: $($_.Exception.Message)"; exit 1 }
Write-Output "Installiert: v$local"

function ToParts($v) { ($v -split '[.\-+]') | ForEach-Object { [int]($_ -replace '\D','') } }
function IsNewer($have, $cand) {
  $x = ToParts $have; $y = ToParts $cand
  $max = [Math]::Max($x.Count, $y.Count)
  for ($i = 0; $i -lt $max; $i++) {
    $p = if ($i -lt $x.Count) { $x[$i] } else { 0 }
    $q = if ($i -lt $y.Count) { $y[$i] } else { 0 }
    if ($q -gt $p) { return $true }
    if ($q -lt $p) { return $false }
  }
  return $false
}

try {
  $rels = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=100" -Headers @{ 'User-Agent' = 'cockpit-ai-assistant'; 'Accept' = 'application/vnd.github+json' } -TimeoutSec 20
} catch {
  Write-Output "GitHub nicht erreichbar: $($_.Exception.Message)"
  exit 1
}
$latest = ''
foreach ($r in $rels) {
  $t = ($r.tag_name -replace '^v', '')
  if (-not $t) { continue }
  if (-not $latest -or (IsNewer $latest $t)) { $latest = $t }
}
if (-not $latest) { Write-Output "Keine Releases gefunden - als aktuell betrachtet (v$local)."; exit 0 }
Write-Output "Neueste auf GitHub: v$latest"

if (IsNewer $local $latest) {
  Write-Output "UPDATE verfuegbar: v$latest (installiert v$local)"
  Write-Output "Installieren: git -C `"$root`" pull   bzw.  das Release-ZIP entpacken."
  exit 2
}
Write-Output "Bereits aktuell (v$local)."
exit 0