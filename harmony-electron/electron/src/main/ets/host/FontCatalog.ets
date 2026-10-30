import { common } from '@kit.AbilityKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { fileIo } from '@kit.CoreFileKit';
import { text } from '@kit.ArkGraphics2D';

const CATALOG_FILE: string = 'diagramdesk-font-catalog.json';

export default class FontCatalog {
  private static pending: Promise<void> | undefined = undefined;

  static refresh(context: common.ApplicationContext): Promise<void> {
    if (FontCatalog.pending !== undefined) {
      return FontCatalog.pending;
    }
    FontCatalog.pending = FontCatalog.write(context.filesDir)
      .catch((error: Error) => {
        console.error('[FontCatalog] ' + error.message);
      })
      .finally(() => {
        FontCatalog.pending = undefined;
      });
    return FontCatalog.pending;
  }

  private static async collect(): Promise<Array<string>> {
    let descriptors: Array<text.FontDescriptor>;
    if (deviceInfo.sdkApiVersion >= 18) {
      descriptors = await text.matchFontDescriptors({});
    } else {
      descriptors = [];
      const names = await text.getSystemFontFullNamesByType(text.SystemFontType.ALL);
      for (const name of names) {
        descriptors.push(await text.getFontDescriptorByFullName(name, text.SystemFontType.ALL));
      }
    }
    const families: Array<string> = [];
    for (const descriptor of descriptors) {
      if (descriptor.fontFamily !== undefined) {
        families.push(descriptor.fontFamily);
      }
    }
    return families;
  }

  private static async write(filesDir: string): Promise<void> {
    const families = await FontCatalog.collect();
    // ApplicationContext filesDir matches this host's application-level userData.
    const target = filesDir + '/' + CATALOG_FILE;
    const temporary = target + '.tmp';
    try {
      const file = fileIo.openSync(temporary,
        fileIo.OpenMode.READ_WRITE | fileIo.OpenMode.CREATE | fileIo.OpenMode.TRUNC);
      try {
        fileIo.writeSync(file.fd, JSON.stringify(families));
      } finally {
        fileIo.closeSync(file.fd);
      }
      fileIo.renameSync(temporary, target);
    } finally {
      try {
        fileIo.unlinkSync(temporary);
      } catch (_) {
      }
    }
  }
}
