// Copyright (c) 2024 Huawei Device Co., Ltd. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import fs from '@ohos.file.fs';
import LogUtil from '../utils/LogUtil';
import LogMethod from '../common/LogDecorator';
import picker from '@ohos.file.picker';
import { fileUri } from '@kit.CoreFileKit';

import { AbilityManager } from '../common/AbilityManager';
import { BaseAdapter } from '../common/BaseAdapter';
import { BusinessError } from '@ohos.base';
import { image } from '@kit.ImageKit';
import { inject, injectable } from 'inversify';
import { ContextAdapter } from './ContextAdapter';
import { PermissionManagerAdapter } from './PermissionManagerAdapter';

const TAG: string = 'Dialog';

interface IMessageBoxSettings {
  parent_id: number,
  type: string,
  title: string,
  message: string,
  detail: string,
  checkbox_label: string,
  checkbox_checked: boolean,
  cancel_id: number,
  default_id: number,
  buttons: string[]
}

interface IFilter {
  name: string,
  extensions: string[]
}

interface IOpenDialogSettings {
  parent_id: number,
  title: string,
  message: string,
  button_label: string,
  default_path: string,
  filters: IFilter[],
  properties_open_directory: boolean,
  properties_open_mixed: boolean,
  properties_multi_selections: boolean
}

export interface IMessageBoxParams {
  messageBoxSettings: IMessageBoxSettings | undefined,
  icon: image.PixelMap | undefined,
  callback: (buttonId: number, checkboxChecked: boolean) => void
}

export interface MessageBoxData {
  id: string,
  dialogController: CustomDialogController,
  setMessageBoxParams: (messageBoxParams: IMessageBoxParams) => void;
  cancelPending?: () => void;
}

@injectable()
export class DialogAdapter extends BaseAdapter {
  private abilityManager: AbilityManager = new AbilityManager();
  private static PATH_PREFIX: string = 'file://docs'; 
  private static DEFAULT_DIR: string = 'file://docs/storage/Users/currentUser';
  private static MAX_SELECT_NUMBER: number = 500;
  private ctxAdapter: ContextAdapter;
  private permissionManager: PermissionManagerAdapter;
  private allFIleDescriptionId: number = $r("app.string.upload_all_file_description").id;

  constructor(@inject(ContextAdapter) ctxAdapter: ContextAdapter,
    @inject(PermissionManagerAdapter) permissionManager: PermissionManagerAdapter) {
    super();
    this.ctxAdapter = ctxAdapter;
    this.permissionManager = permissionManager;
  }

  @LogMethod
  showMessageBox(settings: string, buffer: ArrayBuffer, width: number, height: number,  callback: (button_id: number, checkbox_checked: boolean) => void) {
    LogUtil.info(TAG, 'messagebox settings ' + settings);
    let icon: image.PixelMap | undefined = this.convertImagePixelMap(width, height, buffer);
    let boxSettings: IMessageBoxSettings = JSON.parse(settings);
    LogUtil.error(TAG, 'parentId ' + boxSettings.parent_id);
    let parentId = boxSettings.parent_id === -1 ? 1 : boxSettings.parent_id;
    const messageBoxManager: MessageBoxData | undefined = this.abilityManager.getMessageBox(parentId);
    if (!messageBoxManager) {
      callback(boxSettings.cancel_id, boxSettings.checkbox_checked);
      return;
    }
    const previous = messageBoxManager.cancelPending;
    if (previous) {
      messageBoxManager.cancelPending = undefined;
      try {
        messageBoxManager.dialogController.close();
      } catch (error) {
        LogUtil.error(TAG, 'Failed to close the previous message box: ' + JSON.stringify(error));
      }
      previous();
      if (this.abilityManager.getMessageBox(parentId) !== messageBoxManager) {
        callback(boxSettings.cancel_id, boxSettings.checkbox_checked);
        return;
      }
    }
    let completed = false;
    const complete = (buttonId: number, checkboxChecked: boolean): void => {
      if (completed) {
        return;
      }
      completed = true;
      if (messageBoxManager.cancelPending === cancelPending) {
        messageBoxManager.cancelPending = undefined;
      }
      callback(buttonId, checkboxChecked);
    };
    const cancelPending = (): void => complete(boxSettings.cancel_id, boxSettings.checkbox_checked);
    let params: IMessageBoxParams = {messageBoxSettings: boxSettings, icon: icon, callback: complete};
    messageBoxManager.cancelPending = cancelPending;
    try {
      messageBoxManager.setMessageBoxParams(params);
      messageBoxManager.dialogController.open();
    } catch (error) {
      cancelPending();
      LogUtil.error(TAG, 'Failed to open the message box: ' + JSON.stringify(error));
    }
  }

