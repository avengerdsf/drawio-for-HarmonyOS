import { typeScriptPath } from './sdk-paths.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = path.join(root, 'harmony-electron');
const readJson = relative => JSON.parse(readFileSync(path.join(project, relative), 'utf8'));
const manifest = () => readJson('electron/src/main/module.json5').module;
const declarations = () => readJson(
  'electron/src/main/resources/rawfile/arkdata/utd/utd.json5'
).UniformDataTypeDeclarations;
const fileOpenSkills = ability => (ability.skills ?? []).filter(skill =>
  skill.uris?.some(uri => uri.linkFeature === 'FileOpen'));
const require = createRequire(import.meta.url);
const ts = require(typeScriptPath());
const native = path.join(project, 'web_engine/src/main/ets');

function methodCase(relative, className, methodNames, globals) {
  const text = readFileSync(path.join(native, relative), 'utf8')
    .replace(`export struct ${className}`, `export class ${className}`);
  const parsed = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find(node => ts.isClassDeclaration(node) &&
    node.name.text === className);
  assert.ok(declaration, 'Native class was not found: ' + className);
  const methods = declaration.members.filter(node => methodNames.includes(node.name?.getText(parsed)))
    .map(node => node.getText(parsed)).join('\n');
  assert.equal(declaration.members.filter(node => methodNames.includes(node.name?.getText(parsed))).length,
    methodNames.length);
  const compiled = ts.transpileModule('export class FileOpenCase { ' + methods + ' }', {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, {exports, ...globals});
  return new exports.FileOpenCase();
}

async function nodeHandleCase({uri = '', id = 'browser1', resolvedPath = '/shared/中文 A.drawio',
  uriError = false} = {}) {
  const runCalls = [], conversions = [], errors = [];
  const argumentsBeforeFile = ['electron', '--ozone-platform=ohos'];
  const commandLine = {
    appendArgs(args) { argumentsBeforeFile.push(...args); },
    appendSwitch(key, value) { argumentsBeforeFile.push('--' + key + '=' + value); },
    getArgs() { return [...argumentsBeforeFile]; }
  };
  const subject = methodCase('components/WebNodeHandleWindow.ets', 'WebNodeHandleWindow',
    ['aboutToAppear'], {
      WebNodeHandleWindow: {TAG: 'native-file-test'},
      LogUtil: {error(...args) { errors.push(args); }},
      CommandLineAdapter: {getInstance: () => commandLine},
      ConfigData: {DEFAULT_WINDOW_ID: 'browser1'},
      fileUri: {FileUri: class {
        constructor(value) {
          conversions.push(value);
          if (uriError) throw Error('Invalid uri');
          this.path = resolvedPath;
        }
      }},
      getContext: () => ({resourceDir: '/installed/resources'})
    });
  Object.assign(subject, {
    xComponentId: id, launchFileUri: uri, startUri: uri.replace('file://docs/', 'file:///'),
    cmdArgs: ['--enable-logging'], nodeContent: {},
    nativeContext: {OnAbilityStartedCB() {}, runBrowser(args) { runCalls.push([...args]); }},
    nodeHandleManager: {addNodeContent() {}}, contextAdapter: {setActiveWindow() {}},
    abilityManager: {addMessageBox() {}}, setMessageBoxParams: () => () => {},
    permissionManager: {initPermissions: () => Promise.resolve(), fileAccessPersist: () => Promise.resolve()},
    setDefaultBounds() {}, kBundleInstallDir: 'bundle-installation-dir'
  });
  subject.aboutToAppear();
  await new Promise(resolve => setImmediate(resolve));
  return {runCalls, conversions, argumentsBeforeFile, errors};
}

test('the first NodeHandle browser passes the system-resolved file path to original Electron argv', async () => {
  const uri = 'file://docs/storage/Users/currentUser/Download/drawio-test-tmp/%E4%B8%AD%E6%96%87%20A.drawio';
  const fixture = await nodeHandleCase({uri});
  assert.deepEqual(fixture.conversions, [uri]);
  assert.equal(fixture.runCalls.length, 1);
  assert.equal(fixture.runCalls[0].at(-1), '/shared/中文 A.drawio');
  assert.ok(!fixture.argumentsBeforeFile.includes('/shared/中文 A.drawio'),
    'The file path must not remain in the process-wide CommandLineAdapter');
});

test('a secondary NodeHandle window does not add its URL to process startup argv', async () => {
  const fixture = await nodeHandleCase({uri: 'file:///installed/export3.html', id: 'browser2'});
  assert.deepEqual(fixture.conversions, []);
  assert.deepEqual(fixture.runCalls[0], fixture.argumentsBeforeFile);
});

test('launcher and external URL starts leave file arguments empty', async () => {
  for (const uri of ['', 'https://example.test/diagram.drawio']) {
    const fixture = await nodeHandleCase({uri});
    assert.deepEqual(fixture.conversions, []);
    assert.deepEqual(fixture.runCalls[0], fixture.argumentsBeforeFile);
  }
});

test('invalid or nonabsolute system file paths do not crash browser startup or become CLI options', async () => {
  for (const options of [{uriError: true}, {resolvedPath: '--help'}, {resolvedPath: '/shared/bad\0.drawio'}]) {
    const fixture = await nodeHandleCase({uri: 'file://docs/bad.drawio', ...options});
    assert.equal(fixture.runCalls.length, 1);
    assert.deepEqual(fixture.runCalls[0], fixture.argumentsBeforeFile);
  }
});

test('ability startup retains the granted URI separately from the legacy navigation URL', () => {
  const uri = 'file://docs/storage/Users/currentUser/Download/drawio-test-tmp/中文%20A.drawio';
  const subject = methodCase('ability/WebBaseAbility.ets', 'WebBaseAbility', ['initParameters'], {
    LogUtil: {info() {}}, TAG: 'native-file-test'
  });
  subject.initParameters({uri, parameters: {}});
  assert.equal(subject.launchFileUri, uri);
  assert.equal(subject.startUri, uri.replace('file://docs/', 'file:///'));
});

test('the ability storage exposes the raw file URI under the NodeHandle storage binding', () => {
  const text = readFileSync(path.join(native, 'ability/WebAbility.ets'), 'utf8');
  const parsed = ts.createSourceFile('WebAbility.ets', text, ts.ScriptTarget.Latest, true);
  let initializer;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'para') {
      initializer = node.initializer.getText(parsed);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(initializer, 'Ability storage initializer was not found');
  const uri = 'file://docs/storage/Users/currentUser/Download/drawio-test-tmp/中文%20A.drawio';
  const storage = vm.runInNewContext('(function() { return ' + initializer + '; }).call(subject)', {
    subject: {launchFileUri: uri, getWindowPreferences: () => ({})},
    windowStage: {getMainWindowSync: () => ({getWindowStatus: () => 4})},
    WindowStyle: {registerUpdateStyleFunction() {}, removeUpdateStyleFunction() {}}
  });
  const nodeSource = readFileSync(path.join(native, 'components/WebNodeHandleWindow.ets'), 'utf8');
  const binding = nodeSource.match(/@LocalStorageLink\('([^']+)'\)\s+launchFileUri:/);
  assert.ok(binding, 'NodeHandle raw file URI storage binding was not found');
  assert.equal(storage[binding[1]], uri);
});

test('only the exported main ability advertises a separate FileOpen skill', () => {
  const module = manifest();
  const handlers = module.abilities.filter(ability => fileOpenSkills(ability).length > 0);
  assert.deepEqual(handlers.map(ability => ability.name), ['EntryAbility']);
  assert.equal(handlers[0].exported, true);
  const skills = fileOpenSkills(handlers[0]);
  assert.equal(skills.length, 1);
  assert.deepEqual(skills[0].actions, ['ohos.want.action.viewData']);
  assert.equal(skills[0].entities?.length ?? 0, 0);
  assert.ok(skills[0].uris.every(uri => uri.scheme === 'file'));
  assert.ok(skills[0].uris.every(uri => uri.linkFeature === 'FileOpen'));
  assert.equal(new Set(skills[0].uris.map(uri => uri.type)).size, 5);

  const launcher = handlers[0].skills.find(skill => skill.actions.includes('action.system.home'));
  assert.ok(launcher);
  assert.ok(!fileOpenSkills({ skills: [launcher] }).length);
  assert.ok(handlers[0].skills.some(skill => skill.uris?.some(uri => uri.scheme === 'link')));
});

test('drawio and dio suffixes have one valid application UTD declaration', () => {
  assert.equal(manifest().type, 'entry');
  const bundleName = readJson('AppScope/app.json5').app.bundleName;
  const types = declarations();
  assert.equal(types.length, 1);
  assert.ok(types[0].TypeId.startsWith(bundleName + '.'));
  assert.deepEqual(types[0].BelongingToTypes, ['general.xml']);
  assert.deepEqual([...types[0].FilenameExtensions].sort(), ['.dio', '.drawio']);
  assert.equal(new Set(types[0].FilenameExtensions).size, 2);
  assert.deepEqual(types[0].MIMETypes, ['application/vnd.jgraph.mxfile']);
});

test('declared file handlers cover the six formats without claiming unrelated files or URLs', () => {
  const types = declarations();
  const typeForSuffix = new Map([
    ['.xml', 'general.xml'],
    ['.png', 'general.png'],
    ['.svg', 'general.svg-image'],
    ['.pdf', 'com.adobe.pdf'],
    ['.txt', 'general.plain-text']
  ]);
  for (const type of types) {
    for (const suffix of type.FilenameExtensions) typeForSuffix.set(suffix, type.TypeId);
  }

  const module = manifest();
  const matchingAbilities = (scheme, suffix) => module.abilities.filter(ability =>
    ability.exported && fileOpenSkills(ability).some(skill =>
      skill.actions.includes('ohos.want.action.viewData') && skill.uris.some(uri =>
        uri.scheme === scheme && uri.type === typeForSuffix.get(suffix))));

  for (const suffix of ['.drawio', '.dio', '.xml', '.png', '.svg', '.pdf']) {
    assert.deepEqual(matchingAbilities('file', suffix).map(ability => ability.name),
      ['EntryAbility'], suffix);
  }
  for (const suffix of ['.txt', '.unknown']) {
    assert.deepEqual(matchingAbilities('file', suffix), [], suffix);
  }
  assert.deepEqual(matchingAbilities('https', '.drawio'), []);
  assert.ok(module.abilities.flatMap(fileOpenSkills).flatMap(skill => skill.uris)
    .every(uri => !['*/*', 'general.file', 'general.image', 'general.text'].includes(uri.type)));
});
