const modifiers = new Map([
  ['ControlLeft', ['Control', 'left']], ['ControlRight', ['Control', 'right']],
  ['ShiftLeft', ['Shift', 'left']], ['ShiftRight', ['Shift', 'right']],
  ['AltLeft', ['Alt', 'left']], ['AltRight', ['Alt', 'right']],
  ['MetaLeft', ['Meta', 'left']], ['MetaRight', ['Meta', 'right']]
]);
const baseURL = value => typeof value === 'string' ? value.split(/[?#]/, 1)[0] : '';
const keyNames = new Map([[' ', 'Space'], ['ArrowLeft', 'Left'], ['ArrowRight', 'Right'], ['ArrowUp', 'Up'], ['ArrowDown', 'Down']]);
const namedKeys = new Set(['Tab', 'CapsLock', 'NumLock', 'ScrollLock', 'Backspace', 'Delete', 'Insert', 'Enter', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'PrintScreen']);
const modifierNames = ['control', 'shift', 'alt', 'meta'];
const aliases = new Map([['ctrl', 'control'], ['cmd', 'meta'], ['command', 'meta']]);
const normalize = name => aliases.get(name.toLowerCase()) || name.toLowerCase();
function keyCodeFor(input) {
  if (input.isComposing || !['keyDown', 'rawKeyDown', 'keyUp'].includes(input.type) || typeof input.key !== 'string') return;
  if (/^[a-z0-9\-=\[\]\\;',./`]$/i.test(input.key)) return input.key;
  if (keyNames.has(input.key)) return keyNames.get(input.key);
  if (namedKeys.has(input.key) || /^F([1-9]|1\d|2[0-4])$/.test(input.key)) return input.key;
}
function nativeModifiers(input, excluded = new Set()) {
  const flags = (Array.isArray(input.modifiers) ? input.modifiers.filter(name => typeof name === 'string') : [])
    .filter(name => !excluded.has(normalize(name)));
  for (const name of modifierNames) if (input[name] === true && !excluded.has(name) && !flags.some(value => normalize(value) === name)) flags.push(name);
  if (input.isAutoRepeat && !flags.some(name => normalize(name) === 'isautorepeat')) flags.push('isAutoRepeat');
  const side = input.location === 1 ? 'left' : input.location === 2 ? 'right' : input.location === 3 ? 'isKeypad' : null;
  if (side && !flags.some(name => normalize(name) === side.toLowerCase())) flags.push(side);
  return flags;
}
const editKeys = new Set(['KeyA', 'KeyC', 'KeyX', 'KeyV']);

export function installNativeInputState(app, editorURL) {
  const states = new Map(), originalURL = baseURL(editorURL);
  function onCreated(_event, window) {
    if (states.has(window)) return;
    const contents = window.webContents, pressed = new Set(), pending = new Set(), stale = new Set(), syntheticUps = new Set(), expectedEdits = new Set();
    let cycle = null, injecting = false;
    const windowFocused = () => {
      try { return window.isFocused(); } catch { return false; }
    };
    const isEditor = () => {
      try { return !!originalURL && baseURL(contents.getURL()) === originalURL && baseURL(contents.mainFrame?.url) === originalURL; }
      catch { return false; }
    };
    function onInput(event, input) {
      const editToken = input?.code + ':' + (input?.type === 'rawKeyDown' ? 'keyDown' : input?.type);
      if (expectedEdits.delete(editToken)) return;
      const modifier = modifiers.get(input?.code);
      if (modifier) {
        if (input.type === 'keyUp' && syntheticUps.delete(input.code)) return;
        if (input.type === 'keyDown' || input.type === 'rawKeyDown') {
          syntheticUps.delete(input.code); stale.delete(input.code);
          pending.delete(input.code);
          pressed.add(input.code);
          if (modifier[0] === 'Control' && !cycle && windowFocused()) cycle = {down: new Set()};
        } else if (input.type === 'keyUp') {
          stale.delete(input.code);
          pending.delete(input.code);
          pressed.delete(input.code);
          if (modifier[0] === 'Control' && !Array.from(pressed).some(code => modifiers.get(code)[0] === 'Control')) cycle = null;
        }
        return;
      }
      if (injecting) return;
      const keyCode = input && keyCodeFor(input);
      if (keyCode && stale.size && windowFocused() && isEditor()) {
        const held = new Set(Array.from(pressed, code => modifiers.get(code)[0].toLowerCase()));
        const vector = Array.isArray(input.modifiers) ? input.modifiers.filter(name => typeof name === 'string') : [];
        const bad = new Set(Array.from(stale, code => modifiers.get(code)[0].toLowerCase())
          .filter(name => !held.has(name) && (input[name] === true || vector.some(value => normalize(value) === name))));
        if (bad.size && !(bad.has('shift') && /^[A-Z]$/.test(keyCode) && !vector.some(name => normalize(name) === 'capslock'))) {
          injecting = true;
          try { contents.sendInputEvent({type: input.type, keyCode, modifiers: nativeModifiers(input, bad)}); event.preventDefault(); return; }
          catch {} finally { injecting = false; }
        }
      }
      if (!editKeys.has(input?.code) || !cycle) return;
      if (input.type === 'keyDown' || input.type === 'rawKeyDown') { cycle.down.add(input.code); return; }
      if (input.type !== 'keyUp') return;
      const hadDown = cycle.down.delete(input.code);
      if (hadDown || !input.control || input.alt || input.meta || input.shift || !windowFocused() || !isEditor()) return;
      if (input.code === 'KeyV') { try { contents.paste(); } catch {} return; }
      const down = input.code + ':keyDown', up = input.code + ':keyUp';
      expectedEdits.add(down); expectedEdits.add(up);
      injecting = true;
      try {
        const keyCode = input.code.slice(3), flags = nativeModifiers(input);
        contents.sendInputEvent({type: 'keyDown', keyCode, modifiers: flags});
        contents.sendInputEvent({type: 'keyUp', keyCode, modifiers: flags});
        event.preventDefault();
      } catch { expectedEdits.delete(down); expectedEdits.delete(up); }
      finally { injecting = false; }
    }
    function onFocus() {
      if (!windowFocused()) return;
      const held = Array.from(pending); pending.clear();
      for (const code of held) {
        if (pressed.has(code)) continue;
        const [keyCode, side] = modifiers.get(code);
        const flags = Array.from(new Set(Array.from(pressed, held => modifiers.get(held)[0].toLowerCase())));
        syntheticUps.add(code);
        try { contents.sendInputEvent({type: 'keyUp', keyCode, modifiers: [...flags, side]}); } catch { syntheticUps.delete(code); }
      }
    }
    function onBlur() {
      cycle = null;
      for (const code of pressed) { pending.add(code); stale.add(code); }
      pressed.clear();
    }
    function dispose() {
      pressed.clear(); pending.clear(); stale.clear(); syntheticUps.clear(); expectedEdits.clear(); cycle = null;
      contents.removeListener('before-input-event', onInput);
      contents.removeListener('destroyed', dispose);
      window.removeListener('focus', onFocus);
      window.removeListener('blur', onBlur);
      window.removeListener('closed', dispose);
      states.delete(window);
    }
    states.set(window, {onFocus, onBlur, dispose});
    contents.on('before-input-event', onInput);
    contents.once('destroyed', dispose);
    window.on('focus', onFocus);
    window.on('blur', onBlur);
    window.once('closed', dispose);
  }
  function onFocused(_event, window) { states.get(window)?.onFocus(); }
  function onBlurred(_event, window) { states.get(window)?.onBlur(); }
  app.on('browser-window-created', onCreated);
  app.on('browser-window-focus', onFocused);
  app.on('browser-window-blur', onBlurred);
  return () => {
    app.removeListener('browser-window-created', onCreated);
    app.removeListener('browser-window-focus', onFocused);
    app.removeListener('browser-window-blur', onBlurred);
    for (const state of states.values()) state.dispose();
  };
}