  @LogMethod
  showErrorBox(title: string, content: string, callback: (result: boolean) => void) {
    let isClicked = false;
    AlertDialog.show({
      title: title,
      message: content,
      autoCancel: false,
      cancel: () => {},
      primaryButton: {
        value: $r('app.string.button_ok'),
        style: DialogButtonStyle.HIGHLIGHT,
        action: () => {
          if (isClicked) {
            return;
          }
          isClicked = true;
          callback(true);
        },
      }
    });
  }

  @LogMethod
  showOpenDialog(settings: string, callback: (filePaths: string[], canceled: boolean) => void) {
    LogUtil.info(TAG, 'ShowOpenDialog ' + settings);
    let DocumentSelectOptions = new picker.DocumentSelectOptions();
    let dialogSettings: IOpenDialogSettings = JSON.parse(settings);
    if (dialogSettings.properties_open_directory) {
      DocumentSelectOptions.selectMode = picker.DocumentSelectMode.FOLDER;
      if (dialogSettings.properties_open_mixed)
        DocumentSelectOptions.selectMode = picker.DocumentSelectMode.MIXED;
    }
    if (dialogSettings.properties_multi_selections) {
      DocumentSelectOptions.maxSelectNumber = DialogAdapter.MAX_SELECT_NUMBER;
    }
    const context = this.ctxAdapter.getContext();
    let allFileDescription = context.resourceManager.getStringSync(this.allFIleDescriptionId);
    if (dialogSettings.filters.length > 0) {
      DocumentSelectOptions.fileSuffixFilters = this.getFilterArray(dialogSettings.filters);
    } else {
      DocumentSelectOptions.fileSuffixFilters = [allFileDescription + "|.*"];
    }
    let dirAndFile: string[] = this.handleDefaultPath(dialogSettings.default_path);
    LogUtil.info(TAG, 'showOpenDialog dirAndFile: ' + `${dirAndFile[0]}-${dirAndFile[1]}`);
    DocumentSelectOptions.defaultFilePathUri = dirAndFile[0];
    let documentPicker = new picker.DocumentViewPicker();
    documentPicker.select(DocumentSelectOptions).then(async (DocumentSelectResult: Array<string>) => {
      LogUtil.info(TAG, 'DocumentViewPicker.select successfully, DocumentSelectResult uri: ' + JSON.stringify(DocumentSelectResult));
      if (DocumentSelectResult.length === 0) {
        callback([], true);
      } else {
        await this.permissionManager.fileAccessPersist(DocumentSelectResult);
        callback(DocumentSelectResult, false);
      }
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, 'DocumentViewPicker.select failed with err: ' + JSON.stringify(err));
      callback([], true);
    });
  }

  @LogMethod
  showSaveDialog(settings: string, callback: (filePath: string, canceled: boolean) => void) {
    LogUtil.info(TAG, 'ShowSaveDialog ' + settings);
    let dialogSettings: IOpenDialogSettings = JSON.parse(settings);
    let DocumentSaveOptions = new picker.DocumentSaveOptions();
    let dirAndFile: string[] = this.handleDefaultPath(dialogSettings.default_path);
    LogUtil.info(TAG, 'ShowSaveDialog dirAndFile: ' + `${dirAndFile[0]}-${dirAndFile[1]}`);
    DocumentSaveOptions.defaultFilePathUri = dirAndFile[0];
    DocumentSaveOptions.newFileNames = [`${dirAndFile[1]}`];
    const context = this.ctxAdapter.getContext();
    let allFileDescription = context.resourceManager.getStringSync(this.allFIleDescriptionId);
    if (dialogSettings.filters.length > 0) {
      DocumentSaveOptions.fileSuffixChoices = this.getFilterArray(dialogSettings.filters);
    } else {
      DocumentSaveOptions.fileSuffixChoices = [allFileDescription + "|.*"];
    }
    let documentPicker = new picker.DocumentViewPicker();
    documentPicker.save(DocumentSaveOptions).then(async (DocumentSaveResult: Array<string>) => {
      LogUtil.info(TAG, 'DocumentViewPicker.save successfully, DocumentSaveResult uri: ' + JSON.stringify(DocumentSaveResult));
      if (DocumentSaveResult.length === 0) {
        callback('', true);
      } else {
        await this.permissionManager.fileAccessPersist(DocumentSaveResult);
        callback(DocumentSaveResult[0], false);
      }
    }).catch((err: BusinessError) => {
      LogUtil.error(TAG, 'DocumentViewPicker.save failed with err: ' + JSON.stringify(err));
      callback('', true);
    });
  }

  private handleDefaultPath(default_path: string) {
    let dirAndFile: string[] = [DialogAdapter.DEFAULT_DIR, ''];
    try {
      if (typeof default_path !== 'string') {
        return dirAndFile;
      }
      const path: string = default_path.trim();
      if (path.length === 0 || path.indexOf('\0') !== -1) {
        return dirAndFile;
      }
      if (!path.startsWith('file://') && !path.startsWith('/')) {
        if (path.indexOf('/') === -1 && path.indexOf('\\') === -1 && path !== '.' && path !== '..') {
          dirAndFile[1] = path;
        }
        return dirAndFile;
      }
      const target: fileUri.FileUri = new fileUri.FileUri(path);
      const uri: string = path.startsWith('file://') ? path : target.toString();
      const displayPath: string = target.path;
      const fileName: string = target.name;
      if (!displayPath.startsWith('/') || displayPath.indexOf('\0') !== -1 ||
        fileName.indexOf('/') !== -1 || fileName.indexOf('\0') !== -1 || fileName === '.' || fileName === '..') {
        return dirAndFile;
      }
      dirAndFile[1] = fileName;
      if (fs.accessSync(displayPath) && fs.statSync(displayPath).isDirectory()) {
        return [uri, ''];
      }
      const lastSlashIdx: number = uri.lastIndexOf('/');
      const parentPath: string = displayPath.substring(0, displayPath.lastIndexOf('/')) || '/';
      if (lastSlashIdx > 'file://'.length && fs.accessSync(parentPath) && fs.statSync(parentPath).isDirectory()) {
        const authorityEnd: number = uri.indexOf('/', 'file://'.length);
        dirAndFile[0] = uri.substring(0, lastSlashIdx === authorityEnd ? lastSlashIdx + 1 : lastSlashIdx);
      }
    } catch (err) {
      LogUtil.error(TAG, 'handleDefaultPath failed with err: ' + JSON.stringify(err));
    }
    return dirAndFile;
  }

  private getFilterArray(filters: IFilter[]): Array<string> {
    let copy = new Array<string>();
    for (const filter of filters) {
      copy.push(filter.name + "(*." + filter.extensions.join(";*.") + ")|." + filter.extensions.join(",."));
    }
    return copy;
  }

  private convertImagePixelMap(width: number, height: number, buff: ArrayBuffer): image.PixelMap | undefined {
    let pixmap: image.PixelMap;
    if (width === 0 || height === 0) {
      LogUtil.warn(TAG, 'image is empty, no conversion required');
      return undefined;
    }
    let opts: image.InitializationOptions = {
      size: {
        height: height,
        width: width
      }
    }
    try {
      pixmap = image.createPixelMapSync(buff, opts);
      return pixmap;
    } catch (error) {
      LogUtil.error(TAG, 'failed convert image pixel map because: ' +  JSON.stringify(error));
      return undefined;
    }
  }
}
