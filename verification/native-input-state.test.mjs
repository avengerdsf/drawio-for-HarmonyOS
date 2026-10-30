import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import test from 'node:test';

const moduleURL = new URL('../harmony-electron/web_engine/src/main/resources/resfile/resources/app/native-input-state.mjs', import.meta.url);
const {installNativeInputState} = fs.existsSync(moduleURL) ? await import(moduleURL.href) : {};
const editorURL = 'file:///bundle/upstream/drawio/src/main/webapp/index.html';

function fixture() {
  assert.equal(typeof installNativeInputState, 'function', 'Native modifier blur release is not implemented');
  const app = new EventEmitter(), dispose = installNativeInputState(app, editorURL);
  function create(url = editorURL + '?mode=device', frameURL = url) {
    const window = new EventEmitter(), contents = new EventEmitter(), sent = [];
    window.webContents = contents;
    window.focused = true;
    window.isFocused = () => window.focused;
    const emit = window.emit.bind(window);
    window.emit = (type, ...args) => {
      if (type === 'blur') window.focused = false;
      if (type === 'focus') window.focused = true;
      return emit(type, ...args);
    };
    contents.getURL = () => url;
    contents.mainFrame = {url: frameURL};
    const pasted = [];
    contents.paste = () => pasted.push('native-paste');
    contents.sendInputEvent = input => { if (window.focused) sent.push(structuredClone(input)); };
    app.emit('browser-window-created', {}, window);
    return {window, contents, sent, pasted};
  }
  function input(view, code, type = 'keyDown', extra = {}) {
    view.contents.emit('before-input-event', {preventDefault() { assert.fail('Input must pass through unchanged'); }}, {code, type, ...extra});
  }
  return {app, dispose, create, input};
}

function capturedInput(view, input) {
  let prevented = 0;
  view.contents.emit('before-input-event', {preventDefault() { prevented++; }}, input);
  return prevented;
}

test('ordinary keys and modifier flags without a real modifier key press are untouched', () => {
  const run = fixture(), view = run.create();
  for (const code of ['KeyN', 'KeyV', 'KeyA', 'Digit4', 'ArrowLeft']) run.input(view, code, 'keyDown', {control: true, modifiers: ['control']});
  view.window.emit('blur');
  assert.deepEqual(view.sent, []);
  run.dispose();
});

test('blur queues modifiers and focus releases once when native input requires a focused window', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ControlLeft');
  run.input(view, 'ControlLeft', 'keyDown', {isAutoRepeat: true});
  run.input(view, 'ShiftRight', 'rawKeyDown');
  assert.deepEqual(view.sent, []);
  view.window.emit('blur');
  run.app.emit('browser-window-blur', {}, view.window);
  view.window.emit('blur');
  assert.deepEqual(view.sent, []);
  view.window.emit('focus');
  run.app.emit('browser-window-focus', {}, view.window);
  view.window.emit('focus');
  assert.deepEqual(view.sent, [
    {type: 'keyUp', keyCode: 'Control', modifiers: ['left']},
    {type: 'keyUp', keyCode: 'Shift', modifiers: ['right']}
  ]);
  run.dispose();
});

test('modifiers already released before blur are not injected again', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ControlRight'); run.input(view, 'ControlRight', 'keyUp');
  view.window.emit('blur'); view.window.emit('focus');
  assert.deepEqual(view.sent, []);
  run.dispose();
});

test('application-level native window blur releases only that window', () => {
  const run = fixture(), first = run.create(), second = run.create();
  run.input(first, 'ControlLeft'); run.input(second, 'MetaRight');
  first.window.focused = false;
  run.app.emit('browser-window-blur', {}, first.window);
  assert.deepEqual(first.sent, []);
  first.window.emit('focus');
  assert.deepEqual(first.sent, [{type: 'keyUp', keyCode: 'Control', modifiers: ['left']}]);
  assert.deepEqual(second.sent, []);
  second.window.emit('blur');
  second.window.emit('focus');
  assert.deepEqual(second.sent, [{type: 'keyUp', keyCode: 'Meta', modifiers: ['right']}]);
  run.dispose();
});

test('all eight modifier sides are bounded to supported KeyUp events', () => {
  const run = fixture(), view = run.create();
  const codes = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];
  for (const code of codes) run.input(view, code);
  view.window.emit('blur');
  view.window.emit('focus');
  assert.deepEqual(view.sent, codes.map(code => ({type: 'keyUp', keyCode: code.replace(/Left|Right/, ''), modifiers: [code.endsWith('Left') ? 'left' : 'right']})));
  run.dispose();
});

