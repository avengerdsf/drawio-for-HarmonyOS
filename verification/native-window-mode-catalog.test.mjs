import { typeScriptPath } from './sdk-paths.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const ts = require(typeScriptPath());
const url = new URL('../harmony-electron/web_engine/src/main/ets/common/WindowModeCatalog.ets', import.meta.url);
function fixture(deviceType = 'tablet') {
  assert.ok(fs.existsSync(url), 'The OS window mode catalog must exist');
  const code = ts.transpileModule(fs.readFileSync(url, 'utf8'), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
  }).outputText;
  const files = new Map(), writes = [], observers = [], closed = [], registrations = [], unregistered = [];
  const applicationContext = {filesDir: 'E:/tmp/drawio/tmp/window-mode-catalog-app-files'};
  const context = {filesDir: 'E:/tmp/drawio/tmp/window-mode-catalog-ability-files', getApplicationContext: () => applicationContext};
  const secondContext = {filesDir: 'E:/tmp/drawio/tmp/window-mode-catalog-second-ability', getApplicationContext: () => applicationContext};
  let setting = 'false', registered = true, activeObserver;
  const fileIo = {OpenMode: {READ_WRITE: 1, CREATE: 2, TRUNC: 4},
    openSync: filename => ({fd: filename}), writeSync: (fd, text) => { files.set(fd, text); writes.push([fd, text]); },
    closeSync: fd => closed.push(fd), renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    unlinkSync: filename => files.delete(filename)};
  const modules = {'@kit.BasicServicesKit': {deviceInfo: {deviceType}, settings: {
    domainName: {USER_PROPERTY: 'USER_PROPERTY'},
    getValueSync: (ctx, key, fallback, domain) => {
      assert.ok(ctx === context || ctx === secondContext, 'Settings must receive a live UIAbilityContext');
      assert.equal(key, 'window_pcmode_switch_status'); assert.equal(domain, 'USER_PROPERTY');
      return setting ?? fallback;
    },
    registerKeyObserver: (ctx, key, domain, callback) => {
      assert.ok(ctx === context || ctx === secondContext, 'The settings observer must receive UIAbilityContext');
      registrations.push(ctx);
      if (!registered || activeObserver) return false;
      activeObserver = callback; observers.push(callback); return true;
    },
    unregisterKeyObserver: (ctx, key, domain) => {
      assert.ok(ctx === context || ctx === secondContext); assert.equal(key, 'window_pcmode_switch_status');
      assert.equal(domain, 'USER_PROPERTY'); unregistered.push(ctx); activeObserver = undefined; return true;
    }
  }}, '@kit.CoreFileKit': {fileIo}};
  const exports = {};
  vm.runInNewContext(code, {exports, console: {error() {}}, require: name => modules[name]});
  return {catalog: exports.default, context, secondContext, applicationContext, files, writes, observers, closed, registrations, unregistered,
    setSetting(value) { setting = value; }, failObserver() { registered = false; },
    read() { return JSON.parse(files.get(applicationContext.filesDir + '/diagramdesk-window-mode.json')); }};
}

test('startup synchronously seeds the actual normal Pad mode with atomic private writes before Node starts', () => {
  const run = fixture(); run.catalog.start(run.context);
  assert.deepEqual(run.read(), {normalPadMode: true});
  assert.equal(run.observers.length, 0, 'Startup does not compete with live-window subscriptions');
  assert.equal(run.closed.length, run.writes.length);
  assert.equal(run.files.has(run.context.filesDir + '/diagramdesk-window-mode.json'), false);
  assert.equal([...run.files.keys()].some(name => name.endsWith('.tmp')), false);
});

test('one OS setting observer updates normal and free modes without a second registration', () => {
  const run = fixture(); run.catalog.start(run.context); run.catalog.start(run.context);
  const received = [];
  run.catalog.subscribe(run.context, () => received.push(['first', run.read().normalPadMode]));
  run.catalog.subscribe(run.secondContext, () => received.push(['second', run.read().normalPadMode]));
  assert.equal(run.observers.length, 1);
  assert.equal(run.registrations.length, 1);
  run.setSetting('true'); run.observers[0](); assert.deepEqual(run.read(), {normalPadMode: false});
  assert.deepEqual(received, [['first', false], ['second', false]], 'The shared JSON is ready before live windows are notified');
  run.setSetting('false'); run.observers[0](); assert.deepEqual(run.read(), {normalPadMode: true});
});

