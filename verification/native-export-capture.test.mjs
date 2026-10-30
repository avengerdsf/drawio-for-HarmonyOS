import assert from 'node:assert/strict';
import test from 'node:test';
import {withoutSystemFrame} from '../harmony-electron/web_engine/src/main/resources/resfile/resources/app/electron-compat.mjs';

const exportOptions = offscreen => ({show: false, enableLargerThanScreen: true,
  webPreferences: {offscreen}});

class CapturedImage {
  constructor(width, height, squareWidth = 200, squareHeight = 200) {
    this.width = width;
    this.height = height;
    this.squareWidth = squareWidth;
    this.squareHeight = squareHeight;
  }
  resize({width, height}) {
    return new CapturedImage(width, height, this.squareWidth * width / this.width,
      this.squareHeight * height / this.height);
  }
}

// Models the external native minimum and DPR-2 capture boundary, not draw.io rendering.
class NativeWindow {
  constructor(options) {
    this.options = options;
    this.actual = {width: 320, height: 240};
    this.boundsCalls = [];
    this.captureCalls = [];
  }
  setBounds(...args) {
    this.boundsThis = this;
    this.boundsCalls.push(args);
    if (this.boundsError) throw this.boundsError;
    const bounds = args[0];
    this.actual.width = Math.max(320, bounds.width ?? this.actual.width);
    this.actual.height = Math.max(240, bounds.height ?? this.actual.height);
    return this.boundsResult;
  }
  capturePage(...args) {
    this.captureThis = this;
    this.captureCalls.push(args);
    if (this.captureError) throw this.captureError;
    const bounds = args[0] ?? this.actual;
    return this.captureResult ?? Promise.resolve(new CapturedImage(bounds.width * 2, bounds.height * 2));
  }
}

test('the native minimum reproduces 100-square distortion when a full frame is resized', async () => {
  const window = new NativeWindow(exportOptions({deviceScaleFactor: 2}));
  window.setBounds({width: 284, height: 224});
  const result = (await window.capturePage()).resize({width: 284, height: 224});
  assert.equal(Math.round(result.squareWidth), 89);
  assert.equal(Math.round(result.squareHeight), 93);
});

test('the original hidden export captures requested bounds and keeps its 100-square geometry', async () => {
  const BrowserWindow = withoutSystemFrame(NativeWindow);
  for (const offscreen of [{deviceScaleFactor: 2}, true]) {
    const window = new BrowserWindow(exportOptions(offscreen));
    assert.ok(window instanceof NativeWindow);
    window.setBounds({width: 284, height: 224});
    const result = (await window.capturePage()).resize({width: 284, height: 224});
    assert.equal(result.squareWidth, 100);
    assert.equal(result.squareHeight, 100);
    assert.deepEqual(window.captureCalls[0], [{x: 0, y: 0, width: 284, height: 224}]);
  }
});

test('visible windows and windows outside the original export option shape keep full-frame capture', async () => {
  const BrowserWindow = withoutSystemFrame(NativeWindow);
  for (const options of [
    {...exportOptions(true), show: true}, {show: false},
    {show: false, webPreferences: {offscreen: true}},
    exportOptions(false), exportOptions(null), exportOptions('true'), exportOptions([])
  ]) {
    const window = new BrowserWindow(options);
    assert.equal(window.capturePage, NativeWindow.prototype.capturePage);
    assert.equal(window.setBounds, NativeWindow.prototype.setBounds);
    window.setBounds({width: 284, height: 224});
    await window.capturePage();
    assert.deepEqual(window.captureCalls[0], []);
  }
});

test('explicit rectangles, omitted rectangle with options, native receivers and return values are preserved', () => {
  const BrowserWindow = withoutSystemFrame(NativeWindow);
  const window = new BrowserWindow(exportOptions(true));
  const bounds = {width: 284, height: 224};
  const boundsResult = {};
  window.boundsResult = boundsResult;
  assert.equal(window.setBounds(bounds, true, 'extra'), boundsResult);
  assert.equal(window.boundsThis, window);
  assert.deepEqual(window.boundsCalls[0], [bounds, true, 'extra']);
  const rectangle = {x: 4, y: 5, width: 20, height: 30};
  const options = {stayHidden: true, stayAwake: false};
  const captureResult = Promise.resolve({});
  window.captureResult = captureResult;
  assert.equal(window.capturePage(rectangle, options), captureResult);
  assert.equal(window.captureThis, window);
  assert.equal(window.captureCalls[0][0], rectangle);
  assert.equal(window.captureCalls[0][1], options);
  assert.equal(window.capturePage(undefined, options), captureResult);
  assert.deepEqual(window.captureCalls[1], [undefined, options]);
});

test('only a normally returned complete size updates the default capture rectangle', async () => {
  const BrowserWindow = withoutSystemFrame(NativeWindow);
  const window = new BrowserWindow(exportOptions(true));
  await window.capturePage();
  assert.deepEqual(window.captureCalls[0], []);
  const bounds = {width: 284, height: 224};
  window.setBounds(bounds);
  bounds.width = 900;
  window.setBounds({x: 100, y: 200});
  const failure = Error('native resize refused');
  window.boundsError = failure;
  assert.throws(() => window.setBounds({width: 900, height: 800}), error => error === failure);
  window.boundsError = undefined;
  await window.capturePage();
  assert.deepEqual(window.captureCalls[1], [{x: 0, y: 0, width: 284, height: 224}]);
  window.setBounds({width: 600, height: 500});
  await window.capturePage();
  assert.deepEqual(window.captureCalls[2], [{x: 0, y: 0, width: 600, height: 500}]);
});

test('native capture exceptions and borrowed method receivers remain unchanged', async () => {
  const BrowserWindow = withoutSystemFrame(NativeWindow);
  const owner = new BrowserWindow(exportOptions(true));
  owner.setBounds({width: 284, height: 224});
  const failure = Error('native capture refused');
  owner.captureError = failure;
  assert.throws(() => owner.capturePage(), error => error === failure);
  const other = new NativeWindow({show: true});
  owner.setBounds.call(other, {width: 400, height: 300});
  await owner.capturePage.call(other);
  assert.equal(other.captureThis, other);
  assert.deepEqual(other.captureCalls[0], []);
});