test('a later genuine press can release once after an earlier blur', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'AltLeft'); view.window.emit('blur'); view.window.emit('focus');
  run.input(view, 'AltLeft'); view.window.emit('blur'); view.window.emit('focus');
  assert.equal(view.sent.length, 2);
  run.dispose();
});

test('destroyed contents remove every owned listener without injecting input', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ControlLeft'); view.contents.emit('destroyed');
  assert.equal(view.contents.listenerCount('before-input-event'), 0);
  assert.equal(view.contents.listenerCount('destroyed'), 0);
  assert.equal(view.window.listenerCount('blur'), 0);
  assert.equal(view.window.listenerCount('closed'), 0);
  run.app.emit('browser-window-blur', {}, view.window);
  assert.deepEqual(view.sent, []);
  run.dispose();
});

test('closed windows and uninstall remove their listeners and never release outside blur', () => {
  const run = fixture(), first = run.create(), second = run.create();
  run.input(first, 'ControlLeft'); first.window.emit('closed');
  assert.equal(first.contents.listenerCount('before-input-event'), 0);
  run.input(second, 'ShiftLeft'); run.dispose(); run.dispose();
  assert.equal(run.app.listenerCount('browser-window-created'), 0);
  assert.equal(run.app.listenerCount('browser-window-blur'), 0);
  assert.equal(second.contents.listenerCount('before-input-event'), 0);
  assert.equal(second.window.listenerCount('blur'), 0);
  assert.deepEqual([...first.sent, ...second.sent], []);
});

test('a native injection error does not escape blur or prevent another modifier release', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ControlLeft'); run.input(view, 'AltRight');
  let calls = 0;
  view.contents.sendInputEvent = input => { calls++; if (input.keyCode === 'Control') throw Error('Native input unavailable'); view.sent.push(input); };
  view.window.emit('blur');
  assert.doesNotThrow(() => view.window.emit('focus'));
  assert.deepEqual(view.sent, [{type: 'keyUp', keyCode: 'Alt', modifiers: ['right']}]);
  view.window.emit('focus');
  assert.equal(calls, 2);
  run.dispose();
});

test('char events, unknown codes and duplicate creation do not widen input handling', () => {
  const run = fixture(), view = run.create();
  run.app.emit('browser-window-created', {}, view.window);
  assert.equal(view.contents.listenerCount('before-input-event'), 1);
  run.input(view, 'ControlLeft', 'char'); run.input(view, 'UnknownControl', 'keyDown');
  view.window.emit('blur');
  assert.deepEqual(view.sent, []);
  run.dispose();
});

test('each actual missing-down V release pastes once while Control remains held', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ControlLeft');
  run.input(view, 'KeyV', 'keyUp', {control: true, alt: false, meta: false});
  run.input(view, 'KeyV', 'keyUp', {control: true});
  assert.deepEqual(view.pasted, ['native-paste', 'native-paste']);
  assert.deepEqual(view.sent, []);
  run.dispose();
});

test('an observed VDown leaves the entire original paste path untouched', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ControlLeft');
  run.input(view, 'KeyV', 'keyDown', {control: true});
  run.input(view, 'KeyV', 'keyUp', {control: true});
  assert.deepEqual(view.pasted, []);
  assert.deepEqual(view.sent, []);
  run.dispose();
});

test('VUp without a fresh real Control press or with Alt/Meta never pastes', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'KeyV', 'keyUp', {control: true});
  run.input(view, 'ControlLeft');
  run.input(view, 'KeyV', 'keyUp', {control: false});
  run.input(view, 'KeyV', 'keyUp', {control: true, alt: true});
  run.input(view, 'KeyV', 'keyUp', {control: true, meta: true});
  run.input(view, 'KeyV', 'keyUp', {control: true, shift: true});
  assert.deepEqual(view.pasted, []);
  run.dispose();
});

test('ControlUp and native window blur end the compensation cycle', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ControlLeft'); run.input(view, 'ControlLeft', 'keyUp');
  run.input(view, 'KeyV', 'keyUp', {control: true});
  assert.deepEqual(view.pasted, []);
  run.input(view, 'ControlLeft'); view.window.emit('blur');
  view.window.emit('focus');
  run.input(view, 'KeyV', 'keyUp', {control: true});
  assert.deepEqual(view.pasted, []);
  run.input(view, 'ControlLeft'); run.input(view, 'KeyV', 'keyUp', {control: true});
  assert.deepEqual(view.pasted, ['native-paste']);
  run.dispose();
});

