// Copyright (c) 2026. Licensed under the project's BSD-style license.

import { AppWindowAdapter } from '../adapter/AppWindowAdapter';
import { WindowCaptionController } from '../common/WindowCaptionController';
import { ContextType } from '../common/Constants';
import Inject from '../common/InjectModule';
import { WindowPreferences } from '../interface/CommonInterface';
import JsBindingUtils from '../utils/JsBindingUtils';
import LogUtil from '../utils/LogUtil';

@Component
export struct NativeWindowCaption {
  @LocalStorageProp('xcomponentId') xComponentId: string = '';
  @LocalStorageProp('nativeCaptionVisible') visible: boolean = false;
  @LocalStorageProp('nativeCaptionNormalPadMode') normalPadMode: boolean = false;
  @LocalStorageProp('nativeCaptionPreferences') preferences: WindowPreferences = {
    hideTitleBar: false, minimizable: false, maximizable: false, closable: false
  };
  private controller: WindowCaptionController | undefined = undefined;

  aboutToAppear(): void {
    this.controller = new WindowCaptionController(this.xComponentId, Inject.getOrCreate(AppWindowAdapter),
      JsBindingUtils.getNativeContext(ContextType.kMainProcess));
    LogUtil.info('NativeWindowCaption', WindowCaptionController.VERSION + ' ' + this.xComponentId +
      ' preferences=' + JSON.stringify(this.preferences));
  }

  aboutToDisappear(): void {
    this.controller = undefined;
  }

  build() {
    if (this.visible && this.preferences.hideTitleBar && !this.normalPadMode) {
      Row() {
        // Reserve the existing icon and clickable document title. Only the first-row blank moves the window.
        Blank().width(240).hitTestBehavior(HitTestMode.None)
        Blank()
          .layoutWeight(1)
          .height(32)
          .id('drawio-caption-drag')
          .hitTestBehavior(HitTestMode.Transparent)
          .onTouch((event: TouchEvent) => {
            this.controller?.handleTouch(event);
          })
        Blank().width(108).height(32).hitTestBehavior(HitTestMode.None)
      }
      .width('100%')
      .height(32)
      .hitTestBehavior(HitTestMode.Transparent)
      .id(WindowCaptionController.VERSION)
    }
  }
}
