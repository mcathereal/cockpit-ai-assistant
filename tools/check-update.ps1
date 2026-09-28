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

try {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'cockpit-ai-assistant'; 'Accept' = 'application/vnd.github+json' } -TimeoutSec 20
} catch {
  Write-Output "GitHub nicht erreichbar: $($_.Exception.Message)"
  exit 1
}
$latest = ($rel.tag_name -replace '^v', '')
Write-Output "Auf GitHub:  v$latest"

function ToParts($v) { ($v -split '[.\-+]') | ForEach-Object { [int]($_ -replace '\D','') } }
$a = ToParts $local; $b = ToParts $latest
$max = [Math]::Max($a.Count, $b.Count)
$newer = $false
for ($i = 0; $i -lt $max; $i++) {
  $x = if ($i -lt $a.Count) { $a[$i] } else { 0 }
  $y = if ($i -lt $b.Count) { $b[$i] } else { 0 }
  if ($y -gt $x) { $newer = $true; break }
  if ($y -lt $x) { break }
}
if ($newer) {
  Write-Output "UPDATE verfuegbar: v$latest (installiert v$local)"
  Write-Output "Installieren: git -C `"$root`" pull   bzw.  das Release-ZIP entpacken."
  exit 2
}
Write-Output "Bereits aktuell (v$local)."
exit 0