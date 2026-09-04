# Copie les plugins EntreNous vers orbit/public/plugins/third/ pour npm run dev.
# Usage (PowerShell) :
#   .\scripts\link-plugins-local.ps1
#   .\scripts\link-plugins-local.ps1 -OrbitRoot C:\Users\famil\orbit

param(
  [string]$OrbitRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\orbit")).Path,
  [string]$PluginsRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$destRoot = Join-Path $OrbitRoot "public\plugins\third"
$bundles = @(
  @{ Name = "orbit-conference"; File = "orbit-conference.js" },
  @{ Name = "orbit-room-gallery"; File = "orbit-room-gallery.js" },
  @{ Name = "orbit-helpserv-welcome"; File = "orbit-helpserv-welcome.js" },
  @{ Name = "orbit-petitbac"; File = "orbit-petitbac.js" },
  @{ Name = "orbit-echecs"; File = "orbit-echecs.js" },
  @{ Name = "orbit-harrypotter"; File = "orbit-harrypotter.js" },
  @{ Name = "orbit-callerid"; File = "orbit-callerid.js" },
  @{ Name = "orbit-anope"; File = "orbit-anope.js" },
  @{ Name = "orbit-chanserv"; File = "orbit-chanserv.js" }
)

if (-not (Test-Path $OrbitRoot)) {
  Write-Error "Orbit introuvable : $OrbitRoot"
  exit 1
}

New-Item -ItemType Directory -Force -Path $destRoot | Out-Null

foreach ($b in $bundles) {
  $src = Join-Path $PluginsRoot "plugins\$($b.Name)\$($b.File)"
  $dir = Join-Path $destRoot $b.Name
  $dst = Join-Path $dir $b.File
  if (-not (Test-Path $src)) {
    Write-Warning "Ignoré (source absente) : $src"
    continue
  }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Copy-Item -Force $src $dst
  Write-Host "OK $dst"
}

Write-Host ""
Write-Host "Copie terminée. Lance Orbit (npm run dev) et utilise entrenous-orbit/config/config.json dans orbit/public/config.json si besoin."
