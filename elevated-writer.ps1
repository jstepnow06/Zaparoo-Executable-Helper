param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadPath
)

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-PayloadPath', $PayloadPath)
  $elevated = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList $arguments
  exit $elevated.ExitCode
}

$payload = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
foreach ($file in $payload.files) {
  [System.IO.File]::WriteAllText($file.path, $file.contents, $utf8NoBom)
}