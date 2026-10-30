import { typeScriptPath } from './sdk-paths.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = path.join(root, 'harmony-electron/web_engine/src/main/ets');
const require = createRequire(import.meta.url);
const ts = require(typeScriptPath());
const folder = 'file://docs/storage/Users/currentUser/Download/drawio-test-tmp';
const first = folder + '/native-open.drawio';
const second = folder + '/second.drawio';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => {resolve = accept; reject = fail;});
  return {promise, resolve, reject};
}
function methodCase(relative, className, methods, globals) {
  const text = fs.readFileSync(path.join(native, relative), 'utf8')
    .replace(`export struct ${className}`, `export class ${className}`);
  const parsed = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name.text === className);
  const body = declaration.members.filter(node => methods.includes(node.name?.getText(parsed)))
    .map(node => node.getText(parsed).replace(/^@LogMethod\s*/, '')).join('\n');
  const compiled = ts.transpileModule('export class Subject { ' + body + ' }', {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {exports, ...globals});
  return new exports.Subject();
}
function permissionCase({initial = {}, persist, activate, flush, check} = {}) {
  const records = new Map(Object.entries(initial));
  const systemRights = new Map();
  for (const stored of Object.values(initial)) {
    for (const uri of JSON.parse(stored)) systemRights.set(uri, 3);
  }
  const persisted = [], activated = [], errors = [];
  const prefs = {
    getSync: (key, fallback) => records.has(key) ? records.get(key) : fallback,
    putSync: (key, value) => records.set(key, value),
    flush(callback) {
      const pending = flush ? flush() : Promise.resolve();
      if (callback) {pending.then(() => callback()); return;}
      return pending;
    }
  };
  const subject = methodCase('adapter/PermissionManagerAdapter.ets', 'PermissionManagerAdapter',
    ['initPermissions', 'saveUris', 'getUris', 'activateFileAccessPersist', 'fileAccessPersist'], {
      dataPreferences: null, options: {name: 'myStore'}, ACTIVATE_SUCCESS: 1, EMPTY_ARRAY: -1,
      TAG: 'permission-test', REQUEST_PERMISSION_FAIL: -2,
      LogUtil: {error(...args) {errors.push(args);}, info() {}},
      preferences: {getPreferencesSync: () => prefs},
      fileShare: {OperationMode: {READ_MODE: 1, WRITE_MODE: 2},
        checkPersistentPermission(policies) {
          return check ? check(policies) : Promise.resolve(policies.map(policy =>
            ((systemRights.get(policy.uri) ?? 0) & policy.operationMode) === policy.operationMode));
        },
        persistPermission(policies) {
          persisted.push(JSON.parse(JSON.stringify(policies)));
          return (persist ? persist(policies) : Promise.resolve()).then(() => {
            for (const policy of policies) systemRights.set(policy.uri,
              (systemRights.get(policy.uri) ?? 0) | policy.operationMode);
          });
        },
        activatePermission(policies) {
          activated.push(JSON.parse(JSON.stringify(policies)));
          return activate ? activate(policies) : Promise.resolve();
        }}
    });
  Object.assign(subject, {ctxAdapter: {getContext: () => ({})}, isInitialized: false});
  return {subject, records, persisted, activated, errors};
}

test('Picker persistence merges earlier URI records without changing the legacy download preference', async () => {
  const run = permissionCase({initial: {
    defaultDownloadUri: JSON.stringify(['file://docs/storage/Users/currentUser/OldDownloads']),
    persistedFileUris: JSON.stringify([first])
  }});
  await run.subject.fileAccessPersist([second, second]);
  assert.deepEqual(JSON.parse(run.records.get('persistedFileUris')), [first, second]);
  assert.deepEqual(JSON.parse(run.records.get('defaultDownloadUri')),
    ['file://docs/storage/Users/currentUser/OldDownloads']);
  assert.deepEqual(run.persisted, [[{uri: second, operationMode: 3}]]);
  run.subject.saveUris(['file://docs/storage/Users/currentUser/NewDownloads']);
  assert.deepEqual(JSON.parse(run.records.get('defaultDownloadUri')),
    ['file://docs/storage/Users/currentUser/NewDownloads']);
  assert.deepEqual(JSON.parse(run.records.get('persistedFileUris')), [first, second]);
});

test('persistence waits for both the system result and durable preference flush', async () => {
  const system = deferred(), disk = deferred();
  const run = permissionCase({persist: () => system.promise, flush: () => disk.promise});
  let completed = false;
  const pending = Promise.resolve(run.subject.fileAccessPersist([first])).then(() => {completed = true;});
  await tick();
  assert.equal(completed, false);
  assert.equal(run.records.has('persistedFileUris'), false);
  system.resolve();
  await tick();
  assert.equal(completed, false);
  assert.deepEqual(JSON.parse(run.records.get('persistedFileUris')), [first]);
  disk.resolve();
  await pending;
  assert.equal(completed, true);
});

