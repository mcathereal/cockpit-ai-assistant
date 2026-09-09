<#
  Screenshots fuer die README erzeugen - ohne Node, ohne Cockpit, ohne Build.

  Prinzip: Das Plugin ist statisch (index.html + js/agent.js + css). Einzige
  Umgebung ist die Cockpit-Bridge (cockpit.spawn/http/file). Diese wird durch
  tools/preview/cockpit-mock.js mit festen Demo-Ausgaben ersetzt, die UI selbst
  ist zu 100 % die echte. Aufgenommen wird mit dem installierten Edge/Chrome im
  Headless-Modus.

  Aufruf:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-screenshots.ps1
  Ausgabe: docs\screenshot-*.png   (1440x900)

  Hinweis: bewusst KEIN echtes Cockpit + kein Playwright/Node noetig.
#>
param(
    [int]$Width = 1440,
    [int]$Height = 900,
    [switch]$Keep
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$prev = Join-Path $env:TEMP 'ai-assistant-preview'

# 1) Vorschau-Kopie der echten Dateien
function Remove-Tree($path) {
    if (Test-Path -LiteralPath $path) {
        cmd /c ("rd /s /q `"{0}`"" -f $path) 2>$null
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
}
Remove-Tree $prev
foreach ($d in 'css', 'js', 'tools') {
    if (Test-Path (Join-Path $root $d)) { Copy-Item (Join-Path $root $d) (Join-Path $prev $d) -Recurse -Force }
}
foreach ($f in 'index.html', 'setup.html', 'icon.svg', 'icon-brain.svg', 'manifest.json') {
    Copy-Item (Join-Path $root $f) (Join-Path $prev $f) -Force
}
# Mock als erstes Script vor agent.js einhaengen (UTF-8-safe, kein Get-Content in PS5.1)
$idx = Join-Path $prev 'index.html'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$html = $utf8.GetString([System.IO.File]::ReadAllBytes($idx))
$html = $html -replace '<script src="js/agent\.js"></script>', '<script src="tools/preview/cockpit-mock.js"></script><script src="js/agent.js"></script>'
[System.IO.File]::WriteAllBytes($idx, $utf8.GetBytes($html))

# 2) Browser finden
$browser = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'Kein Chromium-Browser (Edge/Chrome) gefunden.' }
Write-Output "Browser: $browser"

# 3) Aufnahmen: Name -> (Datei, Hash)
$shots = [ordered]@{
    'screenshot-chat'        = @{ file = 'index.html';   hash = '' }
    'screenshot-settings'    = @{ file = 'index.html';   hash = '#settings' }
    'screenshot-appearance'  = @{ file = 'index.html';   hash = '#appearance' }
    'screenshot-confirm'     = @{ file = 'index.html';   hash = '#modal' }
    'screenshot-setup'       = @{ file = 'setup.html';   hash = '' }
}

$docs = Join-Path $root 'docs'
if (-not (Test-Path $docs)) { New-Item -ItemType Directory -Path $docs | Out-Null }

foreach ($name in $shots.Keys) {
    $s = $shots[$name]
    $url = 'file:///' + ((Join-Path $prev $s.file) -replace '\\', '/') + $s.hash
    $out = Join-Path $docs ($name + '.png')
    $ud = Join-Path $env:TEMP ('ai-shot-ud-' + $name)
    Remove-Tree $ud
    $args = @(
        '--headless=new', '--disable-gpu', '--hide-scrollbars',
        '--allow-file-access-from-files',
        ('--virtual-time-budget=6000'),
        ('--window-size={0},{1}' -f $Width, $Height),
        ('--user-data-dir={0}' -f $ud),
        ('--screenshot={0}' -f $out),
        $url
    )
    $log = Join-Path $env:TEMP ($name + '.browser.log')
    $logOut = $log + '.out'
    Start-Process -FilePath $browser -ArgumentList $args -Wait -NoNewWindow `
        -RedirectStandardError $log -RedirectStandardOutput $logOut
    if (Test-Path $out) {
        Write-Output ("OK  {0,-24} {1,7:n0} bytes" -f ($name + '.png'), (Get-Item $out).Length)
    } else {
        Write-Output ("FEHLER {0}  ({1})" -f $name, $url)
        if (Test-Path $log) { Get-Content $log -Tail 6 | ForEach-Object { Write-Output ('    ' + $_) } }
    }
    Remove-Tree $ud
    foreach ($lf in @($log, $logOut)) { if (Test-Path -LiteralPath $lf) { cmd /c ("del /f /q `"{0}`"" -f $lf) 2>$null } }
}

if (-not $Keep) { Remove-Tree $prev }
Write-Output ("Ziel: {0}" -f $docs)
