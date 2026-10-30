export class ClipboardItem {
  #items;

  constructor(items) {
    if (items == null || typeof items !== 'object' || Array.isArray(items)) {
      throw new TypeError('ClipboardItem requires a MIME record');
    }
    this.#items = new Map(Object.entries(items));
  }

  get types() {
    return [...this.#items.keys()];
  }

  async getType(type) {
    if (!this.#items.has(type)) throw new TypeError('Missing ClipboardItem MIME type: ' + type);
    const value = await this.#items.get(type);
    if (type === 'electron application/bookmark') return value;
    if (typeof value === 'string') return new Blob([value], {type});
    if (value instanceof Blob) return value;
    throw new TypeError('ClipboardItem MIME value must be a Blob or string');
  }
}

export function createClipboardAdapter(legacy, nativeImage) {
  async function writeItems(items) {
    if (items.length !== 1) throw new TypeError('This adapter supports one ClipboardItem per write');
    const item = items[0];
    if (!Array.isArray(item?.types) || typeof item?.getType !== 'function') {
      throw new TypeError('ClipboardItem requires types and getType');
    }
    const types = item.types;
    const data = {};
    for (const type of types) {
      if (!['image/png', 'text/html', 'text/plain', 'electron application/bookmark'].includes(type)) {
        throw new TypeError('Unsupported clipboard MIME type: ' + type);
      }
      const value = await item.getType(type);
      if (type === 'electron application/bookmark') {
        if (typeof value?.title !== 'string' || typeof value?.url !== 'string') {
          throw new TypeError('Clipboard bookmark requires title and url');
        }
        data.bookmark = value.title;
        if (!types.includes('text/plain')) data.text = value.url;
      } else {
        if (!(value instanceof Blob)) throw new TypeError('ClipboardItem.getType must return a Blob');
        if (type === 'image/png') data.image = nativeImage.createFromBuffer(Buffer.from(await value.arrayBuffer()));
        else data[type === 'text/html' ? 'html' : 'text'] = await value.text();
      }
    }
    legacy.write.call(legacy, data);
  }

  function write(value, ...args) {
    return Array.isArray(value) ? writeItems(value) : legacy.write.call(legacy, value, ...args);
  }

  return new Proxy(legacy, {
    get(target, key) {
      if (key === 'write') return write;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

export function withoutSystemFrame(BrowserWindow) {
  return new Proxy(BrowserWindow, {
    construct(target, [options, ...args], newTarget) {
      const window = Reflect.construct(target, [{...options, frame: false}, ...args], newTarget);
      const offscreen = options?.webPreferences?.offscreen;
      if (options?.show === false && options?.enableLargerThanScreen === true &&
        (offscreen === true || offscreen !== null && typeof offscreen === 'object' && !Array.isArray(offscreen)) &&
        typeof window.setBounds === 'function' && typeof window.capturePage === 'function') {
        const setBounds = window.setBounds;
        const capturePage = window.capturePage;
        let captureRectangle;
        window.setBounds = function(...boundsArgs) {
          const result = Reflect.apply(setBounds, this, boundsArgs);
          const bounds = boundsArgs[0];
          if (this === window && Number.isInteger(bounds?.width) && bounds.width > 0 &&
            Number.isInteger(bounds?.height) && bounds.height > 0) {
            captureRectangle = {x: 0, y: 0, width: bounds.width, height: bounds.height};
          }
          return result;
        };
        window.capturePage = function(...captureArgs) {
          if (this === window && captureArgs.length === 0 && captureRectangle !== undefined) {
            return Reflect.apply(capturePage, this, [{...captureRectangle}]);
          }
          return Reflect.apply(capturePage, this, captureArgs);
        };
      }
      return window;
    }
  });
}
