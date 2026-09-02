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
  return `^${filePath.replace(/\\/g, '\\\\').replace(/\./g, '\\.')}$`;
}

function findAllowExecuteArray(config) {
  const keyMatch = /(?:^|\n)([ \t]*)allow_execute[ \t]*=[ \t]*\[/m.exec(config);
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
  const array = findAllowExecuteArray(config);
  if (!array) {
    throw new Error('Could not find the existing allow_execute array in config.toml.');
  }

  const arrayText = config.slice(array.openingIndex + 1, array.closingIndex);
  const existingPaths = [...arrayText.matchAll(/"((?:\\.|[^"\\])*)"/g)]
    .map((match) => match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  const expectedPattern = allowExecutePattern(executablePath);
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
  const zaparooPath = path.join(executableDirectory, 'zaparoo.txt');
  const bundledUtility = path.join(executableDirectory, 'app', 'jackbox_patcher.exe');
  const launchPath = fs.existsSync(bundledUtility) ? 'app\\jackbox_patcher.exe' : path.basename(executablePath);
  const batContents = `@echo off\r\nexplorer.exe "%~dp0${launchPath}"\r\n`;
  const tokenContents = `**execute:${batPath}`;
  const originalConfig = fs.readFileSync(CONFIG_PATH, 'utf8');
  const updated = addAllowedPath(originalConfig, batPath);

  const files = [
    { path: batPath, contents: batContents },
    { path: zaparooPath, contents: tokenContents },
  ];
  if (updated.added) files.push({ path: CONFIG_PATH, contents: updated.config });
  const elevated = writeArtifactFiles(files);

  return { executablePath, batPath, zaparooPath, configPath: CONFIG_PATH, addedToConfig: updated.added, elevated };
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
