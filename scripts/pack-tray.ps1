#Requires -Version 7.4
<#
.SYNOPSIS
Builds and packs the sync tray app for a release with Velopack, then checks the package.

.DESCRIPTION
The Release workflow's Windows job runs it on the release commit (.github/workflows/release.yml); it runs the same way
on a PC for a local package. Steps: the pinned Node.js (scripts/get-tray-node.ps1), `dotnet publish` of the tray with
-Version, the engine bundle copied in, `vpk pack` (pack id AdiutorSync, channel win) into -OutputDir, then
scripts/test-tray-package.ps1. -OutputDir may already hold the previous release from `vpk download github`, so Velopack
adds a delta package; without it the package is full only. Uploads nothing.

.EXAMPLE
scripts/pack-tray.ps1 -Version 0.3.0 -Bundle dist/sync/adiutor-sync.js -OutputDir T:\work\releases -WorkDir T:\work\pack
#>
[CmdletBinding()]
param(
  # The release's version, as in package.json at the release commit.
  [Parameter(Mandatory)] [string] $Version,
  # dist/sync/adiutor-sync.js, built from the same commit.
  [Parameter(Mandatory)] [string] $Bundle,
  # Velopack's release folder: the installer and the feed files end up here.
  [Parameter(Mandatory)] [string] $OutputDir,
  # A new or empty folder for the Node download and the published app.
  [Parameter(Mandatory)] [string] $WorkDir,
  # A local copy of the pinned Node.js zip instead of the download (scripts/get-tray-node.ps1).
  [string] $NodeZip
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PSNativeCommandUseErrorActionPreference = $true

if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw "-Version must be a release version such as 1.2.3, not '$Version'" }
if (-not (Test-Path -LiteralPath $Bundle -PathType Leaf)) { throw "the engine bundle $Bundle does not exist" }
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$tray = Join-Path $repo 'tray'
New-Item -ItemType Directory -Force -Path $WorkDir, $OutputDir | Out-Null
$publish = Join-Path $WorkDir 'publish'
if (Test-Path -LiteralPath $publish) { throw "$publish exists already: give a new -WorkDir" }

$nodeArgs = @{ WorkDir = (Join-Path $WorkDir 'node'); OutDir = $publish }
if ($NodeZip) { $nodeArgs.Zip = $NodeZip }
& (Join-Path $PSScriptRoot 'get-tray-node.ps1') @nodeArgs

Write-Host "==> Publishing the tray $Version"
dotnet publish (Join-Path $tray 'src' 'AdiutorSync' 'AdiutorSync.csproj') --configuration Release --output $publish -p:Version=$Version
Copy-Item -LiteralPath $Bundle -Destination (Join-Path $publish 'adiutor-sync.js')

Write-Host "==> Packing AdiutorSync $Version"
Push-Location $tray
try {
  dotnet tool restore
  dotnet vpk pack --packId AdiutorSync --packVersion $Version --packDir $publish --mainExe AdiutorSync.exe `
    --packTitle 'Adiutor Sync' --shortcuts StartMenuRoot --channel win --outputDir $OutputDir `
    --icon (Join-Path $tray 'src' 'AdiutorSync' 'adiutor.ico')
}
finally {
  Pop-Location
}

$nodeZipUsed = if ($NodeZip) { $NodeZip } else { Join-Path $WorkDir 'node' ((Get-Content -Raw (Join-Path $tray 'node.json') | ConvertFrom-Json).zip) }
& (Join-Path $PSScriptRoot 'test-tray-package.ps1') -Version $Version -Bundle $Bundle -OutputDir $OutputDir `
  -NodeZip $nodeZipUsed -WorkDir (Join-Path $WorkDir 'test')
