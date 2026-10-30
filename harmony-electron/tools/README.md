# 工程工具

设置 `DEVECO_PATH` 为本机 DevEco Studio 安装目录，在仓库根目录的新 PowerShell 7 会话加载：

```powershell
. ./harmony-electron/tools/Use-ElectronTools.ps1
devecocli --help
```

环境脚本使用本机 Node、JBR、SDK、HDC 和已安装的 DevEco CLI 1.2.0。HOME、TEMP、包缓存、构建缓存和日志放在仓库 `tmp/`。全局 CLI 保持原样，临时副本的版本和补丁锚点必须匹配。

`Restore-ElectronRuntime.ps1` 按 `runtime-provenance.json` 下载并校验运行时，也支持 `-ArchivePath` 使用现有 ZIP。它仅恢复原生库和运行时资源，保留 `resources/app`。脚本的本地测试使用合成 ZIP；正式归档的完整恢复尚未在本轮执行。

设备会话可选设置 `DRAWIO_PAD_ADDRESS=IP:端口`。`Electron-PadSession.ps1` 接受 `Action`、`UnlockKeys`、`MaxAwakeSeconds` 和 `Watchdog`。授权文件仅在实际调用 HDC 时从本机已有 `.harmony` 目录复制到临时工具目录；解锁参数由调用者在内存中提供。普通构建不打开远程调试端口。

结束工具与设备会话后，可清理 `tmp/`；使用中的 IDE 缓存需待对应工具退出后清理。

## 第三方许可

DevEco CLI 1.2.0 的 MIT 许可位于 [licenses/deveco-cli-LICENSE](licenses/deveco-cli-LICENSE)，版权人为 Huawei Device Co., Ltd.。临时 CLI 副本保留原包的 `LICENSE` 和 `THIRD-PARTY-LICENSES`。Node、JBR、SDK、HDC 和 Electron runtime 使用各自发行包附带的许可。