test('2in1 hardware retains PC controls independently of Pad window setting values', () => {
  const run = fixture('2in1'); run.catalog.start(run.context);
  assert.deepEqual(run.read(), {normalPadMode: false});
});

test('foreground refresh reads the real setting even if observer registration failed', () => {
  const run = fixture(); run.failObserver(); run.catalog.start(run.context);
  let notified = 0; run.catalog.subscribe(run.context, () => notified++);
  run.setSetting('true'); run.catalog.refresh(run.context); assert.deepEqual(run.read(), {normalPadMode: false});
  assert.equal(notified, 1);
});

test('closing one live window keeps the other subscribed and the last close unregisters using its valid context', () => {
  const run = fixture(), calls = [];
  const closeFirst = run.catalog.subscribe(run.context, () => calls.push('first'));
  const closeSecond = run.catalog.subscribe(run.secondContext, () => calls.push('second'));
  closeFirst(); run.setSetting('true'); run.observers[0]();
  assert.deepEqual(calls, ['second']); assert.equal(run.unregistered.length, 0);
  closeSecond(); closeSecond(); assert.deepEqual(run.unregistered, [run.secondContext]);
});

test('late OS callbacks from a released generation cannot write or notify a later window', () => {
  const run = fixture(); let calls = 0;
  const stop = run.catalog.subscribe(run.context, () => calls++), earlier = run.observers[0];
  stop(); const count = run.writes.length; earlier();
  assert.equal(run.writes.length, count); assert.equal(calls, 0);
  run.catalog.subscribe(run.secondContext, () => calls++); earlier();
  assert.equal(calls, 0); run.observers[1](); assert.equal(calls, 1);
});

test('dispatch isolates callback exceptions and skips listeners removed during the same dispatch', () => {
  const run = fixture(), calls = []; let stopSecond;
  run.catalog.subscribe(run.context, () => { calls.push('first'); stopSecond(); throw Error('Destroyed window'); });
  stopSecond = run.catalog.subscribe(run.secondContext, () => calls.push('second'));
  run.catalog.subscribe(run.secondContext, () => calls.push('third'));
  assert.doesNotThrow(() => run.observers[0]()); assert.deepEqual(calls, ['first', 'third']);
});

test('entry lifecycle seeds the catalog and refreshes it on foreground; bootstrap uses its own userData file', () => {
  const entry = fs.readFileSync(new URL('../harmony-electron/electron/src/main/ets/entryability/EntryAbility.ets', import.meta.url), 'utf8');
  assert.match(entry, /WindowModeCatalog\.start\(this\.context\)/);
  assert.match(entry, /WindowModeCatalog\.refresh\(this\.context\)/);
  assert.match(entry, /import\s*\{[^}]*WindowModeCatalog[^}]*\}\s*from 'web_engine'/);
  const index = fs.readFileSync(new URL('../harmony-electron/web_engine/Index.ets', import.meta.url), 'utf8');
  assert.match(index, /default as WindowModeCatalog/);
  const ability = fs.readFileSync(new URL('../harmony-electron/web_engine/src/main/ets/ability/WebAbility.ets', import.meta.url), 'utf8');
  assert.match(ability, /WindowModeCatalog\.subscribe\(this\.context/);
  assert.doesNotMatch(ability, /settings\.registerKeyObserver/);
  assert.match(ability, /this\.captionStorage !== storage/);
  const bootstrap = fs.readFileSync(new URL('../harmony-electron/web_engine/src/main/resources/resfile/resources/app/bootstrap.mjs', import.meta.url), 'utf8');
  assert.match(bootstrap, /path\.join\(electron\.app\.getPath\('userData'\), 'diagramdesk-window-mode\.json'\)/);
});