test('a failed persistence result is logged and never recorded as a restored grant', async () => {
  const run = permissionCase({persist: () => Promise.reject({code: 13900001})});
  await run.subject.fileAccessPersist([first]);
  assert.equal(run.records.has('persistedFileUris'), false);
  assert.ok(run.errors.length > 0);
});

test('a read-only Picker grant is persisted as READ and remembered after RW is refused', async () => {
  const run = permissionCase({persist: policies => policies[0].operationMode === 3 ?
    Promise.reject({code: 13900001}) : Promise.resolve()});
  await run.subject.fileAccessPersist([first]);
  assert.deepEqual(run.persisted, [[{uri: first, operationMode: 3}], [{uri: first, operationMode: 1}]]);
  assert.deepEqual(JSON.parse(run.records.get('persistedFileUris')), [first]);
});

test('a refused Picker URI does not discard another successfully persisted URI', async () => {
  const run = permissionCase({persist: policies => policies[0].uri === first ?
    Promise.reject({code: 13900001}) : Promise.resolve()});
  await run.subject.fileAccessPersist([first, second]);
  assert.deepEqual(JSON.parse(run.records.get('persistedFileUris')), [second]);
});

test('startup activates only READ when that is the persisted mode', async () => {
  const run = permissionCase({initial: {persistedFileUris: JSON.stringify([first])},
    check: policies => Promise.resolve([policies[0].operationMode === 1])});
  await run.subject.initPermissions();
  assert.deepEqual(run.activated, [[{uri: first, operationMode: 1}]]);
  assert.equal(run.subject.isInitialized, true);
});

test('a stale URI is skipped and another URI still reaches activation', async () => {
  const run = permissionCase({initial: {persistedFileUris: JSON.stringify([first, second])},
    check: policies => Promise.resolve([policies[0].uri !== first])});
  await run.subject.initPermissions();
  assert.deepEqual(run.activated, [[{uri: second, operationMode: 3}]]);
  assert.ok(run.errors.length > 0);
});

test('an activation exception for one URI does not block later valid URIs', async () => {
  const run = permissionCase({initial: {persistedFileUris: JSON.stringify([first, second])},
    activate: policies => policies[0].uri === first ? Promise.reject({code: 13900001}) : Promise.resolve()});
  await run.subject.initPermissions();
  assert.deepEqual(run.activated, [[{uri: first, operationMode: 3}], [{uri: second, operationMode: 3}]]);
  assert.ok(run.errors.length > 0);
});

test('startup activation waits for the merged legacy and Picker grant set', async () => {
  const activation = deferred();
  const run = permissionCase({initial: {
    defaultDownloadUri: JSON.stringify([folder]), persistedFileUris: JSON.stringify([folder, first])
  }, activate: () => activation.promise});
  let ready = false;
  const pending = run.subject.initPermissions().then(() => {ready = true;});
  await tick();
  assert.equal(ready, false);
  assert.deepEqual(run.activated, [[{uri: folder, operationMode: 3}]]);
  activation.resolve();
  await pending;
  assert.equal(ready, true);
  assert.deepEqual(run.activated, [[{uri: folder, operationMode: 3}], [{uri: first, operationMode: 3}]]);
});

test('empty startup is ready without a failing empty policy request', async () => {
  const run = permissionCase();
  await run.subject.initPermissions();
  assert.equal(run.subject.isInitialized, true);
  assert.deepEqual(run.activated, []);
  assert.deepEqual(run.errors, []);
});

test('concurrent startup calls share activation and a rejection releases startup for a retry', async () => {
  const activation = deferred();
  let fail = true;
  const run = permissionCase({initial: {persistedFileUris: JSON.stringify([first])},
    activate: () => fail ? activation.promise : Promise.resolve()});
  const one = run.subject.initPermissions(), two = run.subject.initPermissions();
  await tick();
  assert.equal(run.activated.length, 1);
  activation.reject({code: 801});
  await Promise.all([one, two]);
  assert.equal(run.subject.isInitialized, false);
  assert.ok(run.errors.length > 0);
  fail = false;
  await run.subject.initPermissions();
  assert.equal(run.subject.isInitialized, true);
  assert.equal(run.activated.length, 2);
});

test('NodeHandle does not start the main Node process before activation is ready', async () => {
  const ready = deferred(), calls = [];
  const subject = methodCase('components/WebNodeHandleWindow.ets', 'WebNodeHandleWindow', ['aboutToAppear'], {
    WebNodeHandleWindow: {TAG: 'window-test'}, LogUtil: {error() {}},
    CommandLineAdapter: {getInstance: () => ({appendArgs() {}, appendSwitch() {}, getArgs: () => ['electron']})},
    ConfigData: {DEFAULT_WINDOW_ID: 'browser1'}, getContext: () => ({resourceDir: '/installed/resources'})
  });
  Object.assign(subject, {xComponentId: 'browser1', launchFileUri: '', cmdArgs: [], nodeContent: {},
    nativeContext: {OnAbilityStartedCB() {}, runBrowser(args) {calls.push([...args]);}},
    nodeHandleManager: {addNodeContent() {}}, contextAdapter: {setActiveWindow() {}},
    abilityManager: {addMessageBox() {}}, setMessageBoxParams: () => () => {}, setDefaultBounds() {},
    permissionManager: {initPermissions: () => ready.promise}});
  subject.aboutToAppear();
  await tick();
  assert.deepEqual(calls, []);
  ready.resolve();
  await tick();
  assert.deepEqual(calls, [['electron']]);
});

