const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4317);
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const CONFIG_PATH = process.env.ZAPAROO_CONFIG_PATH || path.join(localAppData, 'zaparoo', 'config.toml');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ELEVATED_WRITER = path.join(__dirname, 'elevated-writer.ps1');

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function tomlQuote(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '')}"`;
}

function allowExecutePattern(filePath) {
  const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
  const driveIndependentPath = escapedPath.replace(/^[A-Za-z]:\\\\/, '[A-Za-z]:\\\\');
  return `^${driveIndependentPath}$`;
}

function allowFilePattern(filePath) {
  return allowExecutePattern(filePath);
}

function findConfigArray(config, key) {
  const keyMatch = new RegExp(`(?:^|\\n)([ \\t]*)${key}[ \\t]*=[ \\t]*\\[`, 'm').exec(config);
  if (!keyMatch) return null;

  const openingIndex = config.indexOf('[', keyMatch.index + keyMatch[0].length - 1);
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = openingIndex; index < config.length; index += 1) {
    const character = config[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) return { openingIndex, closingIndex: index };
    }
  }
  return null;
}

function addAllowedPath(config, executablePath) {
  const array = findConfigArray(config, 'allow_file');
  if (!array) {
    const separator = config.endsWith('\n') ? '' : '\n';
    return {
      config: `${config}${separator}\n[launchers]\nallow_file = [\n    ${tomlQuote(allowFilePattern(executablePath))}\n]\n`,
      added: true,
    };
  }

  const arrayText = config.slice(array.openingIndex + 1, array.closingIndex);
  const existingPaths = [...arrayText.matchAll(/"((?:\\.|[^"\\])*)"/g)]
    .map((match) => match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  const expectedPattern = allowFilePattern(executablePath);
  if (existingPaths.some((entry) => entry.toLowerCase() === expectedPattern.toLowerCase())) {
    return { config, added: false };
  }

  const beforeClose = config.slice(0, array.closingIndex);
  const contentBeforeClose = beforeClose.trimEnd();
  const lineStart = contentBeforeClose.lastIndexOf('\n') + 1;
  const entryIndent = (contentBeforeClose.slice(lineStart).match(/^[ \t]*/) || [''])[0];
  const needsComma = !/[,[：:]$]/.test(contentBeforeClose.slice(-1));
  const insertion = `${needsComma ? ',' : ''}\n${entryIndent}${tomlQuote(expectedPattern)}\n`;
  return {
    config: `${contentBeforeClose}${insertion}${config.slice(array.closingIndex)}`,
    added: true,
  };
}