test('both the webContents URL and main frame URL must be the exact original editor', () => {
  const run = fixture();
  for (const view of [run.create('https://example.invalid/'), run.create(editorURL, 'https://example.invalid/'),
    run.create(editorURL + '.other')]) {
    run.input(view, 'ControlLeft'); run.input(view, 'KeyV', 'keyUp', {control: true});
    assert.deepEqual(view.pasted, []);
  }
  run.dispose();
});

test('a currently unfocused window cannot compensate missing VDown', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ControlLeft'); view.window.focused = false;
  run.input(view, 'KeyV', 'keyUp', {control: true});
  assert.deepEqual(view.pasted, []);
  run.dispose();
});

test('each new genuine Control cycle may compensate once without replaying ordinary keys', () => {
  const run = fixture(), view = run.create();
  for (let i = 0; i < 2; i++) {
    run.input(view, 'ControlRight'); run.input(view, 'KeyV', 'keyUp', {control: true});
    run.input(view, 'ControlRight', 'keyUp');
  }
  assert.equal(view.pasted.length, 2);
  assert.deepEqual(view.sent, []);
  run.dispose();
});

test('a native paste error does not escape and each later actual release remains independent', () => {
  const run = fixture(), view = run.create(); let calls = 0;
  view.contents.paste = () => { calls++; throw Error('Native paste failed'); };
  run.input(view, 'ControlLeft');
  assert.doesNotThrow(() => run.input(view, 'KeyV', 'keyUp', {control: true}));
  run.input(view, 'KeyV', 'keyUp', {control: true});
  assert.equal(calls, 2);
  assert.deepEqual(view.sent, []);
  run.dispose();
});

test('a real new press before focus cancels the stale pending release for that same modifier', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ControlLeft'); view.window.emit('blur');
  view.window.focused = true;
  run.input(view, 'ControlLeft'); view.window.emit('focus');
  assert.deepEqual(view.sent, []);
  run.input(view, 'ControlLeft', 'keyUp');
  view.window.emit('blur'); view.window.emit('focus');
  assert.deepEqual(view.sent, []);
  run.dispose();
});

test('a real release while away removes pending state without a synthetic release', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ShiftLeft'); view.window.emit('blur');
  run.input(view, 'ShiftLeft', 'keyUp'); view.window.emit('focus');
  assert.deepEqual(view.sent, []);
  run.dispose();
});

test('pending is cleared before native reentrant input and a new key press is not overwritten', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ControlLeft'); run.input(view, 'ShiftLeft'); view.window.emit('blur');
  view.contents.sendInputEvent = value => {
    assert.equal(view.window.isFocused(), true);
    view.sent.push(value);
    run.input(view, value.keyCode + (value.modifiers[0] === 'left' ? 'Left' : 'Right'), 'keyUp');
    if (value.keyCode === 'Control') run.input(view, 'ShiftLeft');
  };
  view.window.emit('focus'); view.window.emit('focus');
  assert.deepEqual(view.sent, [{type: 'keyUp', keyCode: 'Control', modifiers: ['left']}]);
  run.dispose();
});

test('a focus notification while isFocused is false preserves pending until real focus', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'AltRight'); view.window.emit('blur');
  run.app.emit('browser-window-focus', {}, view.window);
  assert.deepEqual(view.sent, []);
  view.window.emit('focus');
  assert.deepEqual(view.sent, [{type: 'keyUp', keyCode: 'Alt', modifiers: ['right']}]);
  run.dispose();
});

for (const [key, flag] of [['Control', 'control'], ['Shift', 'shift'], ['Alt', 'alt'], ['Meta', 'meta']]) {
  test(`releasing pending ${key}Left preserves a genuinely held ${key}Right modifier`, () => {
    const run = fixture(), view = run.create();
    run.input(view, key + 'Left'); view.window.emit('blur');
    view.window.focused = true;
    run.input(view, key + 'Right');
    view.contents.sendInputEvent = input => {
      view.sent.push(input);
      run.input(view, key + 'Left', 'keyUp', {[flag]: true});
    };
    view.window.emit('focus');
    assert.deepEqual(view.sent, [{type: 'keyUp', keyCode: key, modifiers: [flag, 'left']}]);
    if (key === 'Control') {
      run.input(view, 'KeyV', 'keyUp', {control: true});
      assert.deepEqual(view.pasted, ['native-paste'], 'The genuinely held right Control cycle must survive the synthetic left release');
    }
    run.dispose();
  });
}

