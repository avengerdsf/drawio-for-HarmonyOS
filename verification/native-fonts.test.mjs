import { arktsLoaderPath } from './sdk-paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const host = path.join(root, 'harmony-electron/web_engine/src/main/resources/resfile/resources/app');
const catalogSource = path.join(root, 'harmony-electron/electron/src/main/ets/host/FontCatalog.ets');
const require = createRequire(import.meta.url);
const ts = require(arktsLoaderPath() + '/node_modules/typescript');
const format = '--format=%{family[0]}\\n';
const moduleAt = name => import(pathToFileURL(path.join(host, name)).href);

async function fixture(action) {
  const directory = fs.mkdtempSync(path.join(root, 'tmp/native-fonts-test-'));
  try { return await action(directory); }
  finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(root, 'tmp'));
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

function nativeCatalog(api, enumerate, describe, io = {}) {
  const exports = {}, calls = [], errors = [];
  const fileIo = {
    OpenMode: {READ_WRITE: 2, CREATE: 64, TRUNC: 512},
    openSync(name) { calls.push(['open', name]); return {fd: fs.openSync(name, 'w')}; },
    writeSync(fd, value) { return fs.writeSync(fd, value); },
    closeSync(fd) { calls.push(['close']); fs.closeSync(fd); },
    renameSync(from, to) { calls.push(['rename', from, to]); fs.renameSync(from, to); },
    unlinkSync(name) { fs.unlinkSync(name); },
    ...io
  };
  const text = {SystemFontType: {ALL: 1},
    matchFontDescriptors: async value => { assert.deepEqual(Object.keys(value), []); calls.push(['match']); return enumerate(); },
    getSystemFontFullNamesByType: async type => { assert.equal(type, 1); calls.push(['names']); return enumerate(); },
    getFontDescriptorByFullName: async (name, type) => { assert.equal(type, 1); calls.push(['describe', name]); return describe(name); }};
  const kits = {'@kit.ArkGraphics2D': {text}, '@kit.BasicServicesKit': {deviceInfo: {sdkApiVersion: api}}, '@kit.CoreFileKit': {fileIo}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(catalogSource, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
  }).outputText, {exports, console: {error: message => errors.push(message)},
    require: name => { assert.ok(kits[name], name); return kits[name]; }});
  return {FontCatalog: exports.default, calls, errors};
}

test('API 18+ writes descriptor families atomically in application filesDir and coalesces startup calls', async () => {
  await fixture(async directory => {
    const {FONT_CATALOG_FILE} = await moduleAt('font-catalog.mjs');
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const native = nativeCatalog(26, () => pending);
    const first = native.FontCatalog.refresh({filesDir: directory});
    const second = native.FontCatalog.refresh({filesDir: directory});
    assert.equal(first, second);
    finish([{fontFamily: '中文字体'}, {fontFamily: ' Arial '}, {fontFamily: 'Arial'}, {fullName: 'No family'}]);
    await first;
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, FONT_CATALOG_FILE), 'utf8')),
      ['中文字体', ' Arial ', 'Arial']);
    assert.equal(native.calls.filter(call => call[0] === 'match').length, 1);
    assert.equal(native.calls.filter(call => call[0] === 'close').length, 1);
    assert.equal(native.calls.filter(call => call[0] === 'rename').length, 1);
    assert.deepEqual(fs.readdirSync(directory), [FONT_CATALOG_FILE]);
  });
  const entry = fs.readFileSync(path.join(root, 'harmony-electron/electron/src/main/ets/entryability/EntryAbility.ets'), 'utf8');
  assert.match(entry, /FontCatalog\.refresh\(this\.context\.getApplicationContext\(\)\)/);
});

test('API 17 uses API 14 full-name enumeration and descriptor family fields', async () => {
  await fixture(async directory => {
    const {FONT_CATALOG_FILE} = await moduleAt('font-catalog.mjs');
    const native = nativeCatalog(17, () => ['Family Regular', 'Family Bold'], name => ({fontFamily: name.split(' ')[0]}));
    await native.FontCatalog.refresh({filesDir: directory});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, FONT_CATALOG_FILE), 'utf8')), ['Family', 'Family']);
    assert.ok(!native.calls.some(call => call[0] === 'match'));
    assert.equal(native.calls.filter(call => call[0] === 'describe').length, 2);
  });
});

test('native write failure closes its handle and keeps the prior catalog intact', async () => {
  await fixture(async directory => {
    const {FONT_CATALOG_FILE} = await moduleAt('font-catalog.mjs');
    const target = path.join(directory, FONT_CATALOG_FILE);
    fs.writeFileSync(target, '["Previous"]');
    const native = nativeCatalog(26, () => [{fontFamily: 'New'}], undefined,
      {writeSync() { throw Error('disk full'); }});
    await native.FontCatalog.refresh({filesDir: directory});
    assert.equal(fs.readFileSync(target, 'utf8'), '["Previous"]');
    assert.equal(native.calls.filter(call => call[0] === 'close').length, 1);
    assert.equal(native.errors.length, 1);
    assert.deepEqual(fs.readdirSync(directory), [FONT_CATALOG_FILE]);
  });
});

