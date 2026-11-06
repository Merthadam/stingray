// Render the existing SVG mark using the project-local Electron runtime.
const { app, BrowserWindow } = require('electron');
const { readFile, mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
app.whenReady().then(async () => {
  const output = process.argv[2];
  if (!output) throw new Error('An iconset output directory is required');
  const svg = await readFile(path.join(__dirname, '../public/stingray.svg'), 'utf8');
  const window = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}svg{width:100%;height:100%}</style>' + svg));
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const source = await window.webContents.capturePage();
  await mkdir(output, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      await writeFile(path.join(output, name), source.resize({ width: size * scale, height: size * scale, quality: 'best' }).toPNG());
    }
  }
  window.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
