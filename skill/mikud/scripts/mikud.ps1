# mikud for agents: connect to Mikud with a code the owner approves in the browser (Better Auth's device
# authorization), then keep the owner's board current through Mikud's /api/v1 routes.
#
# One of three versions with one contract: mikud.mjs (Node 20+), mikud.ps1 (Windows PowerShell 5.1 and PowerShell 7)
# and mikud.sh (POSIX sh and curl). Same commands, same one-line JSON answers and error codes, the same files and the
# same lock, so they can run side by side on one computer. No secret ever appears in the output. See mikud.mjs for
# the design; this file follows it function by function.
#
# It hands over to mikud.mjs when Node 20+ is installed, unless MIKUD_NO_NODE is set.
#
# Run it as: powershell -NoProfile -ExecutionPolicy Bypass -File mikud.ps1 <command> ...
# (the policy is bypassed for this one process only; nothing on the computer changes).

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$IsWin = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT

# One argument on a Windows command line, quoted the way programs built on the C runtime (Node) read it back.
function ConvertTo-WindowsArgument([string]$a) {
  if ($a.Length -and $a -notmatch '[\s"]') { return $a }
  '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)\z', '$1$1') + '"'
}

# Node 20+ runs mikud.mjs. Started directly (no shell, no PowerShell argument rewriting), with this process's
# standard input and output, so the arguments and the answer pass through unchanged.
if (-not $env:MIKUD_NO_NODE) {
  $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  # On Windows only a real node.exe: a .cmd stand-in would hand the arguments to cmd.exe.
  if ($node -and (-not $IsWin -or $node.Source -match '\.exe\z')) {
    $version = ''
    try { $version = [string](& $node.Source --version 2>$null | Select-Object -First 1) } catch {}
    if ($version -cmatch '^v([0-9]+)\.' -and [int]$Matches[1] -ge 20) {
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = $node.Source
      $psi.UseShellExecute = $false
      $all = @((Join-Path $PSScriptRoot 'mikud.mjs')) + @($args | ForEach-Object { [string]$_ })
      if ($IsWin) { $psi.Arguments = @($all | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' ' }
      else { foreach ($a in $all) { $psi.ArgumentList.Add($a) } }
      $child = [Diagnostics.Process]::Start($psi)
      $child.WaitForExit()
      exit $child.ExitCode
    }
  }
}

$OnLinux = (-not $IsWin) -and [Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Linux)
$Core = $PSVersionTable.PSVersion.Major -ge 6
$Invariant = [Globalization.CultureInfo]::InvariantCulture
$Utf8 = New-Object System.Text.UTF8Encoding($false)

$ClientId = 'mikud-connect'
$DeviceGrant = 'urn:ietf:params:oauth:grant-type:device_code'
$DaysDefault = 90
$DaysMin = 1
$DaysMax = 365
function Get-Whole($value, [double]$fallback) {
  if ([string]$value -cmatch '^[1-9][0-9]*\z') { return [double]::Parse([string]$value, $Invariant) }
  $fallback
}
$WaitSeconds = Get-Whole $env:MIKUD_WAIT_SECONDS 90
# Test seams: the tests shorten the lock wait and the request timeout, and move the clock forward.
$LockWaitMs = Get-Whole $env:MIKUD_TEST_LOCK_WAIT_MS 20000
$TimeoutMs = Get-Whole $env:MIKUD_TEST_TIMEOUT_MS 15000
$ClockOffset = [long](Get-Whole $env:MIKUD_TEST_CLOCK_OFFSET 0)
# Every pattern is matched case-sensitively (-cmatch) and ends with \z: in .NET, $ also matches before a last newline.
# Device codes and keys as Mikud sends them; anything else is refused before it is stored.
$Secret = '^[A-Za-z0-9._~+/=-]{8,512}\z'
# Every value in a file: no quote, backslash or control character, so the shell version reads it too.
$Plain = '^[^"\\\x00-\x1f\x7f]*\z'
$LabelPattern = '^[A-Za-z0-9 ._:-]{1,60}\z'
# The path part: lower-case letters, digits, slash and hyphen only, matched as typed, never decoded.
$PathPart = '^[a-z0-9/-]+\z'
# RFC 3986's query characters, without the apostrophe and with every % followed by two hex digits. Passed on as typed.
$Query = '^(?:[A-Za-z0-9\-._~!$&()*+,;=:@/?]|%[0-9A-Fa-f]{2})*\z'
$Uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
# The only calls the command makes on /api/v1: one per MCP tool.
$Routes = @(
  @('POST', 'threads/start'), @('GET', 'items'), @('GET', 'items/{id}'), @('POST', 'items'), @('PATCH', 'items/{id}'),
  @('POST', 'items/{id}/comments'), @('POST', 'capture'), @('POST', 'items/{id}/threads'), @('GET', 'projects'),
  @('PATCH', 'projects/{id}'), @('POST', 'projects/{id}/stage-proposals'), @('GET', 'notes'), @('GET', 'notes/{id}'),
  @('POST', 'notes'), @('PATCH', 'notes/{id}')
) | ForEach-Object { , @($_[0], ('^' + $_[1].Replace('{id}', $Uuid) + '\z')) }

$ConnectionFields = @(@('v', 'n'), @('origin', 's'), @('key', 's'), @('keyName', 's'), @('expiresAt', 's'))
$PendingFields = @(
  @('v', 'n'), @('attemptId', 's'), @('origin', 's'), @('deviceCode', 's'), @('userCode', 's'), @('link', 's'),
  @('interval', 'n'), @('nextPollAt', 'n'), @('codeExpiresAt', 'n'), @('days', 'n'), @('keyName', 's'), @('phase', 's'),
  @('pollInFlight', 'n'), @('uncertain', 'n'), @('sessionOpen', 'n'), @('keySaved', 'n')
)
$LeftFields = @(@('origin', 's'), @('keyName', 's'), @('expiresAt', 's'), @('reason', 's'), @('at', 's'))
# Reasons whose key end date came from Mikud: the entry drops by itself once that date has passed.
$Dated = @('replaced', 'disconnected', 'not_saved')
$Reasons = $Dated + @('key_unknown', 'session_unknown')

class MikudFail : System.Exception {
  [string]$Code
  [string]$Text
  [hashtable]$Extra
  MikudFail([string]$code, [string]$text) : base($text) { $this.Code = $code; $this.Text = $text; $this.Extra = @{} }
}

# The attempt changed under this run (another command, after a wrongly broken lock): answer from the new state.
class MikudChanged : System.Exception {
  MikudChanged() : base('The attempt changed.') {}
}

# A JSON number, kept as the text it came in.
class JsonNumber {
  [string]$Raw
  JsonNumber([string]$raw) { $this.Raw = $raw }
}

function New-Fail([string]$code, [string]$text, [hashtable]$extra) {
  $f = [MikudFail]::new($code, $text)
  if ($extra) { $f.Extra = $extra }
  $f
}
function Fail([string]$code, [string]$text) { throw (New-Fail $code $text $null) }

$Rng = [Security.Cryptography.RandomNumberGenerator]::Create()
function Now { [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + $ClockOffset }
function Iso([double]$seconds) {
  $ms = [long][Math]::Floor($seconds * 1000)
  [DateTimeOffset]::FromUnixTimeMilliseconds($ms).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", $Invariant)
}
function Hex([int]$n) {
  $b = New-Object byte[] $n
  $Rng.GetBytes($b)
  [BitConverter]::ToString($b).Replace('-', '').ToLowerInvariant()
}
function Get-HostName {
  if ($IsWin) { if ($env:COMPUTERNAME) { return $env:COMPUTERNAME }; return [Environment]::MachineName }
  [Net.Dns]::GetHostName()
}
function Test-SameHost($name) { ([string]$name).ToLowerInvariant() -ceq (Get-HostName).ToLowerInvariant() }
function Get-GroupedCode([string]$code) { if ($code.Length -eq 8) { return $code.Substring(0, 4) + '-' + $code.Substring(4) }; $code }
function Get-WaitCommand([string]$origin) { "mikud connect --wait --url $origin" }
$SessionText = "Mikud may have opened a 'mikud connect (agent approval)' session that was not ended: end it on the Account page."

# Windows tools by their full path: started from Git Bash, for one, whoami.exe may be a different program.
$Icacls = ''
if ($IsWin) {
  $root = $env:SystemRoot
  if (-not $root) { $root = 'C:\Windows' }
  $Icacls = Join-Path $root 'System32\icacls.exe'
}

# Removes a file or folder (a link itself, never what it points to), ignoring failures.
function Remove-Path([string]$target) {
  try {
    $attr = [IO.File]::GetAttributes($target)
    $isDir = ($attr -band [IO.FileAttributes]::Directory) -ne 0
    $isLink = ($attr -band [IO.FileAttributes]::ReparsePoint) -ne 0
    if ($isDir -and -not $isLink) { [IO.Directory]::Delete($target, $true) }
    elseif ($isDir) { [IO.Directory]::Delete($target) }
    else { [IO.File]::Delete($target) }
  } catch {}
}

# Whether a path exists, a link included.
function Test-Exists([string]$target) {
  try { [void][IO.File]::GetAttributes($target); return $true }
  catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { return $false }
  catch { return $true }
}

# JSON without PowerShell's converters: PowerShell 7 turns date strings into dates and 5.1 writes some values in its
# own way. Objects keep their order (ordinal keys), numbers keep their text.

$JsonToken = New-Object regex ('\G(?:(?<w>[ \t\r\n]+)|(?<p>[{}\[\],:])|(?<s>"(?:(?>[^"\\\x00-\x1f]+)|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")|(?<n>-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)|(?<k>true|false|null))')
$JsonUnescape = New-Object regex '\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))'
$JsonEscape = New-Object regex '[\x00-\x1f"\\]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]'

function ConvertFrom-JsonString([string]$token) {
  $inner = $token.Substring(1, $token.Length - 2)
  if ($inner.IndexOf([char]92) -lt 0) { return $inner }
  $JsonUnescape.Replace($inner, [Text.RegularExpressions.MatchEvaluator] {
      param($m)
      if ($m.Groups[1].Success) { return [string][char][Convert]::ToInt32($m.Groups[1].Value, 16) }
      $c = $m.Groups[2].Value
      if ($c -ceq 'b') { return [string][char]8 }
      if ($c -ceq 'f') { return [string][char]12 }
      if ($c -ceq 'n') { return [string][char]10 }
      if ($c -ceq 'r') { return [string][char]13 }
      if ($c -ceq 't') { return [string][char]9 }
      $c
    })
}

# Parses JSON text strictly (as JSON.parse does); throws when it is not JSON. Answers @{ value = ... }.
function ConvertFrom-JsonText([string]$text) {
  $pos = 0
  $stack = New-Object System.Collections.Generic.List[object]
  $keys = New-Object System.Collections.Generic.List[object]
  # value | first-key | key | colon | first-value | next | end
  $expect = 'value'
  $root = $null
  while ($pos -lt $text.Length) {
    $m = $JsonToken.Match($text, $pos)
    if (-not $m.Success -or $m.Length -eq 0) { throw 'not JSON' }
    $pos += $m.Length
    if ($m.Groups['w'].Success) { continue }
    $token = $m.Value
    $open = $null
    if ($m.Groups['p'].Success) {
      if ($token -ceq '{') { $open = New-Object System.Collections.Specialized.OrderedDictionary }
      elseif ($token -ceq '[') { $open = New-Object System.Collections.Generic.List[object] }
      elseif ($token -ceq '}' -or $token -ceq ']') {
        if ($stack.Count -eq 0) { throw 'not JSON' }
        $isObject = $stack[$stack.Count - 1] -is [Collections.IDictionary]
        if ($isObject -ne ($token -ceq '}')) { throw 'not JSON' }
        if ($expect -cne 'next' -and $expect -cne $(if ($isObject) { 'first-key' } else { 'first-value' })) { throw 'not JSON' }
        $stack.RemoveAt($stack.Count - 1)
        $keys.RemoveAt($keys.Count - 1)
        if ($stack.Count) { $expect = 'next' } else { $expect = 'end' }
        continue
      } elseif ($token -ceq ',') {
        if ($expect -cne 'next') { throw 'not JSON' }
        if ($stack[$stack.Count - 1] -is [Collections.IDictionary]) { $expect = 'key' } else { $expect = 'value' }
        continue
      } else {
        if ($expect -cne 'colon') { throw 'not JSON' }
        $expect = 'value'
        continue
      }
      $value = $open
    } elseif ($m.Groups['s'].Success) {
      $value = ConvertFrom-JsonString $token
      if ($expect -ceq 'first-key' -or $expect -ceq 'key') {
        $keys[$keys.Count - 1] = $value
        $expect = 'colon'
        continue
      }
    } elseif ($m.Groups['n'].Success) { $value = [JsonNumber]::new($token) }
    elseif ($token -ceq 'true') { $value = $true }
    elseif ($token -ceq 'false') { $value = $false }
    else { $value = $null }
    if ($expect -cne 'value' -and $expect -cne 'first-value') { throw 'not JSON' }
    if ($stack.Count -eq 0) { $root = $value }
    else {
      $top = $stack[$stack.Count - 1]
      if ($top -is [Collections.IDictionary]) { $top[[string]$keys[$keys.Count - 1]] = $value } else { $top.Add($value) }
    }
    if ($null -ne $open) {
      $stack.Add($open)
      $keys.Add($null)
      if ($open -is [Collections.IDictionary]) { $expect = 'first-key' } else { $expect = 'first-value' }
    } elseif ($stack.Count) { $expect = 'next' } else { $expect = 'end' }
  }
  if ($expect -cne 'end') { throw 'not JSON' }
  @{ value = $root }
}

function Format-JsonString([string]$s) {
  if (-not $JsonEscape.IsMatch($s)) { return '"' + $s + '"' }
  '"' + $JsonEscape.Replace($s, [Text.RegularExpressions.MatchEvaluator] {
      param($m)
      $c = [int]$m.Value[0]
      if ($c -eq 34) { return '\"' }
      if ($c -eq 92) { return '\\' }
      if ($c -eq 8) { return '\b' }
      if ($c -eq 9) { return '\t' }
      if ($c -eq 10) { return '\n' }
      if ($c -eq 12) { return '\f' }
      if ($c -eq 13) { return '\r' }
      '\u' + $c.ToString('x4')
    }) + '"'
}

function Add-Json([Text.StringBuilder]$sb, $v) {
  if ($null -eq $v) { [void]$sb.Append('null') }
  elseif ($v -is [string]) { [void]$sb.Append((Format-JsonString $v)) }
  elseif ($v -is [bool]) { [void]$sb.Append($(if ($v) { 'true' } else { 'false' })) }
  elseif ($v -is [JsonNumber]) { [void]$sb.Append($v.Raw) }
  elseif ($v -is [int] -or $v -is [long]) { [void]$sb.Append(([long]$v).ToString($Invariant)) }
  elseif ($v -is [double]) { [void]$sb.Append($v.ToString('R', $Invariant)) }
  elseif ($v -is [Collections.IDictionary]) {
    [void]$sb.Append('{')
    $first = $true
    foreach ($k in $v.get_Keys()) {
      if (-not $first) { [void]$sb.Append(',') }
      $first = $false
      [void]$sb.Append((Format-JsonString ([string]$k))).Append(':')
      Add-Json $sb $v[$k]
    }
    [void]$sb.Append('}')
  } elseif ($v -is [Collections.IEnumerable]) {
    [void]$sb.Append('[')
    $first = $true
    foreach ($item in $v) {
      if (-not $first) { [void]$sb.Append(',') }
      $first = $false
      Add-Json $sb $item
    }
    [void]$sb.Append(']')
  } else { [void]$sb.Append((Format-JsonString ([string]$v))) }
}

function ConvertTo-JsonText($value) {
  $sb = New-Object System.Text.StringBuilder
  Add-Json $sb $value
  $sb.ToString()
}

function New-Object-Ordered { New-Object System.Collections.Specialized.OrderedDictionary }

# A string field of a parsed object, or '' (like str() in mikud.mjs).
function Get-Str($obj, [string]$key) {
  if ($obj -is [Collections.IDictionary] -and $obj.Contains($key) -and $obj[$key] -is [string]) { return $obj[$key] }
  ''
}

# JavaScript's Number(value): NaN when it is not a number.
function ConvertTo-Number($value) {
  if ($null -eq $value) { return [double]0 }
  if ($value -is [JsonNumber]) { return [double]::Parse($value.Raw, $Invariant) }
  if ($value -is [bool]) { if ($value) { return [double]1 }; return [double]0 }
  if ($value -is [int] -or $value -is [long] -or $value -is [double]) { return [double]$value }
  if ($value -is [string]) {
    $t = $value.Trim()
    if ($t -eq '') { return [double]0 }
    $d = [double]0
    if ($t -cmatch '^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\z' -and [double]::TryParse($t, [Globalization.NumberStyles]::Float, $Invariant, [ref]$d)) { return $d }
    return [double]::NaN
  }
  [double]::NaN
}
# Number(value) || 0
function Get-NumberOrZero($value) {
  $d = ConvertTo-Number $value
  if ([double]::IsNaN($d)) { return [double]0 }
  $d
}
function Get-Num($obj, [string]$key) {
  if ($obj -is [Collections.IDictionary] -and $obj.Contains($key)) { return Get-NumberOrZero $obj[$key] }
  [double]0
}

# Date.parse: the time in milliseconds, or $null when it is not a date.
function Get-DateMs([string]$text) {
  if (-not $text) { return $null }
  $d = [DateTimeOffset]::MinValue
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal
  if (-not [DateTimeOffset]::TryParse($text, $Invariant, $styles, [ref]$d)) { return $null }
  $d.ToUnixTimeMilliseconds()
}

function Write-Raw([byte[]]$bytes) {
  $out = [Console]::OpenStandardOutput()
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
}
function Write-Line([string]$text) { Write-Raw $Utf8.GetBytes("$text`n") }
function Write-Answer($value) { Write-Line (ConvertTo-JsonText $value) }

$Help = @"
mikud: keep the owner's Mikud board current, after the owner approves this computer user once.

  connect [--url <address>] [--days <1-365>] [--replace]
                          Ask to connect; prints a link and a code to show the owner.
  connect --wait --url <address>
                          Wait up to $WaitSeconds s for the approval; run again while it answers still_waiting.
  status [--clear-left]   Whether this computer user is connected, and what the command left on Mikud (no secrets).
  disconnect              Forget the connection on this computer (the key stays on Mikud until it ends).
  get '<path>'            GET /api/v1/<path>, for example: get 'items?q=login'
  post '<path>' --json '<body>' | --json-file <file>
  patch '<path>' --json '<body>' | --json-file <file>
                          --as <label> (or MIKUD_AGENT_LABEL) names the agent in Mikud's activity log.
"@ -replace "`r`n", "`n"

# Arguments

function Read-Options([string[]]$list) {
  $opts = @{
    positional = (New-Object System.Collections.Generic.List[string])
    url = $null; days = $null; json = $null; jsonFile = $null; as = $null
    replace = $false; wait = $false; clearLeft = $false
  }
  $i = 0
  while ($i -lt $list.Count) {
    $a = $list[$i]
    $i++
    $valued = @{ '--url' = 'url'; '--days' = 'days'; '--json' = 'json'; '--json-file' = 'jsonFile'; '--as' = 'as' }
    $name = $null
    foreach ($k in $valued.Keys) { if ($a -ceq $k) { $name = $valued[$k] } }
    if ($name) {
      if ($i -ge $list.Count) { Fail 'bad_option' "$a needs a value." }
      $opts[$name] = $list[$i]
      $i++
    } elseif ($a -ceq '--replace') { $opts.replace = $true }
    elseif ($a -ceq '--wait') { $opts.wait = $true }
    elseif ($a -ceq '--clear-left') { $opts.clearLeft = $true }
    elseif ($a.StartsWith('--', [StringComparison]::Ordinal)) { Fail 'bad_option' "Unknown option $a. Run: mikud help" }
    else { $opts.positional.Add($a) }
  }
  $opts
}

function Get-Days($raw) {
  if ($null -eq $raw) { return $DaysDefault }
  $days = 0
  if ([string]$raw -cmatch '^[0-9]{1,3}\z') { $days = [int]$raw }
  if ($days -lt $DaysMin -or $days -gt $DaysMax) { Fail 'bad_option' "--days takes $DaysMin to $DaysMax." }
  $days
}

# The canonical origin of an address: https, or http on this computer only; no path, query or credentials.
function Get-Origin([string]$raw) {
  $u = $null
  if (-not [Uri]::TryCreate($raw, [UriKind]::Absolute, [ref]$u)) {
    Fail 'no_url' "That is not an address. Ask the owner for Mikud's address, for example https://mikud.example.com."
  }
  $loopback = $u.Host -ceq 'localhost' -or $u.Host -ceq '127.0.0.1'
  if (-not ($u.Scheme -ceq 'https' -or ($u.Scheme -ceq 'http' -and $loopback))) {
    Fail 'no_url' "Mikud's address must start with https:// (http only for localhost or 127.0.0.1)."
  }
  if ($u.UserInfo -or $u.Query -or $u.Fragment -or ($u.AbsolutePath -cne '/' -and $u.AbsolutePath -cne '')) {
    Fail 'no_url' "Give Mikud's address alone, for example https://mikud.example.com."
  }
  "$($u.Scheme)://$($u.Authority)"
}

# Where the connection is kept: one folder per computer user, shared by every agent install of that user.

function Get-Ctx {
  if ($IsWin -and $env:USERPROFILE) { $base = $env:USERPROFILE } else { $base = [Environment]::GetFolderPath('UserProfile') }
  if ($env:MIKUD_SKILL_HOME) { $dir = $env:MIKUD_SKILL_HOME } else { $dir = Join-Path $base '.mikud' }
  $dir = [IO.Path]::GetFullPath($dir)
  $rootOf = [IO.Path]::GetPathRoot($dir)
  while ($dir.Length -gt $rootOf.Length -and ($dir.EndsWith('\') -or $dir.EndsWith('/'))) { $dir = $dir.Substring(0, $dir.Length - 1) }
  @{
    dir = $dir
    connection = [IO.Path]::Combine($dir, 'connection')
    pending = [IO.Path]::Combine($dir, 'pending')
    left = [IO.Path]::Combine($dir, 'left')
    lock = [IO.Path]::Combine($dir, 'lock')
  }
}

function Fail-Insecure([string]$text) { Fail 'insecure_credentials' $text }

$script:HomeChecked = $false
$script:UserSid = ''
$script:Uid = $null
$script:AclChecked = New-Object 'System.Collections.Generic.HashSet[string]'

# POSIX: the owner's user id and the permission bits, as lstat reports them.
function Get-CurrentUid {
  if ($null -eq $script:Uid) {
    $out = ''
    try { $out = [string](& id -u 2>$null | Select-Object -First 1) } catch {}
    if ($out.Trim() -cnotmatch '^[0-9]+\z') { Fail-Insecure 'Could not tell the current user (id -u failed).' }
    $script:Uid = [long]$out.Trim()
  }
  $script:Uid
}
function Get-UnixOwner([string]$target) {
  $item = Get-Item -LiteralPath $target -Force
  $stat = $item.PSObject.Properties['UnixStat']
  if ($stat -and $null -ne $stat.Value) { return [long]$stat.Value.UserId }
  $out = ''
  try { $out = [string](& stat -c '%u' -- $target 2>$null | Select-Object -First 1) } catch {}
  if ($out.Trim() -cnotmatch '^[0-9]+\z') { try { $out = [string](& stat -f '%u' $target 2>$null | Select-Object -First 1) } catch {} }
  if ($out.Trim() -cnotmatch '^[0-9]+\z') { Fail-Insecure "Could not tell who owns $target." }
  [long]$out.Trim()
}
function Get-UnixMode([string]$target) { [int][IO.File]::GetUnixFileMode($target) -band 511 }

# Attributes of a path itself, without following a link; $null when it does not exist.
function Get-LinkAttributes([string]$target) {
  try { return [IO.File]::GetAttributes($target) }
  catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { return $null }
}

# Checks the folder (and creates it when asked): a plain folder of this user that only this user can open.
function Protect-Home($ctx, [bool]$create) {
  try { $attr = Get-LinkAttributes $ctx.dir } catch { Fail 'cannot_save' "Cannot read $($ctx.dir). Allow this agent to use it." }
  if ($null -eq $attr) {
    if (-not $create) { return $false }
    try {
      if ($IsWin) {
        [void][IO.Directory]::CreateDirectory($ctx.dir)
        Set-WindowsPrivate $ctx.dir $true
      } else {
        [void][IO.Directory]::CreateDirectory($ctx.dir, [IO.UnixFileMode]'UserRead, UserWrite, UserExecute')
      }
    } catch {
      if ($_.Exception -is [MikudFail]) { throw }
      Fail 'cannot_save' "Cannot create $($ctx.dir). Allow this agent to write there."
    }
    $attr = Get-LinkAttributes $ctx.dir
  }
  if ($null -eq $attr -or ($attr -band [IO.FileAttributes]::ReparsePoint) -or -not ($attr -band [IO.FileAttributes]::Directory)) {
    Fail-Insecure "$($ctx.dir) must be a plain folder, not a link."
  }
  if ($IsWin) {
    if (-not $script:HomeChecked) {
      $present = @(@($ctx.connection, $ctx.pending, $ctx.left) | Where-Object { Test-Exists $_ })
      foreach ($f in $present) { [void](Test-PlainFile $f) }
      Test-WindowsAcl $ctx (@($ctx.dir) + $present)
    }
  } else {
    if ((Get-UnixOwner $ctx.dir) -ne (Get-CurrentUid)) {
      Fail-Insecure "$($ctx.dir) belongs to another user. Remove it, or set MIKUD_SKILL_HOME to a folder of your own."
    }
    if ((Get-UnixMode $ctx.dir) -ne 448) { Fail-Insecure "Others can open $($ctx.dir). Run: chmod 700 '$($ctx.dir)'" }
  }
  $script:HomeChecked = $true
  $true
}

# A plain file (not a link, not a folder); $false when it does not exist.
function Test-PlainFile([string]$file) {
  $attr = Get-LinkAttributes $file
  if ($null -eq $attr) { return $false }
  if (($attr -band [IO.FileAttributes]::ReparsePoint) -or ($attr -band [IO.FileAttributes]::Directory)) {
    Fail-Insecure "$file must be a plain file, not a link."
  }
  $true
}

# Checks one file before it is read; $false when it does not exist.
function Test-PrivateFile($ctx, [string]$file) {
  if (-not (Test-PlainFile $file)) { return $false }
  if ($IsWin) { Test-WindowsAcl $ctx @($file) }
  else {
    if ((Get-UnixOwner $file) -ne (Get-CurrentUid)) { Fail-Insecure "$file belongs to another user. Remove it and connect again." }
    if ((Get-UnixMode $file) -ne 384) { Fail-Insecure "Others can read $file. Run: chmod 600 '$file'" }
  }
  $true
}

# Reads a file the other commands may replace or delete meanwhile (shared like Node's reads), as UTF-8.
function Read-SharedText([string]$file) {
  $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
  $fs = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
  try {
    $ms = New-Object IO.MemoryStream
    $fs.CopyTo($ms)
    $Utf8.GetString($ms.ToArray())
  } finally { $fs.Dispose() }
}

function Read-Private($ctx, [string]$file) {
  if (-not (Protect-Home $ctx $false)) { return $null }
  if (-not (Test-PrivateFile $ctx $file)) { return $null }
  try { return Read-SharedText $file }
  catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] { return $null }
  catch { Fail 'cannot_save' "Cannot read $file. Allow this agent to use $($ctx.dir)." }
}

# Windows: access lists instead of mode bits. One entry, for the current user; inheritance removed.

function Get-UserSid {
  if (-not $script:UserSid) {
    try { $script:UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch {}
    if (-not $script:UserSid) { Fail-Insecure 'Could not tell the current Windows user (whoami failed).' }
  }
  $script:UserSid
}

# icacls: inheritance removed and full control for the current user only.
function Set-WindowsPrivate([string]$target, [bool]$folder) {
  $sid = Get-UserSid
  $grant = "*${sid}:F"
  if ($folder) { $grant = "*${sid}:(OI)(CI)F" }
  $code = 1
  try {
    $ErrorActionPreference = 'Continue'
    & $Icacls $target /inheritance:r /grant:r $grant /Q *> $null
    $code = $LASTEXITCODE
  } catch { $code = 1 } finally { $ErrorActionPreference = 'Stop' }
  if ($code -ne 0) { Fail-Insecure "Could not limit $target to your user (icacls failed)." }
}

# The owner and access list of a folder or file in SDDL.
function Get-Sddl([string]$target, [bool]$folder) {
  $sections = [Security.AccessControl.AccessControlSections]'Owner, Access'
  if ($folder) { $sec = New-Object Security.AccessControl.DirectorySecurity($target, $sections) }
  else { $sec = New-Object Security.AccessControl.FileSecurity($target, $sections) }
  $sec.GetSecurityDescriptorSddlForm($sections)
}

# What in an SDDL string lets anyone but this user in, or $null. Owner: this user (the built-in Administrator shows
# as LA). Access list: protected (no inheritance) and exactly one allow entry with full control for this user, with
# (OI)(CI) on the folder and no flags on a file.
function Get-AclProblem([string]$sddl, [string]$sid, [bool]$folder, [bool]$checkOwner) {
  $admin = $sid -cmatch '^S-1-5-21-[0-9-]+-500\z'
  if ($checkOwner) {
    $owner = ''
    $m = [regex]::Match($sddl, '^O:(.*?)(?=G:|D:|S:|\z)')
    if ($m.Success) { $owner = $m.Groups[1].Value }
    if (-not ($owner -ceq $sid -or ($owner -ceq 'LA' -and $admin))) {
      if ($owner) { return "its owner is $owner" }
      return 'its owner is unknown'
    }
  }
  $at = $sddl.IndexOf('D:')
  if ($at -lt 0) { return 'its access list cannot be read' }
  $dacl = [regex]::Match($sddl.Substring($at), 'D:([A-Z]*)((?:\([^()]*\))*)(?=S:|\z)')
  if (-not $dacl.Success) { return 'its access list cannot be read' }
  if (-not $dacl.Groups[1].Value.Contains('P')) { return 'it inherits access from its parent folder' }
  $list = $dacl.Groups[2].Value
  $aces = @()
  if ($list.Length -ge 2) { $aces = @($list.Substring(1, $list.Length - 2).Split(@(')('), [StringSplitOptions]::None) | Where-Object { $_ }) }
  if ($aces.Count -ne 1) { return "it has $($aces.Count) access entries" }
  $f = $aces[0].Split(';')
  $part = { param($i) if ($f.Count -gt $i) { $f[$i] } else { $null } }
  $type = & $part 0
  $flags = & $part 1
  $rights = & $part 2
  $who = & $part 5
  if ($type -cne 'A' -or -not ($who -ceq $sid -or ($who -ceq 'LA' -and $admin))) {
    if ($who) { return "$who has access" }
    return 'someone has access'
  }
  if (-not ($rights -ceq 'FA' -or $rights -ceq '0x1f01ff')) { return 'your user lacks full control' }
  $want = ''
  if ($folder) { $want = 'OICI' }
  if ($flags -cne $want) { return 'its access entry has unexpected flags' }
  $null
}

# Reads back the owner and access list of folders and files (once per process), and refuses any other.
function Test-WindowsAcl($ctx, [string[]]$targets) {
  $todo = @($targets | Where-Object { -not $script:AclChecked.Contains($_.ToLowerInvariant()) })
  if (-not $todo.Count) { return }
  $sddls = @()
  try {
    $script:UserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($t in $todo) { $sddls += , (Get-Sddl $t ($t -ceq $ctx.dir)) }
  } catch { Fail-Insecure "Could not read who may open $($ctx.dir) (Get-Acl failed)." }
  for ($i = 0; $i -lt $todo.Count; $i++) {
    $target = $todo[$i]
    $folder = $target -ceq $ctx.dir
    $problem = Get-AclProblem $sddls[$i] $script:UserSid $folder $true
    if ($problem) {
      $grant = 'F'
      if ($folder) { $grant = '(OI)(CI)F' }
      Fail-Insecure "Others may open $target ($problem). Run: icacls `"$target`" /inheritance:r /grant:r `"%USERNAME%:$grant`""
    }
    [void]$script:AclChecked.Add($target.ToLowerInvariant())
  }
}