test('a genuine ControlLeft release does not clear the still-held right Control cycle', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ControlLeft'); run.input(view, 'ControlRight');
  run.input(view, 'ControlLeft', 'keyUp', {control: true});
  run.input(view, 'KeyV', 'keyUp', {control: true});
  assert.deepEqual(view.pasted, ['native-paste']);
  run.input(view, 'ControlRight', 'keyUp');
  run.input(view, 'KeyV', 'keyUp', {control: true});
  assert.equal(view.pasted.length, 1);
  run.dispose();
});

test('a lost Control release remains stale after synthetic focus KeyUp and cleans ordinary Down and Up', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ControlLeft'); view.window.emit('blur'); view.window.emit('focus'); view.sent.length = 0;
  for (const type of ['keyDown', 'keyUp']) {
    assert.equal(capturedInput(view, {type, code: 'KeyN', key: 'n', control: true, modifiers: ['control']}), 1);
  }
  assert.deepEqual(view.sent, [{type: 'keyDown', keyCode: 'n', modifiers: []}, {type: 'keyUp', keyCode: 'n', modifiers: []}]);
  run.dispose();
});

test('a genuine new Control press or the other genuinely held side preserves Control shortcuts', () => {
  const run = fixture();
  for (const code of ['ControlLeft', 'ControlRight']) {
    const view = run.create();
    run.input(view, 'ControlLeft'); view.window.emit('blur'); view.window.emit('focus'); view.sent.length = 0;
    run.input(view, code);
    assert.equal(capturedInput(view, {type: 'keyDown', code: 'KeyN', key: 'n', control: true, modifiers: ['control']}), 0);
    assert.deepEqual(view.sent, []);
  }
  run.dispose();
});

test('a genuine modifier release while away clears stale state', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ControlLeft'); view.window.emit('blur');
  run.input(view, 'ControlLeft', 'keyUp'); view.window.emit('focus');
  assert.equal(capturedInput(view, {type: 'keyDown', code: 'KeyN', key: 'n', control: true}), 0);
  assert.deepEqual(view.sent, []);
  run.dispose();
});

test('stale correction preserves other modifiers, repeat, location and the original event type', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ControlLeft'); view.window.emit('blur'); view.window.emit('focus'); view.sent.length = 0;
  assert.equal(capturedInput(view, {type: 'rawKeyDown', code: 'ArrowLeft', key: 'ArrowLeft', control: true,
    shift: true, alt: true, modifiers: ['ctrl', 'shift', 'alt', 'capslock'], isAutoRepeat: true, location: 3}), 1);
  assert.deepEqual(view.sent, [{type: 'rawKeyDown', keyCode: 'Left', modifiers: ['shift', 'alt', 'capslock', 'isAutoRepeat', 'isKeypad']}]);
  run.dispose();
});

test('native reentrant corrected input never loops and synthetic KeyUp never clears stale state', () => {
  const run = fixture(), view = run.create(); let replayed = 0;
  view.contents.sendInputEvent = input => {
    view.sent.push(input);
    const modifier = input.keyCode === 'Control';
    const reentry = modifier ? {type: input.type, code: 'ControlLeft', key: 'Control', control: false} :
      {type: input.type, code: 'KeyN', key: input.keyCode, control: false, modifiers: input.modifiers};
    replayed++;
    assert.equal(capturedInput(view, reentry), 0);
  };
  run.input(view, 'ControlLeft'); view.window.emit('blur'); view.window.emit('focus');
  assert.equal(capturedInput(view, {type: 'keyDown', code: 'KeyN', key: 'n', control: true}), 1);
  assert.equal(capturedInput(view, {type: 'keyUp', code: 'KeyN', key: 'n', control: true}), 1);
  assert.equal(replayed, 3);
  run.dispose();
});

test('without stale state ordinary native events are never replayed or prevented', () => {
  const run = fixture(), view = run.create();
  for (const key of ['a', 'n', 'v', 'ArrowLeft', 'Enter']) {
    assert.equal(capturedInput(view, {type: 'keyDown', key, control: true, modifiers: ['control']}), 0);
  }
  assert.deepEqual(view.sent, []);
  run.dispose();
});

test('unsupported IME, Dead keys and Shift-implied characters keep their original event', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ShiftLeft'); view.window.emit('blur'); view.window.emit('focus'); view.sent.length = 0;
  for (const input of [{key: '汉', code: 'KeyN', shift: true}, {key: 'Dead', shift: true},
    {key: 'n', shift: true, isComposing: true}, {key: '!', shift: true}]) {
    assert.equal(capturedInput(view, {type: 'keyDown', ...input}), 0);
  }
  assert.deepEqual(view.sent, []);
  run.dispose();
});

