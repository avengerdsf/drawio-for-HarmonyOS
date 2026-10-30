import { typeScriptPath } from './sdk-paths.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require(typeScriptPath());
const source = fs.readFileSync(path.join(root,
  'harmony-electron/web_engine/src/main/ets/adapter/DialogAdapter.ets'), 'utf8');
const parsed = ts.createSourceFile('DialogAdapter.ets', source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'DialogAdapter');
const method = declaration.members.find(node => node.name?.getText(parsed) === 'handleDefaultPath');
const compiled = ts.transpileModule('export class DialogCase { ' + method.getText(parsed) + ' }', {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
}).outputText;

// HarmonyOS APIs are external boundaries; the actual adapter method executes unchanged.
function fixture(records, entries, inaccessible = []) {
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, TAG: 'dialog-path-test',
    DialogAdapter: {DEFAULT_DIR: 'file://docs/storage/Users/currentUser'},
    LogUtil: {error() {}},
    fileUri: {FileUri: class {
      constructor(input) {
        const record = records[input];
        if (!record) throw Error('Invalid file URI');
        Object.assign(this, record);
      }
      toString() { return this.uri; }
    }},
    fs: {
      accessSync(value) {
        if (inaccessible.includes(value)) throw Error('Permission denied');
        return Object.hasOwn(entries, value);
      },
      statSync(value) {
        if (!Object.hasOwn(entries, value)) throw Error('File does not exist');
        return {isDirectory: () => entries[value] === 'directory', isFile: () => entries[value] === 'file'};
      }
    }
  });
  return value => Array.from(new exports.DialogCase().handleDefaultPath(value));
}

test('a new native-open.drawio keeps its filename and selected test folder', () => {
  const resolve = fixture({
    'file://docs/storage/Users/currentUser/Download/drawio-test-tmp/native-open.drawio': {
      path: '/storage/Users/currentUser/Download/drawio-test-tmp/native-open.drawio',
      name: 'native-open.drawio'
    }
  }, {'/storage/Users/currentUser/Download/drawio-test-tmp': 'directory'});
  assert.deepEqual(resolve('file://docs/storage/Users/currentUser/Download/drawio-test-tmp/native-open.drawio'),
    ['file://docs/storage/Users/currentUser/Download/drawio-test-tmp', 'native-open.drawio']);
});

test('existing file and directory defaults keep their canonical Picker URI', () => {
  const resolve = fixture({
    'file://docs/storage/Users/currentUser/Download/drawio-test-tmp/existing.drawio': {
      path: '/storage/Users/currentUser/Download/drawio-test-tmp/existing.drawio', name: 'existing.drawio'
    },
    'file://docs/storage/Users/currentUser/Download/drawio-test-tmp': {
      path: '/storage/Users/currentUser/Download/drawio-test-tmp', name: 'drawio-test-tmp'
    }
  }, {
    '/storage/Users/currentUser/Download/drawio-test-tmp/existing.drawio': 'file',
    '/storage/Users/currentUser/Download/drawio-test-tmp': 'directory'
  });
  assert.deepEqual(resolve('file://docs/storage/Users/currentUser/Download/drawio-test-tmp/existing.drawio'),
    ['file://docs/storage/Users/currentUser/Download/drawio-test-tmp', 'existing.drawio']);
  assert.deepEqual(resolve('file://docs/storage/Users/currentUser/Download/drawio-test-tmp'),
    ['file://docs/storage/Users/currentUser/Download/drawio-test-tmp', '']);
});

test('encoded Chinese and spaces stay encoded in the folder URI and decoded in the filename', () => {
  const resolve = fixture({
    'file://docs/storage/Users/currentUser/Download/%E6%B5%8B%E8%AF%95%20tmp/%E4%B8%AD%E6%96%87%20A.drawio': {
      path: '/storage/Users/currentUser/Download/测试 tmp/中文 A.drawio', name: '中文 A.drawio'
    }
  }, {'/storage/Users/currentUser/Download/测试 tmp': 'directory'});
  assert.deepEqual(resolve('file://docs/storage/Users/currentUser/Download/%E6%B5%8B%E8%AF%95%20tmp/%E4%B8%AD%E6%96%87%20A.drawio'),
    ['file://docs/storage/Users/currentUser/Download/%E6%B5%8B%E8%AF%95%20tmp', '中文 A.drawio']);
});

test('the official file URI mapping supplies the filesystem path and the Picker URI for absolute paths', () => {
  const resolve = fixture({
    '/storage/Users/currentUser/Download/drawio-test-tmp/中文 A.drawio': {
      path: '/mapped/shared/中文 A.drawio', name: '中文 A.drawio',
      uri: 'file://docs/storage/Users/currentUser/Download/drawio-test-tmp/%E4%B8%AD%E6%96%87%20A.drawio'
    }
  }, {'/mapped/shared': 'directory'});
  assert.deepEqual(resolve('/storage/Users/currentUser/Download/drawio-test-tmp/中文 A.drawio'),
    ['file://docs/storage/Users/currentUser/Download/drawio-test-tmp', '中文 A.drawio']);
});

test('a bare new filename keeps its literal percent characters in the default directory', () => {
  const resolve = fixture({}, {});
  assert.deepEqual(resolve('中文 100% A.drawio'), ['file://docs/storage/Users/currentUser', '中文 100% A.drawio']);
});

test('missing or inaccessible parent directories keep the filename at the fallback location', () => {
  const record = {
    'file://docs/storage/Users/currentUser/Download/missing/new.drawio': {
      path: '/storage/Users/currentUser/Download/missing/new.drawio', name: 'new.drawio'
    }
  };
  const missing = fixture(record, {});
  assert.deepEqual(missing('file://docs/storage/Users/currentUser/Download/missing/new.drawio'),
    ['file://docs/storage/Users/currentUser', 'new.drawio']);
  const denied = fixture(record, {}, ['/storage/Users/currentUser/Download/missing/new.drawio']);
  assert.deepEqual(denied('file://docs/storage/Users/currentUser/Download/missing/new.drawio'),
    ['file://docs/storage/Users/currentUser', 'new.drawio']);
});

test('empty values, invalid file URIs and external URLs fall back without a filename', () => {
  const resolve = fixture({}, {});
  for (const value of ['', '  ', '.', '..', undefined, null, {}, 'folder/new.drawio',
    'C:\\new.drawio', 'file://docs/%ZZ.drawio',
    'https://example.test/diagram.drawio', 'file://docs/bad\0.drawio']) {
    assert.deepEqual(resolve(value), ['file://docs/storage/Users/currentUser', '']);
  }
});