test('the first external Want records its raw grant before restoration and Node argv delivery', async () => {
  const registration = deferred(), activation = deferred(), events = [];
  const subject = methodCase('components/WebNodeHandleWindow.ets', 'WebNodeHandleWindow', ['aboutToAppear'], {
    WebNodeHandleWindow: {TAG: 'window-test'}, LogUtil: {error() {}},
    CommandLineAdapter: {getInstance: () => ({appendArgs() {}, appendSwitch() {}, getArgs: () => ['electron']})},
    ConfigData: {DEFAULT_WINDOW_ID: 'browser1'}, getContext: () => ({resourceDir: '/installed/resources'}),
    fileUri: {FileUri: class {constructor() {this.path = '/shared/native-open.drawio';}}}
  });
  Object.assign(subject, {xComponentId: 'browser1', launchFileUri: first, cmdArgs: [], nodeContent: {},
    nativeContext: {OnAbilityStartedCB() {}, runBrowser(args) {events.push(['run', ...args]);}},
    nodeHandleManager: {addNodeContent() {}}, contextAdapter: {setActiveWindow() {}},
    abilityManager: {addMessageBox() {}}, setMessageBoxParams: () => () => {}, setDefaultBounds() {},
    permissionManager: {
      fileAccessPersist(uris) {events.push(['remember', ...uris]); return registration.promise;},
      initPermissions() {events.push(['restore']); return activation.promise;}
    }});
  subject.aboutToAppear();
  await tick();
  assert.deepEqual(events, [['remember', first]]);
  registration.resolve();
  await tick();
  assert.deepEqual(events, [['remember', first], ['restore']]);
  activation.resolve();
  await tick();
  assert.deepEqual(events, [['remember', first], ['restore'], ['run', 'electron', '/shared/native-open.drawio']]);
});

test('a system-persisted URI absent from the registry is remembered without requiring a new temporary grant', async () => {
  const run = permissionCase({check: () => Promise.resolve([true]),
    persist: () => Promise.reject({code: 13900001})});
  await run.subject.fileAccessPersist([first]);
  assert.deepEqual(JSON.parse(run.records.get('persistedFileUris')), [first]);
  assert.deepEqual(run.persisted, []);
});

test('a newly remembered URI invalidates the earlier empty startup readiness', async () => {
  const run = permissionCase();
  await run.subject.initPermissions();
  assert.equal(run.subject.isInitialized, true);
  await run.subject.fileAccessPersist([first]);
  await run.subject.initPermissions();
  assert.deepEqual(run.activated, [[{uri: first, operationMode: 3}]]);
});

function pickerCase(mode, selected, permissionManager) {
  const calls = [];
  const subject = methodCase('adapter/DialogAdapter.ets', 'DialogAdapter', ['showOpenDialog', 'showSaveDialog'], {
    LogUtil: {info() {}, error() {}}, TAG: 'picker-test',
    DialogAdapter: {MAX_SELECT_NUMBER: 500},
    picker: {DocumentSelectOptions: class {}, DocumentSaveOptions: class {},
      DocumentViewPicker: class {
        select() {return Promise.resolve(selected);}
        save() {return Promise.resolve(selected);}
      }}
  });
  Object.assign(subject, {ctxAdapter: {getContext: () => ({resourceManager: {getStringSync: () => 'all'}})},
    permissionManager, handleDefaultPath: () => ['file://docs/storage/Users/currentUser', 'test.drawio']});
  const settings = JSON.stringify({default_path: '', filters: []});
  subject[mode](settings, (...args) => calls.push(args));
  return calls;
}

test('open and save Picker callbacks wait for raw URI persistence without changing their result', async () => {
  for (const mode of ['showOpenDialog', 'showSaveDialog']) {
    const persisted = deferred(), inputs = [];
    const calls = pickerCase(mode, [first], {fileAccessPersist(uris) {inputs.push(Array.from(uris)); return persisted.promise;}});
    await tick();
    assert.deepEqual(calls, []);
    assert.deepEqual(inputs, [[first]]);
    persisted.resolve();
    await tick();
    assert.equal(calls.length, 1);
    assert.deepEqual(Array.from(calls[0][0] instanceof Array ? calls[0][0] : [calls[0][0]]), [first]);
    assert.equal(calls[0][1], false);
  }
});

test('cancelled Pickers do not change the remembered grant set', async () => {
  for (const mode of ['showOpenDialog', 'showSaveDialog']) {
    const calls = pickerCase(mode, [], {fileAccessPersist() {assert.fail('Cancelled Picker attempted persistence');}});
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], true);
  }
});