test('stale state is isolated per window and a clean event is not replayed merely because stale exists', () => {
  const run = fixture(), first = run.create(), second = run.create();
  run.input(first, 'ControlLeft'); first.window.emit('blur'); first.window.emit('focus'); first.sent.length = 0;
  assert.equal(capturedInput(second, {type: 'keyDown', key: 'n', control: true}), 0);
  assert.equal(capturedInput(first, {type: 'keyDown', key: 'n', control: false}), 0);
  assert.deepEqual([...first.sent, ...second.sent], []);
  run.dispose();
});

test('one normal A press followed by nineteen missing Downs yields twenty commands and only nineteen repairs', async () => {
  const run = fixture(), view = run.create();
  const send = view.contents.sendInputEvent;
  let callbacks = 0;
  view.contents.sendInputEvent = input => {
    send(input);
    queueMicrotask(() => {
      callbacks++;
      assert.equal(capturedInput(view, {type: input.type, code: 'KeyA', key: 'a', control: true, modifiers: input.modifiers}), 0);
    });
  };
  run.input(view, 'ControlLeft');
  assert.equal(capturedInput(view, {type: 'keyDown', code: 'KeyA', key: 'a', control: true}), 0);
  assert.equal(capturedInput(view, {type: 'keyUp', code: 'KeyA', key: 'a', control: true}), 0);
  for (let count = 0; count < 19; count++) {
    assert.equal(capturedInput(view, {type: 'keyUp', code: 'KeyA', key: 'a', control: true, modifiers: ['control']}), 1);
    await Promise.resolve();
  }
  assert.equal(view.sent.filter(input => input.type === 'keyDown').length + 1, 20);
  assert.equal(view.sent.filter(input => input.type === 'keyUp').length + 1, 20);
  assert.equal(view.sent.length, 38);
  assert.equal(callbacks, 38);
  assert.ok(view.sent.every(input => input.keyCode === 'A' && input.modifiers.includes('control')));
  run.dispose();
});

for (const code of ['KeyC', 'KeyX']) {
  test(`${code} only repairs missing Down and excludes its asynchronous native callback pair`, async () => {
    const run = fixture(), view = run.create(), key = code.slice(3).toLowerCase();
    const send = view.contents.sendInputEvent;
    view.contents.sendInputEvent = input => {
      send(input);
      queueMicrotask(() => assert.equal(capturedInput(view, {type: input.type, code, key, control: true, modifiers: input.modifiers}), 0));
    };
    run.input(view, 'ControlLeft');
    assert.equal(capturedInput(view, {type: 'keyDown', code, key, control: true}), 0);
    assert.equal(capturedInput(view, {type: 'keyUp', code, key, control: true}), 0);
    assert.deepEqual(view.sent, []);
    assert.equal(capturedInput(view, {type: 'keyUp', code, key, control: true, modifiers: ['control']}), 1);
    await Promise.resolve();
    assert.deepEqual(view.sent, [
      {type: 'keyDown', keyCode: code.slice(3), modifiers: ['control']},
      {type: 'keyUp', keyCode: code.slice(3), modifiers: ['control']}
    ]);
    run.dispose();
  });
}

test('edit-key recovery never changes normal CtrlN, unmodified input or Alt/Meta/Shift combinations', () => {
  const run = fixture(), view = run.create();
  assert.equal(capturedInput(view, {type: 'keyUp', code: 'KeyA', key: 'a', control: true}), 0);
  run.input(view, 'ControlLeft');
  for (const input of [{code: 'KeyN', key: 'n', control: true}, {code: 'KeyA', key: 'a', control: false},
    {code: 'KeyC', key: 'c', control: true, alt: true}, {code: 'KeyX', key: 'x', control: true, meta: true},
    {code: 'KeyA', key: 'a', control: true, shift: true}]) {
    assert.equal(capturedInput(view, {type: 'keyUp', ...input}), 0);
  }
  assert.deepEqual(view.sent, []);
  run.dispose();
});

test('each VUp consumes its normal Down and later swallowed-Down releases can still paste', () => {
  const run = fixture(), view = run.create();
  run.input(view, 'ControlLeft'); run.input(view, 'KeyV', 'keyDown', {control: true});
  run.input(view, 'KeyV', 'keyUp', {control: true});
  assert.equal(view.pasted.length, 0);
  run.input(view, 'KeyV', 'keyUp', {control: true});
  run.input(view, 'KeyV', 'keyUp', {control: true});
  assert.equal(view.pasted.length, 2);
  assert.deepEqual(view.sent, []);
  run.dispose();
});
