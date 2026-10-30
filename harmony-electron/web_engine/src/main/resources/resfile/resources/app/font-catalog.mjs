import fs from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';

export const FONT_CATALOG_FILE = 'diagramdesk-font-catalog.json';
const format = '--format=%{family[0]}\\n';

async function readFamilies(filename, timeout) {
  const deadline = Date.now() + (timeout > 0 ? timeout : 30000);
  for (;;) {
    let contents;
    try {
      contents = await fs.readFile(filename, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (Date.now() >= deadline) {
        throw Object.assign(new Error('Font catalog is not ready'), {code: 'ETIMEDOUT'});
      }
      await delay(20);
      continue;
    }
    const families = JSON.parse(contents);
    if (!Array.isArray(families) || !families.every(value => typeof value === 'string')) {
      throw new Error('Invalid font catalog');
    }
    return families.length ? families.join('\n') + '\n' : '';
  }
}

export function createFontExecFile(nativeExecFile, catalogPath) {
  return function execFile(file, args, options, callback) {
    if (file !== 'fc-list' || !Array.isArray(args) || args.length !== 1 || args[0] !== format ||
        options?.encoding !== 'utf8' || typeof callback !== 'function') {
      return Reflect.apply(nativeExecFile, this, arguments);
    }
    Promise.resolve().then(() => readFamilies(catalogPath(), options.timeout))
      .then(stdout => callback(null, stdout, ''), error => callback(error, '', ''));
  };
}