# A temporary file's access list, read back after icacls.
function Test-ReadBack($ctx, [string]$file) {
  try { $sddl = Get-Sddl $file $false } catch { Fail-Insecure "Could not read back who may open $file (icacls failed)." }
  $problem = Get-AclProblem $sddl (Get-UserSid) $false $false
  if ($problem) { Fail-Insecure "Could not make $file private ($problem)." }
}

# Files: one line of JSON each (left: one per entry), written in one step through a private temporary file.

function Format-Count($value) {
  $d = Get-NumberOrZero $value
  if ($d -lt 0) { $d = 0 }
  [Math]::Floor($d).ToString('0', $Invariant)
}

function Format-Line($fields, $rec) {
  $parts = foreach ($f in $fields) {
    $k = $f[0]
    if ($f[1] -ceq 'n') { '"' + $k + '":' + (Format-Count $rec[$k]) }
    else {
      $value = ''
      if ($null -ne $rec[$k]) { $value = [string]$rec[$k] }
      if ($value -cnotmatch $Plain) { Fail 'unexpected_answer' "Mikud sent a value that cannot be stored ($k)." }
      '"' + $k + '":"' + $value + '"'
    }
  }
  '{' + ($parts -join ',') + '}'
}

function Read-Line($fields, [string]$line, [string]$file) {
  $parsed = $null
  $ok = $false
  try { $parsed = (ConvertFrom-JsonText $line).value; $ok = $true } catch {}
  if (-not $ok -or -not ($parsed -is [Collections.IDictionary] -or $parsed -is [Collections.IList])) {
    Fail-Insecure "$file is damaged. Delete it and connect again."
  }
  $rec = @{}
  foreach ($f in $fields) {
    $k = $f[0]
    if ($f[1] -ceq 'n') { $rec[$k] = Get-Num $parsed $k } else { $rec[$k] = Get-Str $parsed $k }
  }
  $rec
}

