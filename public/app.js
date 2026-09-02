const pickButton = document.querySelector('#pickButton');
const pickLabel = document.querySelector('#pickLabel');
const selectedFile = document.querySelector('#selectedFile');
const batName = document.querySelector('#batName');
const createButton = document.querySelector('#createButton');
const message = document.querySelector('#message');
const configPath = document.querySelector('#configPath');
let executablePath = '';

function showMessage(text, type = '') {
  message.textContent = text;
  message.className = `message ${type}`;
}

fetch('/api/status').then((response) => response.json()).then((status) => {
  configPath.textContent = status.configPath;
  if (!status.configExists) showMessage(`Zaparoo config not found at ${status.configPath}.`, 'error');
}).catch(() => showMessage('The local helper is unavailable.', 'error'));

pickButton.addEventListener('click', async () => {
  pickButton.disabled = true;
  pickLabel.textContent = 'Opening file picker...';
  showMessage('');
  try {
    const response = await fetch('/api/pick', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    executablePath = result.executablePath;
    const name = executablePath.split(/[\\/]/).pop();
    const stem = name.replace(/\.[^.]+$/, '');
    pickLabel.textContent = 'Choose a different executable';
    selectedFile.textContent = executablePath;
    selectedFile.className = 'selected-file';
    batName.textContent = `zaparoo-launch-${stem}.bat`;
    createButton.disabled = false;
  } catch (error) {
    if (error.message) showMessage(error.message, 'error');
    pickLabel.textContent = 'Browse for an .exe';
  } finally {
    pickButton.disabled = false;
  }
});

createButton.addEventListener('click', async () => {
  createButton.disabled = true;
  createButton.firstChild.textContent = 'Creating... ';
  showMessage('');
  try {
    const response = await fetch('/api/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ executablePath }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    showMessage(result.addedToConfig ? 'Launcher created and added to allow_execute.' : 'Launcher files already existed; config was already up to date.', 'success');
  } catch (error) {
    showMessage(error.message, 'error');
  } finally {
    createButton.disabled = false;
    createButton.firstChild.textContent = 'Create launcher ';
  }
});
