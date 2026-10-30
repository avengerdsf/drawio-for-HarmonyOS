import electron from 'electron';
import {registerHooks} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHostHooks} from './loader.mjs';
import {installLocalEditorResources} from './renderer-resources.mjs';
import {installNativeInputState} from './native-input-state.mjs';
import {installNativeClipboardText} from './native-clipboard-text.mjs';
import {installNativeWindowControls} from './native-window-controls.mjs';

const upstreamDir = fileURLToPath(new URL('./upstream', import.meta.url));
const originalPackage = JSON.parse(fs.readFileSync(path.join(upstreamDir, 'package.json'), 'utf8'));
const originalMainURL = pathToFileURL(path.join(upstreamDir, originalPackage.main)).href;

electron.app.setAppPath(upstreamDir);
electron.app.setName(originalPackage.name);
registerHooks(createHostHooks(originalMainURL));
installLocalEditorResources(electron.app, new URL('./upstream/drawio/src/main/webapp/index.html', import.meta.url).href);
installNativeInputState(electron.app, new URL('./upstream/drawio/src/main/webapp/index.html', import.meta.url).href);
installNativeClipboardText(electron.app, new URL('./upstream/drawio/src/main/webapp/index.html', import.meta.url).href);
const windowControlIcons = Object.fromEntries(['minimize', 'maximize', 'restore', 'close'].map(name => [name,
  'data:image/svg+xml;base64,' + fs.readFileSync(new URL('./window-controls/window_' + name + '.svg', import.meta.url)).toString('base64')]));
installNativeWindowControls(electron.app, electron.ipcMain, electron.BrowserWindow,
  new URL('./upstream/drawio/src/main/webapp/index.html', import.meta.url).href, windowControlIcons,
  path.join(electron.app.getPath('userData'), 'diagramdesk-window-mode.json'));
await import(originalMainURL);
