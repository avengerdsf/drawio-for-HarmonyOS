import { common } from '@kit.AbilityKit';
import { deviceInfo, settings } from '@kit.BasicServicesKit';
import { fileIo } from '@kit.CoreFileKit';

export default class WindowModeCatalog {
  private static observing: boolean = false;
  private static generation: number = 0;
  private static subscribers: Map<() => void, common.UIAbilityContext> = new Map();

  static start(context: common.UIAbilityContext): void {
    WindowModeCatalog.refresh(context);
  }

  static subscribe(context: common.UIAbilityContext, callback: () => void): () => void {
    WindowModeCatalog.subscribers.set(callback, context);
    if (!WindowModeCatalog.observing) {
      const generation = ++WindowModeCatalog.generation;
      try {
        WindowModeCatalog.observing = settings.registerKeyObserver(context, 'window_pcmode_switch_status',
          settings.domainName.USER_PROPERTY, () => {
            if (WindowModeCatalog.generation !== generation) {
              return;
            }
            const current = Array.from(WindowModeCatalog.subscribers.values())[0];
            if (current) {
              WindowModeCatalog.refresh(current);
            }
          });
      } catch (error) {
        console.error('[WindowModeCatalog] Observer: ' + JSON.stringify(error));
      }
    }
    let active = true;
    return (): void => {
      if (!active) {
        return;
      }
      active = false;
      WindowModeCatalog.subscribers.delete(callback);
      if (WindowModeCatalog.subscribers.size === 0) {
        WindowModeCatalog.generation++;
        if (WindowModeCatalog.observing) {
          WindowModeCatalog.observing = false;
          try {
            settings.unregisterKeyObserver(context, 'window_pcmode_switch_status', settings.domainName.USER_PROPERTY);
          } catch (error) {
            console.error('[WindowModeCatalog] Unregister: ' + JSON.stringify(error));
          }
        }
      }
    };
  }

  static refresh(context: common.UIAbilityContext): void {
    WindowModeCatalog.write(context);
    const callbacks = Array.from(WindowModeCatalog.subscribers.keys());
    for (const callback of callbacks) {
      if (WindowModeCatalog.subscribers.has(callback)) {
        try {
          callback();
        } catch (error) {
          console.error('[WindowModeCatalog] Subscriber: ' + JSON.stringify(error));
        }
      }
    }
  }

  private static write(context: common.UIAbilityContext): void {
    const target = context.getApplicationContext().filesDir + '/diagramdesk-window-mode.json';
    const temporary = target + '.tmp';
    try {
      const value = settings.getValueSync(context, 'window_pcmode_switch_status', 'false', settings.domainName.USER_PROPERTY);
      const normalPadMode: boolean = deviceInfo.deviceType === 'tablet' && value === 'false';
      const file = fileIo.openSync(temporary, fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(file.fd, JSON.stringify({normalPadMode: normalPadMode}));
      } finally {
        fileIo.closeSync(file.fd);
      }
      fileIo.renameSync(temporary, target);
    } catch (error) {
      console.error('[WindowModeCatalog] Refresh: ' + JSON.stringify(error));
    } finally {
      try {
        fileIo.unlinkSync(temporary);
      } catch (_) {
      }
    }
  }
}