function createSetupScript(launcherRelativePath) {
  const escapedLauncherPath = launcherRelativePath.replace(/'/g, "''");
  return `@echo off\r\nsetlocal\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0zaparoo-setup.ps1" -LauncherRelativePath "${escapedLauncherPath}"\r\nif errorlevel 1 pause\r\n`;
}

/* function createSetupPowerShell() {
  return `param(\r\n  [Parameter(Mandatory = $true)]\r\n  [string]$LauncherRelativePath\r\n)\r\n\r\n$configPath = Join-Path $env:LOCALAPPDATA 'zaparoo\\config.toml'\r\nif (-not (Test-Path -LiteralPath $configPath)) { throw \"Zaparoo config not found at $configPath\" }\r\n$config = Get-Content -LiteralPath $configPath -Raw\r\n$driveLetter = $LauncherRelativePath.Substring(0, 1)\r\n$launcherPath = \"$driveLetter:\\$($LauncherRelativePath.Replace('/', '\\').TrimStart('\\'))\"\r\n$escapedPath = [regex]::Escape($launcherPath)\r\n$allowPattern = \"^[A-Za-z]:\\\\$([regex]::Escape($LauncherRelativePath.Substring(3).Replace('/', '\\')))\$\"\r\n\r\n$backupPath = \"$configPath.$(Get-Date -Format yyyyMMdd-HHmmss).bak\"\r\nCopy-Item -LiteralPath $configPath -Destination $backupPath\r\n\r\nif ($config -notmatch '(?m)^\\[readers\\.drivers\\.externaldrive\\]') {\r\n  $config += \"`r`n`r`n[readers.drivers.externaldrive]`r`nenabled = true`r`n\"\r\n} elseif ($config -notmatch '(?ms)\\[readers\\.drivers\\.externaldrive\\].*?^enabled\\s*=\\s*true') {\r\n  $config = [regex]::Replace($config, '(?m)(^\\[readers\\.drivers\\.externaldrive\\]\\s*$)', \"`$1`r`nenabled = true\")\r\n}\r\n\r\nif ($config -notmatch '(?m)^\\[launchers\\]') {\r\n  $config += \"`r`n`r`n[launchers]`r`nallow_file = [`\"$allowPattern`\"]`r`n\"\r\n} elseif ($config -notmatch [regex]::Escape($allowPattern)) {\r\n  $config += \"`r`nallow_file = [`\"$allowPattern`\"]`r`n\"\r\n}\r\n\r\nSet-Content -LiteralPath $configPath -Value $config -Encoding utf8\r\nWrite-Host \"Zaparoo configured for $launcherPath\"\r\nWrite-Host \"Backup: $backupPath\"\r\n$zaparoo = Get-Command Zaparoo.exe -ErrorAction SilentlyContinue\r\nif ($zaparoo) { Start-Process -FilePath $zaparoo.Source -ArgumentList '-reload' -Wait } else { Write-Host 'Reload Zaparoo from its system-tray menu.' }\r\n`;
  return `param(\r\n  [Parameter(Mandatory = $true)]\r\n  [string]$LauncherRelativePath\r\n)\r\n\r\n$configPath = Join-Path $env:LOCALAPPDATA 'zaparoo\\config.toml'\r\nif (-not (Test-Path -LiteralPath $configPath)) { throw \"Zaparoo config not found at $configPath\" }\r\n$config = Get-Content -LiteralPath $configPath -Raw\r\n$relativePath = $LauncherRelativePath.Replace('/', '\\').TrimStart('\\')\r\n$launcherPath = Join-Path ([IO.Path]::GetPathRoot($PSScriptRoot)) $relativePath\r\n$regexPath = $relativePath.Replace('\\', '\\\\').Replace('.', '\\.')\r\n$allowPattern = \"^[A-Za-z]:\\\\$regexPath$\"\r\n\r\n$backupPath = \"$configPath.$(Get-Date -Format yyyyMMdd-HHmmss).bak\"\r\nCopy-Item -LiteralPath $configPath -Destination $backupPath\r\n\r\nif ($config -notmatch '(?m)^\\[readers\\.drivers\\.externaldrive\\]') {\r\n  $config += \"`r`n`r`n[readers.drivers.externaldrive]`r`nenabled = true`r`n\"\r\n} elseif ($config -notmatch '(?ms)\\[readers\\.drivers\\.externaldrive\\].*?^enabled\\s*=\\s*true') {\r\n  $config = [regex]::Replace($config, '(?m)(^\\[readers\\.drivers\\.externaldrive\\]\\s*$)', \"`$1`r`nenabled = true\")\r\n}\r\n\r\nif ($config -notmatch '(?m)^\\[launchers\\]') {\r\n  $config += \"`r`n`r`n[launchers]`r`nallow_file = ['\"$allowPattern\"']`r`n\"\r\n} elseif ($config -notmatch '(?m)^allow_file\\s*=') {\r\n  $config = [regex]::Replace($config, '(?m)(^\\[launchers\\]\\s*$)', \"`$1`r`nallow_file = ['\"$allowPattern\"']\")\r\n} elseif ($config -notmatch [regex]::Escape($allowPattern)) {\r\n  $config = [regex]::Replace($config, '(?ms)(^allow_file\\s*=\\s*\\[).*?(^\\])', \"`$1`r`n    '$allowPattern'`r`n`$2\")\r\n}\r\n\r\nSet-Content -LiteralPath $configPath -Value $config -Encoding utf8\r\nWrite-Host \"Zaparoo configured for $launcherPath\"\r\nWrite-Host \"Backup: $backupPath\"\r\n$zaparoo = Get-Command Zaparoo.exe -ErrorAction SilentlyContinue\r\nif ($zaparoo) { Start-Process -FilePath $zaparoo.Source -ArgumentList '-reload' -Wait } else { Write-Host 'Reload Zaparoo from its system-tray menu.' }\r\n`;
}

*/

/* function createSetupPowerShell() {
  return `param(\r\n  [Parameter(Mandatory = $true)]\r\n  [string]$LauncherRelativePath\r\n)\r\n\r\n$configPath = Join-Path $env:LOCALAPPDATA 'zaparoo\\config.toml'\r\nif (-not (Test-Path -LiteralPath $configPath)) { throw \"Zaparoo config not found at $configPath\" }\r\n$config = Get-Content -LiteralPath $configPath -Raw\r\n$relativePath = $LauncherRelativePath.Replace('/', '\\').TrimStart('\\')\r\n$launcherPath = Join-Path ([IO.Path]::GetPathRoot($PSScriptRoot)) $relativePath\r\n$regexPath = $relativePath.Replace('\\', '\\\\').Replace('.', '\\.')\r\n$allowPattern = \"^[A-Za-z]:\\\\$regexPath$\"\r\n\r\n$backupPath = \"$configPath.$(Get-Date -Format yyyyMMdd-HHmmss).bak\"\r\nCopy-Item -LiteralPath $configPath -Destination $backupPath\r\n\r\nif ($config -notmatch '(?m)^\\[readers\\.drivers\\.externaldrive\\]') {\r\n  $config += \"`r`n`r`n[readers.drivers.externaldrive]`r`nenabled = true`r`n\"\r\n} elseif ($config -notmatch '(?ms)\\[readers\\.drivers\\.externaldrive\\].*?^enabled\\s*=\\s*true') {\r\n  $config = [regex]::Replace($config, '(?m)(^\\[readers\\.drivers\\.externaldrive\\]\\s*$)', \"`$1`r`nenabled = true\")\r\n}\r\n\r\nif ($config -notmatch '(?m)^\\[launchers\\]') {\r\n  $config += \"`r`n`r`n[launchers]`r`nallow_file = ['$allowPattern']`r`n\"\r\n} elseif ($config -notmatch '(?m)^allow_file\\s*=') {\r\n  $config = [regex]::Replace($config, '(?m)(^\\[launchers\\]\\s*$)', \"`$1`r`nallow_file = ['$allowPattern']\")\r\n} elseif ($config -notmatch [regex]::Escape($allowPattern)) {\r\n  $config = [regex]::Replace($config, '(?ms)(^allow_file\\s*=\\s*\\[).*?(^\\])', \"`$1`r`n    '$allowPattern'`r`n`$2\")\r\n}\r\n\r\nSet-Content -LiteralPath $configPath -Value $config -Encoding utf8\r\nWrite-Host \"Zaparoo configured for $launcherPath\"\r\nWrite-Host \"Backup: $backupPath\"\r\n$zaparoo = Get-Command Zaparoo.exe -ErrorAction SilentlyContinue\r\nif ($zaparoo) { Start-Process -FilePath $zaparoo.Source -ArgumentList '-reload' -Wait } else { Write-Host 'Reload Zaparoo from its system-tray menu.' }\r\n`;
}

*/

/* function createSetupPowerShell() {
  return `param([Parameter(Mandatory = $true)][string]$LauncherRelativePath)\r\n$configPath = Join-Path $env:LOCALAPPDATA 'zaparoo\\config.toml'\r\nif (-not (Test-Path -LiteralPath $configPath)) { throw \"Zaparoo config not found at $configPath\" }\r\n$config = Get-Content -LiteralPath $configPath -Raw\r\n$relativePath = $LauncherRelativePath.Replace('/', '\\').TrimStart('\\')\r\n$root = [IO.Path]::GetPathRoot($PSScriptRoot)\r\n$launcherPath = Join-Path $root $relativePath\r\n$regexPath = $relativePath.Replace('\\', '\\\\').Replace('.', '\\.')\r\n$allowPattern = \"^[A-Za-z]:\\\\$regexPath$\"\r\n$backupPath = \"$configPath.$(Get-Date -Format yyyyMMdd-HHmmss).bak\"\r\nCopy-Item -LiteralPath $configPath -Destination $backupPath\r\n$newline = [Environment]::NewLine\r\nif ($config -notmatch '(?m)^\\[readers\\.drivers\\.externaldrive\\]') { $config += $newline + $newline + '[readers.drivers.externaldrive]' + $newline + 'enabled = true' + $newline } elseif ($config -notmatch '(?ms)\\[readers\\.drivers\\.externaldrive\\].*?^enabled\\s*=\\s*true') { $config = [regex]::Replace($config, '(?m)(^\\[readers\\.drivers\\.externaldrive\\]\\s*$)', \"`$1$newline`nenabled = true\") }\r\nif ($config -notmatch '(?m)^\\[launchers\\]') { $config += $newline + $newline + '[launchers]' + $newline + \"allow_file = ['$allowPattern']\" + $newline } elseif ($config -notmatch '(?m)^allow_file\\s*=') { $config = [regex]::Replace($config, '(?m)(^\\[launchers\\]\\s*$)', \"`$1$newline`nallow_file = ['$allowPattern']\") } elseif ($config -notmatch [regex]::Escape($allowPattern)) { $config = [regex]::Replace($config, '(?ms)(^allow_file\\s*=\\s*\\[).*?(^\\])', \"`$1$newline    '$allowPattern'$newline`$2\") }\r\nSet-Content -LiteralPath $configPath -Value $config -Encoding utf8\r\nWrite-Host \"Zaparoo configured for $launcherPath\"\r\nWrite-Host \"Backup: $backupPath\"\r\n$zaparoo = Get-Command Zaparoo.exe -ErrorAction SilentlyContinue\r\nif ($zaparoo) { Start-Process -FilePath $zaparoo.Source -ArgumentList '-reload' -Wait } else { Write-Host 'Reload Zaparoo from its system-tray menu.' }\r\n`;
}

*/

function createSetupPowerShell() {
  return fs.readFileSync(path.join(__dirname, 'setup-template.ps1'), 'utf8');
}

function writeFilesWithElevation(files) {
  const payloadPath = path.join(os.tmpdir(), `zaparoo-drive-launcher-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify({ files }), 'utf8');
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ELEVATED_WRITER,
      '-PayloadPath', payloadPath,
    ], { encoding: 'utf8', windowsHide: false });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || 'Administrator permission was not granted.');
    }
  } finally {
    fs.rmSync(payloadPath, { force: true });
  }
}

function writeArtifactFiles(files) {
  try {
    for (const file of files) fs.writeFileSync(file.path, file.contents, 'utf8');
    return false;
  } catch (error) {
    if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
    writeFilesWithElevation(files);
    return true;
  }
}

function createArtifacts(executablePath) {
  if (!path.isAbsolute(executablePath)) throw new Error('The executable path must be absolute.');
  if (!fs.existsSync(executablePath) || !fs.statSync(executablePath).isFile()) {
    throw new Error('That executable could not be found.');
  }
  if (!fs.existsSync(CONFIG_PATH)) throw new Error(`Zaparoo config was not found at ${CONFIG_PATH}.`);

  const executableDirectory = path.dirname(executablePath);
  const executableName = path.basename(executablePath, path.extname(executablePath));
  const batPath = path.join(executableDirectory, `zaparoo-launch-${executableName}.bat`);
  const driveRoot = path.parse(executablePath).root;
  const zaparooPath = path.join(driveRoot, 'zaparoo.txt');
  const launcherRelativePath = path.relative(driveRoot, batPath).replace(/\\/g, '/');
  const setupBatPath = path.join(driveRoot, 'zaparoo-setup.bat');
  const setupPowerShellPath = path.join(driveRoot, 'zaparoo-setup.ps1');
  const bundledUtility = path.join(executableDirectory, 'app', 'jackbox_patcher.exe');
  const launchPath = fs.existsSync(bundledUtility) ? 'app\\jackbox_patcher.exe' : path.basename(executablePath);
  const batContents = `@echo off\r\nsetlocal\r\npushd "%~dp0"\r\n"%~dp0${launchPath}"\r\nset "exitCode=%errorlevel%"\r\npopd\r\nexit /b %exitCode%\r\n`;
  const tokenContents = launcherRelativePath;
  const originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
  const updated = addAllowedPath(originalConfig, batPath);

  const files = [
    { path: batPath, contents: batContents },
    { path: zaparooPath, contents: tokenContents },
    { path: setupBatPath, contents: createSetupScript(launcherRelativePath) },
    { path: setupPowerShellPath, contents: createSetupPowerShell() },
  ];
  if (updated.added) files.push({ path: CONFIG_PATH, contents: updated.config });
  const elevated = writeArtifactFiles(files);

  return { executablePath, batPath, zaparooPath, setupBatPath, configPath: CONFIG_PATH, addedToConfig: updated.added, elevated };
}

function chooseExecutable() {
  return new Promise((resolve, reject) => {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
      '$dialog.Title = "Select an executable for Zaparoo"',
      '$dialog.Filter = "Executables (*.exe;*.com)|*.exe;*.com|All files (*.*)|*.*"',
      '$dialog.Multiselect = $false',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Write($dialog.FileName) }',
    ].join('; ');
    const picker = spawn('powershell.exe', ['-NoProfile', '-Sta', '-Command', script], { windowsHide: false });
    let output = '';
    let error = '';
    picker.stdout.on('data', (chunk) => { output += chunk; });
    picker.stderr.on('data', (chunk) => { error += chunk; });
    picker.on('error', reject);
    picker.on('close', (code) => {
      if (code !== 0) reject(new Error(error.trim() || 'The file picker could not be opened.'));
      else resolve(output.trim());
    });
  });
}

function serveStatic(request, response) {
  const requested = request.url === '/' ? '/index.html' : request.url;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(response, 404, { error: 'Not found.' });
  fs.readFile(filePath, (error, data) => {
    if (error) return sendJson(response, 404, { error: 'Not found.' });
    const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
    response.end(data);
  });
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/api/status') {
    return sendJson(response, 200, { configPath: CONFIG_PATH, configExists: fs.existsSync(CONFIG_PATH) });
  }
  if (request.method === 'POST' && request.url === '/api/pick') {
    return chooseExecutable().then((executablePath) => sendJson(response, 200, { executablePath })).catch((error) => sendJson(response, 400, { error: error.message }));
  }
  if (request.method === 'POST' && request.url === '/api/create') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        const { executablePath } = JSON.parse(body);
        sendJson(response, 200, createArtifacts(executablePath));
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
    });
    return;
  }
  if (request.method === 'GET') return serveStatic(request, response);
  sendJson(response, 405, { error: 'Method not allowed.' });
});

server.listen(PORT, HOST, () => console.log(`Zaparoo Drive Launcher running at http://${HOST}:${PORT}`));