function Invoke-Hook([string]$point) {
  $at = [Environment]::GetEnvironmentVariable('MIKUD_TEST_HOLD_' + $point.ToUpperInvariant().Replace('-', '_'))
  if (-not $at) { return }
  [IO.File]::WriteAllText("$at.reached", [string]$PID)
  for ($i = 0; $i -lt 1200 -and -not [IO.File]::Exists("$at.go"); $i++) { Start-Sleep -Milliseconds 50 }
}

function Move-Over([string]$from, [string]$to) {
  # On Windows an open handle (an antivirus scan) can refuse the replace for a moment.
  $until = [DateTime]::UtcNow.AddSeconds(5)
  while ($true) {
    try {
      if ($Core) { [IO.File]::Move($from, $to, $true) }
      elseif ([IO.File]::Exists($to)) { [IO.File]::Replace($from, $to, [NullString]::Value) }
      else { [IO.File]::Move($from, $to) }
      return
    } catch {
      if (-not $IsWin -or [DateTime]::UtcNow -gt $until) {
        Remove-Path $from
        Fail 'cannot_save' "Cannot replace $to. Allow this agent to write in its folder."
      }
      Start-Sleep -Milliseconds 100
    }
  }
}

# Writes a file in one step: a temporary file made private before anything is written, then renamed over.
function Write-Private($ctx, [string]$file, [string]$text) {
  [void](Protect-Home $ctx $true)
  $tmp = "$file.$(Hex 6).tmp"
  $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
  try {
    $fs = $null
    try {
      if ($IsWin) {
        [IO.File]::Open($tmp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, $share).Dispose()
        Set-WindowsPrivate $tmp $false
        Test-ReadBack $ctx $tmp
        $fs = [IO.File]::Open($tmp, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, $share)
      } else {
        $o = New-Object IO.FileStreamOptions
        $o.Mode = [IO.FileMode]::CreateNew
        $o.Access = [IO.FileAccess]::Write
        $o.Share = $share
        $o.UnixCreateMode = [IO.UnixFileMode]'UserRead, UserWrite'
        $fs = New-Object IO.FileStream($tmp, $o)
        if ((Get-UnixOwner $tmp) -ne (Get-CurrentUid) -or (Get-UnixMode $tmp) -ne 384) {
          Fail-Insecure "Could not make $tmp private before writing it."
        }
      }
      Invoke-Hook 'temp'
      $bytes = $Utf8.GetBytes($text)
      $fs.Write($bytes, 0, $bytes.Length)
      $fs.Flush($true)
    } finally { if ($fs) { $fs.Dispose() } }
  } catch {
    Remove-Path $tmp
    if ($_.Exception -is [MikudFail]) { throw }
    Fail 'cannot_save' "Cannot write in $($ctx.dir). Allow this agent to write there."
  }
  Move-Over $tmp $file
  if ($IsWin) { [void]$script:AclChecked.Add($file.ToLowerInvariant()) }
}

