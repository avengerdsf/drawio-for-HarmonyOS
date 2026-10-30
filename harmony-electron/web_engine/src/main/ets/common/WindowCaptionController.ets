// Copyright (c) 2026. Licensed under the project's BSD-style license.

import window from '@ohos.window';
import { AppWindowAdapter } from '../adapter/AppWindowAdapter';
import { NativeContext } from '../interface/CommonInterface';
import { ConfigData } from './Constants';

export class WindowCaptionController {
  static VERSION: string = 'drawio-native-caption-v5';
  private windowId: string;
  private adapter: AppWindowAdapter;
  private nativeContext: NativeContext;
  private pointerId: number = -1;
  private startX: number = 0;
  private startY: number = 0;
  private moving: boolean = false;
  constructor(windowId: string, adapter: AppWindowAdapter, nativeContext: NativeContext) {
    this.windowId = windowId;
    this.adapter = adapter;
    this.nativeContext = nativeContext;
  }

  private getId(): number {
    return Number(this.windowId.substring(ConfigData.WINDOW_PREFIX.length));
  }

  minimize(): void {
    this.adapter.minimize(this.getId());
  }

  toggleMaximize(): void {
    let status = this.adapter.getWindowStatus(this.getId());
    if (status === window.WindowStatusType.FULL_SCREEN) {
      this.adapter.setFullScreen(false, this.getId());
    } else if (status === window.WindowStatusType.MAXIMIZE) {
      this.adapter.unMaximize(this.getId());
    } else {
      this.adapter.maximize(this.getId());
    }
  }

  close(): void {
    // Same event as WebAbility.windowStageClose; Electron handles cancellation and unsaved documents.
    this.nativeContext.OnWindowEvent(this.windowId, 1000);
  }

  startMoving(): void {
    this.adapter.startWindowMoving(this.getId());
  }

  handleTouch(event: TouchEvent): void {
    if (event.type === TouchType.Up || event.type === TouchType.Cancel || event.touches.length !== 1) {
      this.pointerId = -1;
      return;
    }
    const point = event.touches[0];
    if (event.type === TouchType.Down) {
      this.pointerId = point.id;
      this.startX = point.displayX;
      this.startY = point.displayY;
      this.moving = false;
    } else if (event.type === TouchType.Move && point.id === this.pointerId && !this.moving &&
      Math.hypot(point.displayX - this.startX, point.displayY - this.startY) >= 8) {
      this.moving = true;
      this.startMoving();
    }
  }
}
