#Requires -Version 7
<#
.SYNOPSIS
Gets the Node.js runtime the tray ships with (owner's decision D-T1), checked against tray/node.json.

.DESCRIPTION
Downloads the pinned win-x64 zip from nodejs.org (or takes a local copy with -Zip), refuses it unless its SHA-256 is the
pinned one, and writes node.exe (checked against its own pinned SHA-256) and Node's LICENSE as node-LICENSE to
-OutDir. tray/node.json is the one place the version and both checksums are kept; see docs/sync.md, "The tray app".

.EXAMPLE
scripts/get-tray-node.ps1 -WorkDir T:\work\node -OutDir T:\work\publish
#>
[CmdletBinding()]
param(
  # Where the zip is downloaded to. A file already there is checked like a new download.
  [Parameter(Mandatory)] [string] $WorkDir,
  # Where node.exe and node-LICENSE go.
  [Parameter(Mandatory)] [string] $OutDir,
  # A local copy of the pinned zip instead of the download, checked the same way.
  [string] $Zip
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$pin = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..' 'tray' 'node.json') | ConvertFrom-Json
foreach ($field in 'version', 'zip', 'zipSha256', 'nodeExeSha256') {
  if (-not $pin.$field) { throw "tray/node.json has no $field" }
}

function Assert-Sha256([string] $Path, [string] $Expected, [string] $What) {
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "$What does not match tray/node.json: SHA-256 $actual, expected $Expected. Nothing was packed."
  }
}

New-Item -ItemType Directory -Force -Path $WorkDir, $OutDir | Out-Null
if (-not $Zip) {
  $Zip = Join-Path $WorkDir $pin.zip
  if (-not (Test-Path -LiteralPath $Zip)) {
    $url = "https://nodejs.org/dist/v$($pin.version)/$($pin.zip)"
    Write-Host "==> Downloading $url"
    $partial = "$Zip.partial"
    Invoke-WebRequest -Uri $url -OutFile $partial -MaximumRetryCount 3 -RetryIntervalSec 5
    Move-Item -LiteralPath $partial -Destination $Zip
  }
}
Assert-Sha256 $Zip $pin.zipSha256 $pin.zip

Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFileNameWithoutExtension($pin.zip)
# Extracted beside the zip and checked there, so a file that fails the check never reaches -OutDir.
$extracted = Join-Path $WorkDir 'node-extracted'
New-Item -ItemType Directory -Force -Path $extracted | Out-Null
$archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Zip).Path)
try {
  foreach ($pair in @(@('node.exe', 'node.exe'), @('LICENSE', 'node-LICENSE'))) {
    $entry = $archive.GetEntry("$root/$($pair[0])")
    if (-not $entry) { throw "$($pin.zip) has no $root/$($pair[0])" }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $extracted $pair[1]), $true)
  }
}
finally {
  $archive.Dispose()
}
Assert-Sha256 (Join-Path $extracted 'node.exe') $pin.nodeExeSha256 'node.exe'
Copy-Item -LiteralPath (Join-Path $extracted 'node.exe'), (Join-Path $extracted 'node-LICENSE') -Destination $OutDir -Force
Write-Host "    Node.js $($pin.version): node.exe and node-LICENSE, checked against tray/node.json"
