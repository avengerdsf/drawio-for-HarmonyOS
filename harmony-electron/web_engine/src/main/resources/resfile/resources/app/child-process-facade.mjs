import childProcess from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {createFontExecFile, FONT_CATALOG_FILE} from './font-catalog.mjs';

const {app} = createRequire(import.meta.url)('electron');

export * from 'node:child_process';
export const execFile = createFontExecFile(childProcess.execFile,
  () => path.join(app.getPath('userData'), FONT_CATALOG_FILE));
export default new Proxy(childProcess, {
  get(target, key) {
    return key === 'execFile' ? execFile : Reflect.get(target, key, target);
  }
});
