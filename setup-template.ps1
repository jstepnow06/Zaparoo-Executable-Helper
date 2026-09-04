param(
  [Parameter(Mandatory = $true)]
  [string]$LauncherRelativePath
)

$configPath = Join-Path $env:LOCALAPPDATA 'zaparoo\config.toml'
if (-not (Test-Path -LiteralPath $configPath)) { throw "Zaparoo config not found at $configPath" }
$config = Get-Content -LiteralPath $configPath -Raw
$relativePath = $LauncherRelativePath.Replace('/', '\').TrimStart('\')
$root = [IO.Path]::GetPathRoot($PSScriptRoot)
$launcherPath = Join-Path $root $relativePath
$regexPath = $relativePath.Replace('\', '\\').Replace('.', '\.')
$allowPattern = "^[A-Za-z]:\\$regexPath$"
$tomlAllowPattern = $allowPattern.Replace('\', '\\').Replace('"', '\"')
$newline = [Environment]::NewLine

function Ensure-ConfigKey {
  param([string]$Text, [string]$Header, [string]$Key, [string]$Value)
  $section = [regex]::Match($Text, '(?ms)^' + [regex]::Escape($Header) + '\s*$.*?(?=^\[|\z)')
  if (-not $section.Success) { return $Text + $newline + $newline + $Header + $newline + "$Key = $Value" + $newline }
  if ($section.Value -match ('(?m)^\s*' + [regex]::Escape($Key) + '\s*=')) { return $Text }
  $updated = $section.Value -replace ('(?m)^' + [regex]::Escape($Header) + '\s*$'), ($Header + $newline + "$Key = $Value")
  return $Text.Replace($section.Value, $updated)
}

$config = Ensure-ConfigKey $config '[readers]' 'auto_detect' 'true'
$config = Ensure-ConfigKey $config '[readers.drivers.externaldrive]' 'enabled' 'true'
$config = Ensure-ConfigKey $config '[[readers.connect]]' 'enabled' 'true'
$config = Ensure-ConfigKey $config '[[readers.connect]]' 'driver' "'externaldrive'"
$config = Ensure-ConfigKey $config '[readers.scan]' 'mode' "'hold'"

$launchers = [regex]::Match($config, '(?ms)^\[launchers\].*?(?=^\[|\z)')
if (-not $launchers.Success) {
  $config += $newline + $newline + '[launchers]' + $newline + ('allow_file = ["' + $tomlAllowPattern + '"]') + $newline
} elseif ($launchers.Value -notmatch [regex]::Escape($allowPattern)) {
  $section = $launchers.Value
  $allowFile = [regex]::Match($section, '(?m)^\s*allow_file\s*=\s*\[')
  if ($allowFile.Success) {
    $lines = $section -split '\r?\n'
    $start = [array]::IndexOf($lines, ($lines | Where-Object { $_ -match '^\s*allow_file\s*=\s*\[' } | Select-Object -First 1))
    $end = $start + 1
    while ($end -lt $lines.Count -and $lines[$end] -notmatch '^\s*\]') { $end++ }
    if ($end -gt ($start + 1) -and $lines[$end - 1].Trim() -notmatch '[,]$') { $lines[$end - 1] = $lines[$end - 1] + ',' }
    $lines = @($lines[0..($end - 1)] + ('    "' + $tomlAllowPattern + '"') + $lines[$end..($lines.Count - 1)])
    $section = $lines -join $newline
    $config = $config.Replace($launchers.Value, $section)
  } else {
    $section = $launchers.Value.TrimEnd() + $newline + ('allow_file = ["' + $tomlAllowPattern + '"]') + $newline
    $config = $config.Replace($launchers.Value, $section)
  }
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($configPath, $config, $utf8NoBom)
Write-Host "Zaparoo configured for $launcherPath"
Write-Host 'Open the Zaparoo tray menu and choose Reload.'