function Remove-PrivateFile($ctx, [string]$file) {
  try {
    $attr = Get-LinkAttributes $file
    if ($null -eq $attr) { return }
    if (($attr -band [IO.FileAttributes]::Directory) -and -not ($attr -band [IO.FileAttributes]::ReparsePoint)) { throw 'a folder' }
    if ($attr -band [IO.FileAttributes]::Directory) { [IO.Directory]::Delete($file) } else { [IO.File]::Delete($file) }
  } catch { Fail 'cannot_save' "Cannot remove $file. Allow this agent to write in $($ctx.dir)." }
}

function Read-Connection($ctx) {
  $text = Read-Private $ctx $ctx.connection
  if ($null -eq $text) { return $null }
  $rec = Read-Line $ConnectionFields $text.Trim() $ctx.connection
  if (-not $rec.origin -or -not $rec.key -or -not $rec.keyName) { Fail-Insecure "$($ctx.connection) is damaged. Delete it and connect again." }
  $rec
}

function Read-Pending($ctx) {
  $text = Read-Private $ctx $ctx.pending
  if ($null -eq $text) { return $null }
  $rec = Read-Line $PendingFields $text.Trim() $ctx.pending
  if (-not $rec.attemptId -or -not $rec.origin -or -not $rec.deviceCode -or -not ($rec.phase -ceq 'polling' -or $rec.phase -ceq 'creating_key')) {
    Fail-Insecure "$($ctx.pending) is damaged. Delete it and connect again."
  }
  $rec
}

function Write-Connection($ctx, $rec) { Write-Private $ctx $ctx.connection ((Format-Line $ConnectionFields $rec) + "`n") }

# Writes the attempt only while it is still the one this run started from.
function Write-PendingIf($ctx, $rec, $attemptId) {
  $current = Read-Pending $ctx
  if ($null -ne $attemptId) {
    $currentId = $null
    if ($current) { $currentId = $current.attemptId }
    if ($currentId -cne $attemptId) { throw [MikudChanged]::new() }
  }
  Write-Private $ctx $ctx.pending ((Format-Line $PendingFields $rec) + "`n")
}

function Copy-Rec($rec, [hashtable]$changes) {
  $next = @{}
  foreach ($k in $rec.Keys) { $next[$k] = $rec[$k] }
  if ($changes) { foreach ($k in $changes.Keys) { $next[$k] = $changes[$k] } }
  $next
}

# The left record: what the command left on Mikud, with non-secret fields only.

function Read-Left($ctx) {
  $text = Read-Private $ctx $ctx.left
  if ($null -eq $text) { return , @() }
  $entries = @()
  foreach ($line in ($text -split "\r?\n")) {
    if (-not $line.Trim()) { continue }
    $e = Read-Line $LeftFields $line $ctx.left
    if ($Reasons -ccontains $e.reason) { $entries += , $e }
  }
  , $entries
}

# Entries still worth reporting: a dated entry drops by itself once its key has ended.
function Select-Current($entries) {
  $nowMs = (Now) * 1000
  $kept = @()
  foreach ($e in $entries) {
    if (-not ($Dated -ccontains $e.reason) -or -not $e.expiresAt) { $kept += , $e; continue }
    $ms = Get-DateMs $e.expiresAt
    if ($null -ne $ms -and $ms -gt $nowMs) { $kept += , $e }
  }
  , $kept
}

function Write-Left($ctx, $entries) {
  $entries = @($entries | Where-Object { $null -ne $_ })
  if (-not $entries.Count) { return Remove-PrivateFile $ctx $ctx.left }
  $text = -join @($entries | ForEach-Object { (Format-Line $LeftFields $_) + "`n" })
  Write-Private $ctx $ctx.left $text
}

# Adds entries (under the lock), before the change that would lose what they record.
function Add-Left($ctx, $additions) {
  $entries = New-Object System.Collections.Generic.List[object]
  foreach ($e in (Select-Current (Read-Left $ctx))) { $entries.Add($e) }
  foreach ($add in $additions) {
    $entry = @{ at = (Iso (Now)); expiresAt = '' }
    foreach ($k in $add.Keys) { $entry[$k] = $add[$k] }
    $same = { param($x) $x.origin -ceq $entry.origin -and $x.keyName -ceq $entry.keyName }
    $skip = $false
    foreach ($x in $entries) { if ((& $same $x) -and $x.reason -ceq $entry.reason) { $skip = $true } }
    # A key whose name and end date are known says more than "a key may exist".
    if ($entry.reason -ceq 'key_unknown') { foreach ($x in $entries) { if ((& $same $x) -and $Dated -ccontains $x.reason) { $skip = $true } } }
    if ($skip) { continue }
    if ($Dated -ccontains $entry.reason) {
      for ($i = $entries.Count - 1; $i -ge 0; $i--) {
        if ((& $same $entries[$i]) -and $entries[$i].reason -ceq 'key_unknown') { $entries.RemoveAt($i) }
      }
    }
    $entries.Add($entry)
  }
  Write-Left $ctx $entries.ToArray()
}

