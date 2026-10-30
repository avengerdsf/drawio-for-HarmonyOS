import electron from 'electron';
import {ClipboardItem, createClipboardAdapter, withoutSystemFrame} from './electron-compat.mjs';

export * from 'electron';
export {ClipboardItem};
export const clipboard = createClipboardAdapter(electron.clipboard, electron.nativeImage);
export const BrowserWindow = withoutSystemFrame(electron.BrowserWindow);

const overrides = {ClipboardItem, clipboard, BrowserWindow};
export default new Proxy(electron, {
  get(target, key) {
    return Object.hasOwn(overrides, key) ? overrides[key] : Reflect.get(target, key, target);
  },
  has(target, key) {
    return Object.hasOwn(overrides, key) || Reflect.has(target, key);
  }
});
