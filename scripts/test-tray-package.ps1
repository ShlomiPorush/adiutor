#Requires -Version 7.4
<#
.SYNOPSIS
Checks the tray package scripts/pack-tray.ps1 made, and that a Node.js zip off its pin is refused.

.DESCRIPTION
The full package of -Version must carry node.exe with the SHA-256 tray/node.json pins, Node's LICENSE (node-LICENSE),
the engine bundle byte for byte, and AdiutorSync.exe; AdiutorSync.exe and the installer must show Adiutor's icon
(tray/src/AdiutorSync/adiutor.ico, as Windows loads it at 16 and 32 pixels); the build's asset list (assets.win.json) must name the installer
and that package, and the local feed must give the package's real SHA-256 and size. Then scripts/get-tray-node.ps1 gets
a copy of -NodeZip with one byte changed and must refuse it. Prints one line per check and fails on any failed check.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Version,
  [Parameter(Mandatory)] [string] $Bundle,
  [Parameter(Mandatory)] [string] $OutputDir,
  # The pinned zip the package was made with (a copy is changed for the refusal check).
  [Parameter(Mandatory)] [string] $NodeZip,
  # A new or empty folder for the refusal check.
  [Parameter(Mandatory)] [string] $WorkDir
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$pin = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..' 'tray' 'node.json') | ConvertFrom-Json
$script:failed = 0
$script:passed = 0
function Check([string] $What, [scriptblock] $Test) {
  $ok = $false
  try { $ok = [bool](& $Test) } catch { Write-Host "      | $($_.Exception.Message)" }
  if ($ok) { $script:passed++ } else { $script:failed++; Write-Host "FAIL: $What" }
}
function Sha256([string] $Path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
# The icon Windows loads from an exe at a size, compared pixel by pixel with that size of adiutor.ico.
$ico = Join-Path $PSScriptRoot '..' 'tray' 'src' 'AdiutorSync' 'adiutor.ico'
Add-Type -AssemblyName System.Drawing
function SameIcon([string] $Exe) {
  foreach ($size in 16, 32) {
    $want = New-Object Drawing.Icon $ico, $size, $size
    $got = [Drawing.Icon]::ExtractIcon($Exe, 0, $size)
    if ($null -eq $got) { $want.Dispose(); return $false }
    $a = $want.ToBitmap(); $b = $got.ToBitmap()
    try {
      if ($a.Width -ne $size -or $b.Width -ne $size -or $b.Height -ne $size) { return $false }
      for ($y = 0; $y -lt $size; $y++) {
        for ($x = 0; $x -lt $size; $x++) { if ($a.GetPixel($x, $y) -ne $b.GetPixel($x, $y)) { return $false } }
      }
    }
    finally { $a.Dispose(); $b.Dispose(); $want.Dispose(); $got.Dispose() }
  }
  $true
}
function EntrySha256($Entry) {
  $stream = $Entry.Open()
  try { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() } finally { $stream.Dispose() }
}

$full = Join-Path $OutputDir "AdiutorSync-$Version-full.nupkg"
Check "the full package AdiutorSync-$Version-full.nupkg exists" { Test-Path -LiteralPath $full -PathType Leaf }
Check 'the installer AdiutorSync-win-Setup.exe exists' { Test-Path -LiteralPath (Join-Path $OutputDir 'AdiutorSync-win-Setup.exe') -PathType Leaf }
Check "the installer shows Adiutor's icon" { SameIcon (Join-Path $OutputDir 'AdiutorSync-win-Setup.exe') }
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $full -PathType Leaf) {
  $archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $full).Path)
  try {
    $entry = { param($name) $archive.GetEntry("lib/app/$name") }
    Check 'the package carries node.exe with the pinned SHA-256' { (EntrySha256 (& $entry 'node.exe')) -eq $pin.nodeExeSha256 }
    Check "the package carries Node's LICENSE" {
      $stream = (& $entry 'node-LICENSE').Open()
      try { (New-Object IO.StreamReader($stream)).ReadLine() -eq 'Node.js is licensed for use as follows:' } finally { $stream.Dispose() }
    }
    Check 'the package carries the engine bundle byte for byte' { (EntrySha256 (& $entry 'adiutor-sync.js')) -eq (Sha256 $Bundle) }
    Check 'the package carries AdiutorSync.exe' { $null -ne (& $entry 'AdiutorSync.exe') }
    Check "AdiutorSync.exe shows Adiutor's icon" {
      $exe = Join-Path $WorkDir 'AdiutorSync.exe'
      [IO.Compression.ZipFileExtensions]::ExtractToFile((& $entry 'AdiutorSync.exe'), $exe, $true)
      SameIcon $exe
    }
    Check "the package's version is $Version" {
      $stream = $archive.GetEntry('AdiutorSync.nuspec').Open()
      try { ([xml](New-Object IO.StreamReader($stream)).ReadToEnd()).package.metadata.version -eq $Version } finally { $stream.Dispose() }
    }
  }
  finally {
    $archive.Dispose()
  }
}

Check 'the asset list names the installer and the full package' {
  $assets = Get-Content -Raw -LiteralPath (Join-Path $OutputDir 'assets.win.json') | ConvertFrom-Json
  $names = @($assets | ForEach-Object { $_.RelativeFileName })
  ($names -contains 'AdiutorSync-win-Setup.exe') -and ($names -contains "AdiutorSync-$Version-full.nupkg")
}
Check "the local feed gives the full package's SHA-256 and size" {
  $feed = Get-Content -Raw -LiteralPath (Join-Path $OutputDir 'releases.win.json') | ConvertFrom-Json
  $item = @($feed.Assets | Where-Object { $_.FileName -eq "AdiutorSync-$Version-full.nupkg" })
  $item.Count -eq 1 -and $item[0].SHA256.ToLowerInvariant() -eq (Sha256 $full) -and $item[0].Size -eq (Get-Item -LiteralPath $full).Length
}

# A zip off its pin is refused, and its node.exe never reaches the output folder.
$bad = Join-Path $WorkDir 'changed.zip'
Copy-Item -LiteralPath $NodeZip -Destination $bad -Force
$bytes = [IO.File]::ReadAllBytes($bad)
$bytes[$bytes.Length - 1] = $bytes[$bytes.Length - 1] -bxor 0xFF
[IO.File]::WriteAllBytes($bad, $bytes)
$refusedOut = Join-Path $WorkDir 'out'
$message = ''
try {
  & (Join-Path $PSScriptRoot 'get-tray-node.ps1') -WorkDir (Join-Path $WorkDir 'node') -OutDir $refusedOut -Zip $bad 6>$null
}
catch {
  $message = $_.Exception.Message
}
Check 'a Node.js zip off its pin is refused' { $message -like '*does not match tray/node.json*' }
Check '  and no node.exe is written' { -not (Test-Path -LiteralPath (Join-Path $refusedOut 'node.exe')) }

Write-Host "tray package: $($script:passed) passed, $($script:failed) failed"
if ($script:failed -gt 0) { throw "the tray package failed $($script:failed) check(s)" }