test('the exact fc-list call feeds the unchanged upstream trim/deduplicate/sort function', async () => {
  await fixture(async directory => {
    const {createFontExecFile, FONT_CATALOG_FILE} = await moduleAt('font-catalog.mjs');
    fs.writeFileSync(path.join(directory, FONT_CATALOG_FILE), JSON.stringify(['中文字体', ' Arial ', '', 'Arial', 'Mono']));
    const execFile = createFontExecFile(() => { throw Error('unexpected process'); }, () => path.join(directory, FONT_CATALOG_FILE));
    const source = fs.readFileSync(path.join(host, 'upstream/src/main/electron.js'), 'utf8');
    const match = /^function getLocalFonts\(\)\r?\n\{[\s\S]*?^\}/m.exec(source);
    assert.ok(match);
    const getLocalFonts = vm.runInNewContext('(' + match[0] + ')', {execFile, process: {platform: 'openharmony'}});
    assert.deepEqual(Array.from(await getLocalFonts()), ['Arial', 'Mono', '中文字体'].sort((a, b) => a.localeCompare(b)));
  });
});

test('catalog readiness is asynchronous and malformed or missing catalogs finish with errors', async () => {
  await fixture(async directory => {
    const {createFontExecFile, FONT_CATALOG_FILE} = await moduleAt('font-catalog.mjs');
    const target = path.join(directory, FONT_CATALOG_FILE);
    const execFile = createFontExecFile(() => { throw Error('unexpected process'); }, () => target);
    const invoke = timeout => new Promise((resolve, reject) => execFile('fc-list', [format],
      {encoding: 'utf8', timeout}, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const reading = invoke(1000);
    const writer = setTimeout(() => fs.writeFileSync(target, '["Ready"]'), 10);
    try { assert.equal(await reading, 'Ready\n'); } finally { clearTimeout(writer); }
    fs.writeFileSync(target, '{"bad":true}');
    await assert.rejects(invoke(30), /catalog/i);
    fs.unlinkSync(target);
    await assert.rejects(invoke(20), error => error.code === 'ETIMEDOUT');
  });
});

test('other execFile arguments pass through with the native result and receiver', async () => {
  const {createFontExecFile} = await moduleAt('font-catalog.mjs');
  const token = {}, receiver = {}, calls = [];
  const original = function(...args) { calls.push({receiver: this, args}); return token; };
  const execFile = createFontExecFile(original, () => { throw Error('catalog must not be read'); });
  const callback = () => {};
  for (const args of [['other', [format], {encoding: 'utf8'}, callback],
    ['fc-list', ['--version'], {encoding: 'utf8'}, callback], ['fc-list', [format], {encoding: 'buffer'}, callback]]) {
    assert.equal(execFile.apply(receiver, args), token);
    assert.equal(calls.at(-1).receiver, receiver);
    assert.deepEqual(calls.at(-1).args, args);
  }
});

test('loader scope and real ESM facade preserve native spawn, CJS and unrelated execFile', async () => {
  await fixture(async directory => {
    const {createHostHooks} = await moduleAt('loader.mjs');
    const main = pathToFileURL(path.join(directory, 'main.mjs')).href;
    const facadeURL = pathToFileURL(path.join(host, 'child-process-facade.mjs')).href;
    const hook = createHostHooks(main), sentinel = {}, next = () => sentinel;
    assert.deepEqual(hook.resolve('child_process', {conditions: ['import'], parentURL: main}, next),
      {url: facadeURL, shortCircuit: true});
    assert.equal(hook.resolve('child_process', {conditions: ['require'], parentURL: main}, next), sentinel);
    assert.equal(hook.resolve('child_process', {conditions: ['import'], parentURL: main + '?other'}, next), sentinel);
    const {FONT_CATALOG_FILE} = await moduleAt('font-catalog.mjs');
    fs.writeFileSync(path.join(directory, FONT_CATALOG_FILE), '["System Family"]');
    const fake = path.join(directory, 'electron.cjs');
    fs.writeFileSync(fake, `exports.app={getPath(name){if(name!=='userData')throw Error(name);return ${JSON.stringify(directory)}}};`);
    const runner = path.join(directory, 'runner.mjs');
    fs.writeFileSync(runner, `
import assert from 'node:assert/strict';
import {registerHooks,createRequire} from 'node:module';
import native from 'node:child_process';
registerHooks({resolve(s,c,next){return s==='electron'?{url:${JSON.stringify(pathToFileURL(fake).href)},shortCircuit:true}:next(s,c)}});
const facade=await import(${JSON.stringify(facadeURL)});
assert.equal(facade.spawn,native.spawn);
assert.equal(facade.default.spawn,native.spawn);
assert.equal(createRequire(import.meta.url)('child_process').execFile,native.execFile);
const fonts=await new Promise((ok,no)=>facade.execFile('fc-list',[${JSON.stringify(format)}],{encoding:'utf8',timeout:1000},(e,s)=>e?no(e):ok(s)));
assert.equal(fonts,'System Family\\n');
const value=await new Promise((ok,no)=>facade.execFile(process.execPath,['-p','21*2'],{encoding:'utf8'},(e,s)=>e?no(e):ok(s)));
assert.equal(value.trim(),'42');
`);
    const result = spawnSync(process.execPath, [runner], {cwd: directory, env: {...process.env,
      TEMP: directory, TMP: directory, NODE_DISABLE_COMPILE_CACHE: '1'}, encoding: 'utf8', timeout: 15000});
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  });
});