function Get-LeftMessage($e) {
  if ($e.reason -ceq 'session_unknown') { return "On $($e.origin): $SessionText" }
  if ($e.reason -ceq 'key_unknown') { return "On $($e.origin): a key named `"$($e.keyName)`" may exist; delete it in Settings, Agent access." }
  $why = @{ replaced = 'was replaced'; disconnected = 'was disconnected'; not_saved = 'could not be saved' }[$e.reason]
  $until = $e.expiresAt
  if (-not $until) { $until = 'it ends' }
  "On $($e.origin): the key `"$($e.keyName)`" $why but still works until $until; delete it in Settings, Agent access, if nothing uses it."
}

function Get-PublicLeft($entries) {
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($e in (Select-Current $entries)) {
    $o = New-Object-Ordered
    foreach ($f in $LeftFields) { $o[$f[0]] = $e[$f[0]] }
    $o['message'] = Get-LeftMessage $e
    $out.Add($o)
  }
  , $out
}

function Get-LeftNow($ctx) {
  try { return , (Get-PublicLeft (Read-Left $ctx)) } catch { return , (New-Object System.Collections.Generic.List[object]) }
}

# The lock: a folder created atomically (renamed into place with its owner file), released by its token only.

# The start time of a process as the system reports it, the same in every version; '' when it cannot be read.
function Get-StartTime([long]$id) {
  try {
    if ($OnLinux) {
      $stat = [IO.File]::ReadAllText("/proc/$id/stat")
      # Field 22; the fields after the command name, which may hold spaces, start with field 3.
      $fields = $stat.Substring($stat.LastIndexOf(')') + 2).Split(' ')
      if ($fields.Count -gt 19) { return $fields[19] }
      return ''
    }
    if ($IsWin) { return (Get-Process -Id $id -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') }
    $ErrorActionPreference = 'Continue'
    $out = @(& ps -o lstart= -p $id 2>$null)
    if ($LASTEXITCODE -ne 0) { return '' }
    return ($out -join "`n").Trim()
  } catch { return '' }
}

function Test-Running([long]$id) {
  if ($IsWin) { return [bool](Get-Process -Id $id -ErrorAction SilentlyContinue) }
  try { return -not [Diagnostics.Process]::GetProcessById([int]$id).HasExited } catch { return $false }
}

function Read-Owner([string]$lock) {
  try { $attr = Get-LinkAttributes $lock } catch { return @{ unreadable = $true } }
  if ($null -eq $attr) { return $null }
  if (($attr -band [IO.FileAttributes]::ReparsePoint) -or -not ($attr -band [IO.FileAttributes]::Directory)) {
    Fail-Insecure "$lock must be a plain folder, not a link."
  }
  try {
    $held = (ConvertFrom-JsonText (Read-SharedText ([IO.Path]::Combine($lock, 'owner')))).value
    if ($held -is [Collections.IDictionary] -and (Get-Str $held 'token')) { return $held }
  } catch {
    if (-not (Test-Exists $lock)) { return $null }
  }
  @{ unreadable = $true }
}

function Test-Unreadable($held) { $held -is [hashtable] -and $held.ContainsKey('unreadable') }

# free, alive, gone (certainly: same host, and the process ended or its id now runs another start), or unknown.
function Get-Verdict($held) {
  if ($null -eq $held) { return 'free' }
  if ((Test-Unreadable $held) -or -not $held.Contains('host') -or -not (Test-SameHost (ConvertTo-PlainString $held['host']))) { return 'unknown' }
  $id = ConvertTo-Number $held['pid']
  if ([double]::IsNaN($id) -or $id -le 0 -or $id -ne [Math]::Floor($id) -or $id -gt [int]::MaxValue) { return 'unknown' }
  if (-not (Test-Running ([long]$id))) { return 'gone' }
  $start = $null
  if ($held.Contains('start')) { $start = $held['start'] }
  $startText = ConvertTo-PlainString $start
  if ($null -eq $start -or $startText -ceq '' -or $start -is [bool] -or ($start -is [JsonNumber] -and (ConvertTo-Number $start) -eq 0)) { return 'unknown' }
  $now = Get-StartTime ([long]$id)
  if (-not $now) { return 'unknown' }
  if ($now -ceq $startText) { return 'alive' }
  'gone'
}

# String(value) for a parsed JSON value.
function ConvertTo-PlainString($value) {
  if ($null -eq $value) { return '' }
  if ($value -is [JsonNumber]) { return $value.Raw }
  if ($value -is [bool]) { if ($value) { return 'true' }; return 'false' }
  [string]$value
}

function Enter-Lock($ctx) {
  [void](Protect-Home $ctx $true)
  $token = Hex 16
  $owner = '{"token":' + (Format-JsonString $token) + ',"host":' + (Format-JsonString (Get-HostName)) + ',"pid":' + $PID +
    ',"start":' + (Format-JsonString (Get-StartTime $PID)) + "}`n"
  $deadline = [DateTime]::UtcNow.AddMilliseconds($LockWaitMs)
  while ($true) {
    # Only into an empty place: a rename could otherwise replace an empty folder, an undecidable lock.
    if (-not (Test-Exists $ctx.lock)) {
      $fresh = "$($ctx.lock).$(Hex 6).new"
      try {
        [void][IO.Directory]::CreateDirectory($fresh)
        $fs = [IO.File]::Open([IO.Path]::Combine($fresh, 'owner'), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
        try { $bytes = $Utf8.GetBytes($owner); $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Dispose() }
      } catch {
        Remove-Path $fresh
        Fail 'cannot_save' "Cannot create a lock in $($ctx.dir). Allow this agent to write there."
      }
      $taken = $false
      try {
        [IO.Directory]::Move($fresh, $ctx.lock)
        $taken = $true
      } catch {
        Remove-Path $fresh
        $base = $_.Exception.GetBaseException()
        if (-not ($base -is [IO.IOException] -or $base -is [UnauthorizedAccessException])) {
          Fail 'cannot_save' "Cannot create a lock in $($ctx.dir). Allow this agent to write there."
        }
      }
      if ($taken) {
        Invoke-Hook 'locked'
        return $token
      }
    }
    $held = Read-Owner $ctx.lock
    $state = Get-Verdict $held
    if ($state -ceq 'gone') {
      Invoke-Hook 'break-observed'
      Remove-DeadLock $ctx $held
      continue
    }
    if ([DateTime]::UtcNow -gt $deadline) {
      if ($state -ceq 'unknown') {
        Fail 'busy' "Another mikud command may hold the lock $($ctx.lock), and this command cannot tell whether it still runs. Nothing was sent. If no mikud command runs on this computer, remove that folder by hand and run the command again."
      }
      Fail 'busy' 'Another mikud command is using the connection. Nothing was sent; run it again.'
    }
    if ($state -ceq 'free') { Start-Sleep -Milliseconds 50 } else { Start-Sleep -Milliseconds (100 + (Get-Random -Maximum 200)) }
  }
}

# Removes the lock of a holder that is certainly gone. Moving it away is atomic, so of two that try only one moves
# it; if what was moved is not that lock (another command had just taken a fresh one), it goes back.
function Remove-DeadLock($ctx, $held) {
  $moved = "$($ctx.lock).$(Hex 6).dead"
  try { [IO.Directory]::Move($ctx.lock, $moved) } catch { return }
  Invoke-Hook 'break-moved'
  $got = Read-Owner $moved
  if ($null -ne $got -and -not (Test-Unreadable $got) -and (Get-Str $got 'token') -ceq (Get-Str $held 'token')) {
    Remove-Path $moved
    return
  }
  try { [IO.Directory]::Move($moved, $ctx.lock) } catch { Remove-Path $moved }
}

function Test-Mine($ctx, [string]$token) {
  $held = Read-Owner $ctx.lock
  $null -ne $held -and -not (Test-Unreadable $held) -and (Get-Str $held 'token') -ceq $token
}

function Exit-Lock($ctx, [string]$token) {
  if (-not (Test-Mine $ctx $token)) { return }
  $old = "$($ctx.lock).$(Hex 6).old"
  for ($i = 0; $i -lt 20; $i++) {
    try {
      [IO.Directory]::Move($ctx.lock, $old)
      Remove-Path $old
      return
    } catch {
      if (-not $IsWin) { return }
      Start-Sleep -Milliseconds 50
    }
  }
}

# Before a request that spends a one-time secret: the lock must still be this command's, or nothing is sent.
function Assert-Mine($ctx, [string]$token) {
  if (-not (Test-Mine $ctx $token)) { Fail 'busy' 'Another mikud command took over the connection. Run it again.' }
}

# Requests: plain HTTP/1.1 over one new connection per request, never HttpClient, which may send a request again by
# itself when its connection breaks before the answer; a one-time code or a write may never be sent twice. No
# redirect is followed. Secrets travel only inside this process.

function Find-Bytes([byte[]]$hay, [byte[]]$needle, [int]$from) {
  for ($i = $from; $i -le $hay.Length - $needle.Length; $i++) {
    $ok = $true
    for ($j = 0; $j -lt $needle.Length; $j++) { if ($hay[$i + $j] -ne $needle[$j]) { $ok = $false; break } }
    if ($ok) { return $i }
  }
  -1
}

# The body of a chunked answer, or $null when it is cut short.
function Get-Unchunked([byte[]]$raw) {
  $out = New-Object System.IO.MemoryStream
  $crlf = [byte[]](13, 10)
  $at = 0
  while ($true) {
    $end = Find-Bytes $raw $crlf $at
    if ($end -lt 0) { return $null }
    $sizeText = ([Text.Encoding]::ASCII.GetString($raw, $at, $end - $at) -split ';')[0].Trim()
    $size = 0
    if (-not [int]::TryParse($sizeText, [Globalization.NumberStyles]::HexNumber, $Invariant, [ref]$size)) { return $null }
    if ($size -eq 0) { return , $out.ToArray() }
    $start = $end + 2
    if ($start + $size + 2 -gt $raw.Length) { return $null }
    $out.Write($raw, $start, $size)
    $at = $start + $size + 2
  }
}

# The name of a network failure, as Node reports it.
function Get-NetCode($err) {
  $e = $err
  while ($e) {
    if ($e -is [Net.Sockets.SocketException]) {
      $names = @{
        ConnectionRefused = 'ECONNREFUSED'; HostNotFound = 'ENOTFOUND'; NoData = 'ENOTFOUND'; TryAgain = 'EAI_AGAIN'
        HostUnreachable = 'EHOSTUNREACH'; NetworkUnreachable = 'ENETUNREACH'; TimedOut = 'ETIMEDOUT'; ConnectionReset = 'ECONNRESET'
      }
      $name = [string]$e.SocketErrorCode
      if ($names.ContainsKey($name)) { return $names[$name] }
      return $name
    }
    if ($e -is [Security.Authentication.AuthenticationException]) { return 'TLS' }
    if ($e -is [TimeoutException]) { return 'TimeoutError' }
    $e = $e.InnerException
  }
  'network error'
}

# One request to the stored origin only, never following a redirect. -Connect names the request mikud-connect.
# $body is JSON text or $null. Answers @{ status; text; json }.
function Invoke-Request([string]$origin, [string]$method, [string]$target, $body, [string]$bearer, [bool]$connect, [string]$label) {
  # A header value with a control character would change the request: refused before anything is sent.
  if ("$bearer$label" -cmatch '[\x00-\x1f\x7f]' -or $target -cmatch '[\x00-\x20\x7f]') {
    throw (New-Fail 'unreachable' "Cannot reach $origin (invalid header value)." @{ sent = $false })
  }
  $u = [Uri]$origin
  $bodyBytes = $null
  $head = "$method $target HTTP/1.1`r`nHost: $($u.Authority)`r`nAccept: application/json`r`n"
  if ($null -ne $body) { $bodyBytes = $Utf8.GetBytes([string]$body); $head += "Content-Type: application/json`r`n" }
  if ($bearer) { $head += "Authorization: Bearer $bearer`r`n" }
  if ($connect) { $head += "User-Agent: $ClientId`r`n" } else { $head += "User-Agent: mikud`r`n" }
  if ($label) { $head += "X-Mikud-Agent: $label`r`n" }
  if ($null -ne $bodyBytes) { $head += "Content-Length: $($bodyBytes.Length)`r`n" }
  elseif ($method -cne 'GET') { $head += "Content-Length: 0`r`n" }
  $head += "Connection: close`r`n`r`n"
  $tcp = New-Object System.Net.Sockets.TcpClient
  $stream = $null
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $raw = New-Object System.IO.MemoryStream
  try {
    try {
      $connecting = $tcp.ConnectAsync($u.DnsSafeHost, $u.Port)
      if (-not $connecting.Wait([int][Math]::Max(1, $TimeoutMs))) { throw [TimeoutException]::new('connect') }
      $stream = $tcp.GetStream()
      if ($u.Scheme -ceq 'https') {
        $left = [int]($TimeoutMs - $clock.ElapsedMilliseconds)
        if ($left -le 0) { throw [TimeoutException]::new('tls') }
        $tcp.ReceiveTimeout = $left
        $tcp.SendTimeout = $left
        $ssl = New-Object System.Net.Security.SslStream($stream, $false)
        # The system's TLS versions; Windows PowerShell 5.1 may offer only old ones unless TLS 1.2 is named.
        $protocols = [Security.Authentication.SslProtocols]::None
        if (-not $Core) { $protocols = [Security.Authentication.SslProtocols]::Tls12 }
        $handshake = $ssl.AuthenticateAsClientAsync($u.DnsSafeHost, $null, $protocols, $true)
        if (-not $handshake.Wait($left)) { $tcp.Close(); throw [TimeoutException]::new('tls') }
        $stream = $ssl
      }
    } catch {
      # The name, the connection or TLS failed first: nothing reached Mikud.
      throw (New-Fail 'unreachable' "Cannot reach $origin ($(Get-NetCode $_.Exception))." @{ sent = $false })
    }
    try {
      $headBytes = [Text.Encoding]::ASCII.GetBytes($head)
      $stream.WriteTimeout = [int][Math]::Max(1, $TimeoutMs - $clock.ElapsedMilliseconds)
      $stream.Write($headBytes, 0, $headBytes.Length)
      if ($null -ne $bodyBytes) { $stream.Write($bodyBytes, 0, $bodyBytes.Length) }
      $stream.Flush()
      $buf = New-Object byte[] 65536
      while ($true) {
        $left = [int]($TimeoutMs - $clock.ElapsedMilliseconds)
        if ($left -le 0) { throw [TimeoutException]::new('answer') }
        $stream.ReadTimeout = $left
        $n = $stream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $raw.Write($buf, 0, $n)
      }
    } catch {
      $code = Get-NetCode $_.Exception
      if ($code -ceq 'network error' -and $_.Exception.GetBaseException() -is [IO.IOException]) { $code = 'UND_ERR_SOCKET' }
      if ($code -ceq 'ETIMEDOUT') { $code = 'TimeoutError' }
      throw (New-Fail 'unreachable' "Cannot reach $origin ($code)." @{ sent = $true })
    }
  } finally {
    if ($stream) { try { $stream.Dispose() } catch {} }
    try { $tcp.Close() } catch {}
  }
  $all = $raw.ToArray()
  $split = Find-Bytes $all ([byte[]](13, 10, 13, 10)) 0
  $status = 0
  $lines = @()
  if ($split -gt 0) {
    $lines = [Text.Encoding]::ASCII.GetString($all, 0, $split) -split "`r`n"
    if ($lines[0] -cmatch '^HTTP/1\.[01] ([0-9]{3})') { $status = [int]$Matches[1] }
  }
  # The answer started and broke off (or never came): Mikud got the request and may have acted on it.
  if ($status -eq 0) { throw (New-Fail 'unreachable' "Cannot reach $origin (UND_ERR_SOCKET)." @{ sent = $true }) }
  if ($status -ge 300 -and $status -lt 400) {
    throw (New-Fail 'unreachable' "$origin answered with a redirect ($status), which the command does not follow. Check Mikud's address." @{ sent = $true })
  }
  $headers = @{}
  foreach ($line in ($lines | Select-Object -Skip 1)) {
    $at = $line.IndexOf(':')
    if ($at -gt 0) { $headers[$line.Substring(0, $at).Trim().ToLowerInvariant()] = $line.Substring($at + 1).Trim() }
  }
  $rest = New-Object byte[] ($all.Length - $split - 4)
  [Array]::Copy($all, $split + 4, $rest, 0, $rest.Length)
  $bytes = $rest
  if ($headers.ContainsKey('transfer-encoding') -and $headers['transfer-encoding'] -match 'chunked') { $bytes = Get-Unchunked $rest }
  elseif ($headers.ContainsKey('content-length')) {
    $length = 0
    if (-not [int]::TryParse($headers['content-length'], [ref]$length) -or $rest.Length -lt $length) { $bytes = $null }
    else { $bytes = New-Object byte[] $length; [Array]::Copy($rest, 0, $bytes, 0, $length) }
  }
  if ($null -eq $bytes) { throw (New-Fail 'unreachable' "The answer from $origin broke off." @{ sent = $true }) }
  $text = $Utf8.GetString($bytes)
  $parsed = $null
  if ($text) { try { $parsed = (ConvertFrom-JsonText $text).value } catch {} }
  @{ status = $status; text = $text; json = $parsed }
}

# A refusal: Mikud's {error: {code, message}} (or Better Auth's code), carried in body.
function New-HttpFail($r, [string]$what) {
  $body = $null
  if ($r.json -is [Collections.IDictionary] -or $r.json -is [Collections.IList]) { $body = $r.json }
  $inner = $null
  if ($body -is [Collections.IDictionary] -and $body.Contains('error') -and ($body['error'] -is [Collections.IDictionary] -or $body['error'] -is [Collections.IList])) { $inner = $body['error'] }
  $detail = ''
  foreach ($pair in @(@($inner, 'message'), @($inner, 'code'), @($body, 'message'), @($body, 'error_description'), @($body, 'error'))) {
    if (-not $detail) { $detail = Get-Str $pair[0] $pair[1] }
  }
  $suffix = ''
  if ($detail) { $suffix = ": $detail" }
  New-Fail "http_$($r.status)" "$what failed ($($r.status)$suffix)." @{ status = $r.status; body = $body }
}

# Connecting

function Get-KeyName {
  $raw = $env:MIKUD_AGENT_NAME
  if (-not $raw) { $raw = Get-HostName }
  $computer = $raw -creplace '[^A-Za-z0-9._-]+', '-'
  if ($computer.Length -gt 15) { $computer = $computer.Substring(0, 15) }
  $computer = $computer -creplace '^-+|-+\z', ''
  if (-not $computer) { $computer = 'agent' }
  "skill:${computer}:$(Hex 4)"
}

function Get-PendingAnswer($pend) {
  $o = New-Object-Ordered
  $o['status'] = 'pending'
  $o['origin'] = $pend.origin
  $o['link'] = $pend.link
  $o['code'] = Get-GroupedCode $pend.userCode
  $o['expiresAt'] = Iso $pend.codeExpiresAt
  $o['next'] = Get-WaitCommand $pend.origin
  $o
}

function Get-ConnectedAnswer($conn) {
  $o = New-Object-Ordered
  $o['status'] = 'connected'
  $o['origin'] = $conn.origin
  $o['keyName'] = $conn.keyName
  $o['expiresAt'] = $conn.expiresAt
  $o
}

# The key name was saved as the connection: the attempt finished creating its key.
function Test-KeySaved($pend, $conn) { [bool]$pend.keySaved -or ($null -ne $conn -and $conn.keyName -ceq $pend.keyName) }

# What may be left on Mikud if this attempt were removed now; nothing for a completed connect.
function Get-AttemptWarnings($pend, $conn) {
  $warnings = @()
  if ($pend.phase -ceq 'creating_key') {
    # The token arrived, so an earlier poll whose answer was lost redeemed nothing: only this session counts.
    if (-not (Test-KeySaved $pend $conn)) { $warnings += 'key_unknown' }
    if ($pend.sessionOpen) { $warnings += 'session_unknown' }
  } elseif ($pend.pollInFlight -or $pend.uncertain -or $pend.sessionOpen) { $warnings += 'session_unknown' }
  , $warnings
}

# Removes an attempt, after writing what it may have left on Mikud. Under the lock.
function Remove-Attempt($ctx, $pend, $conn) {
  $warnings = Get-AttemptWarnings $pend $conn
  if ($warnings.Count) {
    Add-Left $ctx @($warnings | ForEach-Object { @{ origin = $pend.origin; keyName = $pend.keyName; reason = $_ } })
  }
  $latest = Read-Pending $ctx
  if ($null -ne $latest -and $latest.attemptId -ceq $pend.attemptId) { Remove-PrivateFile $ctx $ctx.pending }
  , $warnings
}

function New-UnknownFail($warnings, $pend) {
  $session = ''
  if ($warnings -ccontains 'session_unknown') { $session = " $SessionText" }
  if ($warnings -ccontains 'key_unknown') {
    return New-Fail 'key_unknown' "The connection to $($pend.origin) did not finish, and a key named `"$($pend.keyName)`" may exist: delete it in Settings, Agent access.$session" $null
  }
  New-Fail 'session_unknown' "The connection to $($pend.origin) did not finish, and the command cannot tell what Mikud did. $SessionText" $null
}

# An attempt a lock holder finds in creating_key belongs to a run that is gone (the lock is held through every step
# of a redeem): it is removed with what it may have left.
function Resolve-Orphan($ctx, $conn, $pend) {
  if ($null -eq $pend -or $pend.phase -cne 'creating_key') { return @{ pend = $pend; orphan = $null; warnings = @() } }
  $warnings = Remove-Attempt $ctx $pend $conn
  @{ pend = $null; orphan = $pend; warnings = $warnings }
}

function Invoke-Connect($ctx, $opts) {
  $days = Get-Days $opts.days
  [void](Protect-Home $ctx $true)
  $token = Enter-Lock $ctx
  try {
    $result = $null
    $conn = Read-Connection $ctx
    $found = Read-Pending $ctx
    $pend = (Resolve-Orphan $ctx $conn $found).pend
    if ($opts.url) { $origin = Get-Origin $opts.url }
    elseif ($conn -and $conn.origin) { $origin = $conn.origin }
    elseif ($found) { $origin = $found.origin }
    else { $origin = '' }
    if (-not $origin) { Fail 'no_url' 'No Mikud address is known. Ask the owner for it, then run: mikud connect --url <address>' }
    # The open code again, unless asked for a new one (--replace: the link did not work for the owner).
    if ($pend -and -not $opts.replace -and $pend.origin -ceq $origin -and $pend.phase -ceq 'polling' -and $pend.codeExpiresAt -gt (Now)) {
      $result = Get-PendingAnswer $pend
    } else {
      if ($conn -and -not $opts.replace) {
        Fail 'already_connected' "Already connected to $($conn.origin) with the key `"$($conn.keyName)`", until $($conn.expiresAt). To connect again, run: mikud connect --replace"
      }
      $r = Invoke-Request $origin 'POST' '/api/auth/device/code' (ConvertTo-JsonText ([ordered]@{ client_id = $ClientId })) '' $true ''
      if ($r.status -ne 200) { throw (New-HttpFail $r 'Asking Mikud for a code') }
      $d = $r.json
      $deviceCode = Get-Str $d 'device_code'
      $userCode = Get-Str $d 'user_code'
      $link = Get-Str $d 'verification_uri_complete'
      if ($deviceCode -cnotmatch $Secret -or $userCode -cnotmatch '^[A-Za-z0-9-]{4,20}\z' -or $link -cnotmatch $Plain) {
        Fail 'unexpected_answer' 'Mikud answered without a usable code. Nothing was stored.'
      }
      $linkOrigin = ''
      $lu = $null
      if ([Uri]::TryCreate($link, [UriKind]::Absolute, [ref]$lu) -and ($lu.Scheme -ceq 'http' -or $lu.Scheme -ceq 'https')) { $linkOrigin = "$($lu.Scheme)://$($lu.Authority)" }
      if ($linkOrigin -cne $origin) { Fail 'unexpected_answer' "Mikud's approval link is not on $origin. Nothing was stored." }
      # A pending attempt is replaced only now, once the new code exists; its link stops being used.
      if ($pend) { [void](Remove-Attempt $ctx $pend $conn) }
      $t = Now
      $interval = [Math]::Max(1, [Math]::Floor((Get-Num $d 'interval')))
      if ((Get-Num $d 'interval') -eq 0) { $interval = 5 }
      $expiresIn = [Math]::Floor((Get-Num $d 'expires_in'))
      if ((Get-Num $d 'expires_in') -eq 0) { $expiresIn = 600 }
      $next = @{
        v = 1; attemptId = (Hex 8); origin = $origin; deviceCode = $deviceCode; userCode = $userCode; link = $link
        interval = $interval; nextPollAt = $t + $interval; codeExpiresAt = $t + [Math]::Max(1, $expiresIn); days = $days
        keyName = (Get-KeyName); phase = 'polling'; pollInFlight = 0; uncertain = 0; sessionOpen = 0; keySaved = 0
      }
      Write-PendingIf $ctx $next $null
      $result = Get-PendingAnswer $next
    }
  } finally { Exit-Lock $ctx $token }
  $result['left'] = Get-LeftNow $ctx
  Write-Answer $result
}

function Invoke-Wait($ctx, $opts) {
  $origin = ''
  if ($opts.url) { $origin = Get-Origin $opts.url }
  if (-not $origin) {
    $p = Read-Pending $ctx
    if ($p) { $origin = $p.origin }
    if (-not $origin) { Fail 'not_connected' 'No connection is being made. Run: mikud connect --url <address>' }
  }
  $until = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
  $state = @{ attemptId = $null }
  while ($true) {
    $step = $null
    try {
      $token = Enter-Lock $ctx
      try { $step = Invoke-WaitStep $ctx $origin $state $token } finally { Exit-Lock $ctx $token }
    } catch [MikudChanged] { continue }
    if ($step.ContainsKey('done')) {
      $step.done['left'] = Get-LeftNow $ctx
      return Write-Answer $step.done
    }
    if ([DateTime]::UtcNow.AddSeconds($step.wait) -gt $until) {
      $o = New-Object-Ordered
      $o['status'] = 'still_waiting'
      $o['next'] = Get-WaitCommand $origin
      $o['left'] = Get-LeftNow $ctx
      return Write-Answer $o
    }
    Start-Sleep -Milliseconds ([int]($step.wait * 1000))
  }
}

# One look at the attempt under the lock: an answer, the seconds until the next poll, or one poll.
function Invoke-WaitStep($ctx, [string]$origin, $state, [string]$token) {
  $conn = Read-Connection $ctx
  $settled = Resolve-Orphan $ctx $conn (Read-Pending $ctx)
  $pend = $settled.pend
  if ($settled.orphan -and $settled.orphan.origin -ceq $origin) {
    if ($settled.warnings.Count) { throw (New-UnknownFail $settled.warnings $settled.orphan) }
    if ($conn -and $conn.keyName -ceq $settled.orphan.keyName) { return @{ done = (Get-ConnectedAnswer $conn) } }
  }
  if (-not $pend -or $pend.origin -cne $origin) {
    # Another command finished this attempt (a parallel --wait), or it was never made here.
    if ($conn -and $conn.origin -ceq $origin -and ($state.attemptId -or -not $pend)) { return @{ done = (Get-ConnectedAnswer $conn) } }
    if ($state.attemptId) { Fail 'not_connected' "The connection to $origin was cancelled meanwhile." }
    Fail 'not_connected' "No connection to $origin is being made. Run: mikud connect --url $origin"
  }
  # Replaced meanwhile (connect --replace): the new attempt has its own link and code.
  if ($state.attemptId -and $pend.attemptId -cne $state.attemptId) { return @{ done = (Get-PendingAnswer $pend) } }
  $state.attemptId = $pend.attemptId
  $t = Now
  if ($pend.codeExpiresAt -le $t) {
    $warnings = Remove-Attempt $ctx $pend $conn
    if ($warnings.Count) { throw (New-UnknownFail $warnings $pend) }
    Fail 'expired' "The code expired before it was approved. Run: mikud connect --url $origin"
  }
  if ($pend.nextPollAt -gt $t) { return @{ wait = $pend.nextPollAt - $t } }
  # A mark left set: the run before this one sent a poll and never recorded its answer.
  if ($pend.pollInFlight) { $pend.uncertain = 1 }
  $pend.pollInFlight = 1
  Write-PendingIf $ctx $pend $pend.attemptId
  Assert-Mine $ctx $token
  Invoke-Hook 'poll'
  try {
    $pollBody = ConvertTo-JsonText ([ordered]@{ grant_type = $DeviceGrant; device_code = $pend.deviceCode; client_id = $ClientId })
    $r = Invoke-Request $origin 'POST' '/api/auth/device/token' $pollBody '' $true ''
  } catch {
    $e = $_.Exception
    if ($e -is [MikudFail] -and $e.Code -ceq 'unreachable') {
      $pend.pollInFlight = 0
      if ($e.Extra['sent'] -ne $false) { $pend.uncertain = 1 }
      $pend.nextPollAt = (Now) + $pend.interval
      Write-PendingIf $ctx $pend $pend.attemptId
    }
    throw $e
  }
  $sessionToken = ''
  if ($r.status -eq 200) { $sessionToken = Get-Str $r.json 'access_token' }
  if ($sessionToken) { return @{ done = (Invoke-Redeem $ctx $pend $sessionToken) } }
  $err = Get-Str $r.json 'error'
  $pend.pollInFlight = 0
  if ($err -ceq 'authorization_pending' -or $err -ceq 'slow_down' -or $r.status -eq 429) {
    # RFC 8628: 5 seconds longer from now on; a rate-limited poll is the same request to slow down.
    if ($err -ceq 'slow_down' -or $r.status -eq 429) { $pend.interval += 5 }
    $pend.nextPollAt = (Now) + $pend.interval
    Write-PendingIf $ctx $pend $pend.attemptId
    return @{ wait = $pend.interval }
  }
  if ($err -ceq 'access_denied' -or $err -ceq 'expired_token' -or $err -ceq 'invalid_grant') {
    $warnings = Remove-Attempt $ctx $pend $conn
    if ($warnings.Count) { throw (New-UnknownFail $warnings $pend) }
    if ($err -ceq 'access_denied') { Fail 'denied' 'The owner did not approve the connection. Nothing was created.' }
    Fail 'expired' "The code is no longer valid. Run: mikud connect --url $origin"
  }
  # A failure after the server may have started: a session may exist.
  if ($r.status -ge 500 -or $r.status -eq 200) { $pend.uncertain = 1 }
  $pend.nextPollAt = (Now) + $pend.interval
  Write-PendingIf $ctx $pend $pend.attemptId
  throw (New-HttpFail $r 'Waiting for the approval')
}

# Ends the approval's session with its own token. True only when Mikud confirmed it.
function Stop-Session([string]$origin, [string]$sessionToken) {
  try {
    $r = Invoke-Request $origin 'POST' '/api/auth/revoke-session' (ConvertTo-JsonText ([ordered]@{ token = $sessionToken })) $sessionToken $true ''
    return $r.status -eq 200 -and $r.json -is [Collections.IDictionary] -and $r.json.Contains('status') -and $r.json['status'] -is [bool] -and $r.json['status']
  } catch { return $false }
}

# The approved code gave a session token: record that a key is being created, create it, save the connection, end
# the session, remove the attempt. In this order in every version, all under the lock.
function Invoke-Redeem($ctx, $pend, [string]$sessionToken) {
  $id = $pend.attemptId
  try {
    Write-PendingIf $ctx (Copy-Rec $pend @{ phase = 'creating_key'; sessionOpen = 1; pollInFlight = 0 }) $id
  } catch {
    $e = $_.Exception
    # Nothing is sent before this mark is written: the session ends at once.
    [void](Stop-Session $pend.origin $sessionToken)
    if ($e -is [MikudChanged]) { Fail 'cannot_save' 'The connection changed while this command ran. Run: mikud status' }
    throw $e
  }
  Invoke-Hook 'token'
  $conn = $null
  $failure = $null
  try { $conn = Invoke-CreateAndSave $ctx $pend $sessionToken } catch { $failure = $_.Exception }
  $ended = Stop-Session $pend.origin $sessionToken
  if ($ended) {
    try {
      $latest = Read-Pending $ctx
      if ($null -ne $latest -and $latest.attemptId -ceq $id) { Write-PendingIf $ctx (Copy-Rec $latest @{ sessionOpen = 0 }) $id }
    } catch {}
  }
  Invoke-Hook 'revoked'
  $last = Read-Pending $ctx
  if ($null -ne $last -and $last.attemptId -ceq $id) {
    # A connection that cannot be read now counts as not saved: the key is then reported, never lost.
    $saved = $null
    try { $saved = Read-Connection $ctx } catch {}
    [void](Remove-Attempt $ctx $last $saved)
  } elseif (-not $ended) { Add-Left $ctx @(@{ origin = $pend.origin; keyName = $pend.keyName; reason = 'session_unknown' }) }
  Invoke-Hook 'done'
  if ($failure) {
    if (-not $ended -and $failure -is [MikudFail]) { $failure.Text += " $SessionText" }
    throw $failure
  }
  $answer = Get-ConnectedAnswer $conn
  if (-not $ended) {
    $answer['warning'] = 'Could not confirm that the approval''s temporary session ended. End the session "mikud connect (agent approval)" on the Account page in Mikud.'
  }
  $answer
}

function Invoke-CreateAndSave($ctx, $pend, [string]$sessionToken) {
  $origin = $pend.origin
  $name = $pend.keyName
  $unknown = New-Fail 'key_unknown' "Mikud's answer to creating the key was lost, so a key named `"$name`" may exist on ${origin}: delete it in Settings, Agent access. Then run: mikud connect --url $origin" $null
  $create = ConvertTo-JsonText ([ordered]@{ name = $name; expiresIn = [long]($pend.days * 86400) })
  try {
    $r = Invoke-Request $origin 'POST' '/api/auth/api-key/create' $create $sessionToken $true ''
  } catch {
    $e = $_.Exception
    if ($e -is [MikudFail] -and $e.Code -ceq 'unreachable' -and $e.Extra['sent'] -ne $false) { throw $unknown }
    throw $e
  }
  Invoke-Hook 'key'
  if ($r.status -ge 500) { throw $unknown }
  if ($r.status -ne 200) { throw (New-HttpFail $r 'Creating the key') }
  $key = Get-Str $r.json 'key'
  $expiresAt = Get-Str $r.json 'expiresAt'
  if ($key -cnotmatch $Secret -or $expiresAt -cnotmatch $Plain -or $null -eq (Get-DateMs $expiresAt)) { throw $unknown }
  $notSaved = {
    param($fail)
    try { Add-Left $ctx @(@{ origin = $origin; keyName = $name; expiresAt = $expiresAt; reason = 'not_saved' }) }
    catch { $fail.Text += " The key `"$name`" on $origin works until ${expiresAt}: delete it in Settings, Agent access." }
    $fail
  }
  # Saved only while the attempt is still this run's: a parallel disconnect or --replace wins.
  $current = Read-Pending $ctx
  if ($null -eq $current -or $current.attemptId -cne $pend.attemptId) {
    throw (& $notSaved (New-Fail 'cannot_save' 'Another mikud command disconnected or started a new connection while this one waited, so the new key was not saved. Run: mikud status' $null))
  }
  $old = $null
  try {
    $old = Read-Connection $ctx
    # The key being replaced stays on Mikud: recorded before the connection that names it is replaced.
    if ($old -and $old.keyName -cne $name) {
      Add-Left $ctx @(@{ origin = $old.origin; keyName = $old.keyName; expiresAt = $old.expiresAt; reason = 'replaced' })
    }
    Write-Connection $ctx @{ v = 1; origin = $origin; key = $key; keyName = $name; expiresAt = $expiresAt }
  } catch {
    $e = $_.Exception
    if ($old -and $old.keyName -cne $name) {
      try {
        $kept = Read-Connection $ctx
        if ($kept -and $kept.keyName -ceq $old.keyName) {
          $entries = Read-Left $ctx
          Write-Left $ctx @($entries | Where-Object { -not ($_.keyName -ceq $old.keyName -and $_.origin -ceq $old.origin -and $_.reason -ceq 'replaced') })
        }
      } catch {}
    }
    if (-not ($e -is [MikudFail])) { $e = New-Fail 'cannot_save' "Cannot save the connection in $($ctx.dir)." $null }
    throw (& $notSaved $e)
  }
  try {
    $latest = Read-Pending $ctx
    if ($null -ne $latest -and $latest.attemptId -ceq $pend.attemptId) { Write-PendingIf $ctx (Copy-Rec $latest @{ keySaved = 1 }) $pend.attemptId }
  } catch {}
  Invoke-Hook 'saved'
  @{ origin = $origin; keyName = $name; expiresAt = $expiresAt }
}

# The other commands

function Get-Status($ctx) {
  $conn = Read-Connection $ctx
  $pend = Read-Pending $ctx
  $out = New-Object-Ordered
  if ($conn) {
    $out['status'] = 'connected'
    $out['origin'] = $conn.origin
    $out['keyName'] = $conn.keyName
    $out['expiresAt'] = $conn.expiresAt
  } else { $out['status'] = 'not_connected' }
  # An attempt whose key was saved and whose session ended is a finished connect that only lost its last step.
  $finished = $pend -and $pend.phase -ceq 'creating_key' -and (Test-KeySaved $pend $conn) -and -not $pend.sessionOpen
  if ($pend -and -not $finished) {
    $warnings = Get-AttemptWarnings $pend $conn
    $p = New-Object-Ordered
    $p['origin'] = $pend.origin
    $p['link'] = $pend.link
    $p['code'] = Get-GroupedCode $pend.userCode
    $p['expiresAt'] = Iso $pend.codeExpiresAt
    if ($warnings.Count) { $p['warnings'] = $warnings }
    $out['pending'] = $p
  }
  $out['left'] = Get-PublicLeft (Read-Left $ctx)
  $out
}

function Invoke-Disconnect($ctx) {
  if (-not (Protect-Home $ctx $false)) {
    $o = New-Object-Ordered
    $o['status'] = 'not_connected'
    $o['left'] = @()
    return Write-Answer $o
  }
  $token = Enter-Lock $ctx
  try {
    $result = New-Object-Ordered
    $conn = Read-Connection $ctx
    $pend = Read-Pending $ctx
    if ($pend) { [void](Remove-Attempt $ctx $pend $conn) }
    if (-not $conn) { $result['status'] = 'not_connected' }
    else {
      # The key stays on Mikud (a key cannot delete itself): recorded before the connection is removed.
      Add-Left $ctx @(@{ origin = $conn.origin; keyName = $conn.keyName; expiresAt = $conn.expiresAt; reason = 'disconnected' })
      Remove-PrivateFile $ctx $ctx.connection
      $result['status'] = 'disconnected'
      $result['origin'] = $conn.origin
      $result['keyName'] = $conn.keyName
      $result['expiresAt'] = $conn.expiresAt
      $result['message'] = "Forgot the connection on this computer. The key `"$($conn.keyName)`" still works on $($conn.origin) until $($conn.expiresAt): delete it in Settings, Agent access, if nothing uses it."
    }
  } finally { Exit-Lock $ctx $token }
  $result['left'] = Get-LeftNow $ctx
  Write-Answer $result
}

# The API

function Get-ApiPath([string]$method, $raw) {
  $value = ''
  if ($null -ne $raw) { $value = [string]$raw }
  $hint = " Use one of the paths in SKILL.md, for example: get 'items?q=login' (percent-encode anything else in a query)."
  if ($value.StartsWith('/', [StringComparison]::Ordinal)) { $value = $value.Substring(1) }
  $q = $value.IndexOf('?')
  if ($q -lt 0) { $part = $value; $qs = '' } else { $part = $value.Substring(0, $q); $qs = $value.Substring($q + 1) }
  if ($part -cnotmatch $PathPart -or $part.Contains('//')) { Fail 'bad_path' ('The path may hold only lower-case letters, digits, / and -.' + $hint) }
  if ($q -ge 0 -and $method -cne 'GET') { Fail 'bad_path' ('Only get takes a query.' + $hint) }
  if ($qs -cnotmatch $Query) { Fail 'bad_path' ('The query holds a character that must be percent-encoded.' + $hint) }
  $known = $false
  foreach ($route in $Routes) { if ($route[0] -ceq $method -and $part -cmatch $route[1]) { $known = $true } }
  if (-not $known) { Fail 'bad_path' ("$($method.ToLowerInvariant()) '$part' is not a call this skill makes." + $hint) }
  if ($q -lt 0) { return $part }
  "${part}?$qs"
}

function Get-Body([string]$method, $opts) {
  if ($method -ceq 'GET') {
    if ($null -ne $opts.json -or $null -ne $opts.jsonFile) { Fail 'bad_json' 'get takes no body.' }
    return $null
  }
  $text = $opts.json
  if ($null -ne $opts.jsonFile) {
    if ($null -ne $text) { Fail 'bad_json' 'Give either --json or --json-file, not both.' }
    try { $text = $Utf8.GetString([IO.File]::ReadAllBytes([IO.Path]::GetFullPath($opts.jsonFile))) } catch { Fail 'bad_json' "Cannot read $($opts.jsonFile)." }
  }
  if ($null -eq $text) { Fail 'bad_json' "$($method.ToLowerInvariant()) needs a body: --json '<body>' or --json-file <file>." }
  try { [void](ConvertFrom-JsonText $text) } catch { Fail 'bad_json' 'The body is not JSON.' }
  $text
}

function Get-AgentLabel($opts) {
  $label = $opts.as
  if ($null -eq $label) { $label = $env:MIKUD_AGENT_LABEL }
  if ($null -eq $label) { $label = '' }
  if ($label -eq '' -and $null -eq $opts.as) { return '' }
  if ($label -cnotmatch $LabelPattern) { Fail 'bad_label' 'The agent label takes 1 to 60 letters, digits, spaces and . _ : - only.' }
  $label
}

# A key Mikud no longer accepts is forgotten, while it is still the saved one.
function Clear-Connection($ctx, $conn) {
  try {
    $token = Enter-Lock $ctx
    try {
      $saved = Read-Connection $ctx
      if ($saved -and $saved.key -ceq $conn.key) { Remove-PrivateFile $ctx $ctx.connection }
    } finally { Exit-Lock $ctx $token }
  } catch {}
}

function Invoke-Api($ctx, [string]$method, $opts) {
  if ($opts.positional.Count -ne 1) { Fail 'bad_path' "Give one path: mikud $($method.ToLowerInvariant()) '<path>'" }
  $target = Get-ApiPath $method $opts.positional[0]
  $label = Get-AgentLabel $opts
  $body = Get-Body $method $opts
  $conn = Read-Connection $ctx
  if (-not $conn) { Fail 'not_connected' 'Not connected to Mikud. Run: mikud connect' }
  if ($opts.url -and (Get-Origin $opts.url) -cne $conn.origin) { Fail 'not_connected' "Connected to $($conn.origin), not to $(Get-Origin $opts.url)." }
  $unknown = {
    param($status)
    $extra = @{}
    $note = ''
    if ($status) { $extra.status = $status; $note = " ($status)" }
    New-Fail 'outcome_unknown' "The $method was sent, but its answer was lost${note}: it may still be written. Read the state once before doing anything else, and never send it again blindly." $extra
  }
  try {
    $r = Invoke-Request $conn.origin $method "/api/v1/$target" $body $conn.key $false $label
  } catch {
    $e = $_.Exception
    if ($e -is [MikudFail] -and $e.Code -ceq 'unreachable' -and $method -cne 'GET' -and $e.Extra['sent'] -ne $false) { throw (& $unknown 0) }
    throw $e
  }
  if ($r.status -eq 401) {
    Clear-Connection $ctx $conn
    Fail 'connection_ended' "Mikud no longer accepts this connection's key (it was disconnected in Settings or it expired). Run: mikud connect --url $($conn.origin)"
  }
  if ($method -cne 'GET' -and @(502, 503, 504) -contains $r.status) { throw (& $unknown $r.status) }
  if ($r.status -ge 200 -and $r.status -lt 300) {
    # Mikud answers {data} (a page also has nextCursor and the like): its fields go next to the HTTP status.
    $answer = $r.json
    $o = New-Object-Ordered
    $o['status'] = $r.status
    if ($answer -is [Collections.IDictionary] -and $answer.Contains('data')) {
      foreach ($k in $answer.get_Keys()) { if ([string]$k -cne 'status') { $o[$k] = $answer[$k] } }
    } else { $o['data'] = $answer }
    return Write-Answer $o
  }
  throw (New-HttpFail $r "$method $($target.Split('?')[0])")
}

function Invoke-Main([string[]]$argv) {
  $list = @($argv)
  $command = 'help'
  if ($list.Count) { $command = $list[0]; $list = @($list | Select-Object -Skip 1) }
  if (@('help', '--help', '-h') -ccontains $command) { Write-Raw $Utf8.GetBytes("$Help`n"); return }
  $opts = Read-Options $list
  $ctx = Get-Ctx
  try {
    if ($command -ceq 'status') {
      if ($opts.clearLeft) {
        [void](Protect-Home $ctx $true)
        $token = Enter-Lock $ctx
        try { Write-Left $ctx @() } finally { Exit-Lock $ctx $token }
      }
      return Write-Answer (Get-Status $ctx)
    }
    if ($command -ceq 'connect') { if ($opts.wait) { return Invoke-Wait $ctx $opts }; return Invoke-Connect $ctx $opts }
    if ($command -ceq 'disconnect') { return Invoke-Disconnect $ctx }
    if ($command -ceq 'get') { return Invoke-Api $ctx 'GET' $opts }
    if ($command -ceq 'post') { return Invoke-Api $ctx 'POST' $opts }
    if ($command -ceq 'patch') { return Invoke-Api $ctx 'PATCH' $opts }
  } catch {
    $e = $_.Exception
    # What the command left on Mikud travels with every answer about the connection.
    if ($e -is [MikudFail] -and @('connect', 'disconnect', 'status') -ccontains $command) { $e.Extra['left'] = Get-LeftNow $ctx }
    throw $e
  }
  Fail 'unknown_command' "Unknown command `"$command`". Run: mikud help"
}

try {
  Invoke-Main $args
  exit 0
} catch {
  $e = $_.Exception
  $out = New-Object-Ordered
  if ($e -is [MikudFail]) {
    $out['error'] = $e.Code
    $out['message'] = $e.Text
    if ($e.Extra.ContainsKey('status') -and $null -ne $e.Extra['status']) { $out['status'] = $e.Extra['status'] }
    if ($e.Extra.ContainsKey('body') -and $null -ne $e.Extra['body']) { $out['body'] = $e.Extra['body'] }
    $left = $null
    if ($e.Extra.ContainsKey('left')) { $left = $e.Extra['left'] }
    if ($left -is [Collections.ICollection] -and $left.Count) { $out['left'] = $left }
  } else {
    $out['error'] = 'failed'
    $out['message'] = $e.Message
  }
  Write-Answer $out
  exit 1
}
