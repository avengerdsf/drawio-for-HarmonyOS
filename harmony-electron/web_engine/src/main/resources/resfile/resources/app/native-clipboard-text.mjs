function patchClipboardText(editorURL) {
  if (window.top !== window || window.location.href.split(/[?#]/, 1)[0] !== editorURL) return;
  const clipboard = navigator.clipboard, marker = Symbol.for('diagramdesk.nativeClipboardText');
  if (!clipboard || clipboard[marker]) return;
  const normalize = value => {
    if (typeof value !== 'string' || !value.startsWith('%3CmxGraphModel')) return value;
    try {
      const decoded = decodeURIComponent(value);
      return /^<mxGraphModel(?:\s[^<>]*)?>/.test(decoded) && /<\/mxGraphModel>\s*$/.test(decoded) ? decoded : value;
    } catch { return value; }
  };
  if (typeof clipboard.readText === 'function') {
    const original = clipboard.readText;
    Object.defineProperty(clipboard, 'readText', {configurable: true, writable: true, value: function(...args) {
      return Reflect.apply(original, this, args).then(normalize);
    }});
  }
  if (typeof clipboard.read === 'function') {
    const original = clipboard.read;
    Object.defineProperty(clipboard, 'read', {configurable: true, writable: true, value: function(...args) {
      return Reflect.apply(original, this, args).then(items => items.map(item => {
        if (!item.types.includes('text/plain')) return item;
        const getType = item.getType;
        let proxy;
        const wrapped = function(...parameters) {
          const result = Reflect.apply(getType, this === proxy ? item : this, parameters);
          if (parameters[0] !== 'text/plain') return result;
          return result.then(async blob => {
            const text = await blob.text(), normalized = normalize(text);
            return normalized === text ? blob : new Blob([normalized], {type: blob.type});
          });
        };
        proxy = new Proxy(item, {get(target, key) {
          return key === 'getType' ? wrapped : Reflect.get(target, key, target);
        }});
        return proxy;
      }));
    }});
  }
  Object.defineProperty(clipboard, marker, {value: true});
}

const baseURL = value => typeof value === 'string' ? value.split(/[?#]/, 1)[0] : '';

export function installNativeClipboardText(app, originalIndexURL) {
  const states = new Map();
  function onCreated(_event, contents) {
    if (states.has(contents)) return;
    function onReady() {
      if (baseURL(contents.getURL()) !== originalIndexURL || baseURL(contents.mainFrame?.url) !== originalIndexURL) return;
      contents.executeJavaScript('(' + patchClipboardText.toString() + ')(' + JSON.stringify(originalIndexURL) + ')').catch(error => {
        console.error('Native clipboard text configuration failed:', error.message);
      });
    }
    function dispose() {
      contents.removeListener('dom-ready', onReady);
      contents.removeListener('destroyed', dispose);
      states.delete(contents);
    }
    states.set(contents, dispose);
    contents.on('dom-ready', onReady);
    contents.once('destroyed', dispose);
  }
  app.on('web-contents-created', onCreated);
  return () => {
    app.removeListener('web-contents-created', onCreated);
    for (const dispose of states.values()) dispose();
  };
}
