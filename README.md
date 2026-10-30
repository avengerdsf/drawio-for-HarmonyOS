# draw.io for HarmonyOS PC

基于 draw.io Desktop **32.6.1** 的 HarmonyOS PC 应用，版本号 **32006001**，包名 `com.example.diagramdesk`。应用仅声明 `2in1`，架构为 `arm64`，支持在 Pad 上使用 PC 界面、多窗口和键鼠操作。

原 draw.io Web 源码保留在仓库根目录的 `src/`，原说明见 [上游 README](docs/README-upstream.md)。当前鸿蒙工程位于 [harmony-electron](harmony-electron/)。

## 工程内容

- `harmony-electron/electron/`：应用入口、文件格式关联、权限和窗口生命周期。
- `harmony-electron/web_engine/`：HarmonyOS Electron 宿主、原生接口和窗口适配。
- `harmony-electron/web_engine/src/main/resources/resfile/resources/app/`：启动桥接、HDS SVG 窗口控件及原版 draw.io Desktop 程序。
- `verification/`：主机回归测试源码和上游文件 SHA-256 清单。

原版 Desktop 的 4,068 个文件保留原字节，包含应用实际使用的 Node 依赖及许可证。下载缓存、构建目录、安装包、设备截图、调试日志、签名和本机授权资料均不纳入源码。

## 构建

需要 Windows、DevEco Studio 及 HarmonyOS SDK API 26、PowerShell 7、DevEco CLI 1.2.0。运行时来源和校验值见 [runtime-provenance.json](harmony-electron/runtime-provenance.json)。

1. 设置 `DEVECO_PATH` 为本机 DevEco Studio 安装目录；将官方安装的 `devecocli`、`ohpm` 加入 PATH。
2. 在仓库根目录恢复 HarmonyOS Electron 运行时：

   ```powershell
   ./harmony-electron/tools/Restore-ElectronRuntime.ps1
   ```

   已下载对应 ZIP 时可传 `-ArchivePath <zip路径>`，仍会校验大小与 SHA-256。应用源码不由运行时归档覆盖。

3. 安装工程依赖并构建：

   ```powershell
   . ./harmony-electron/tools/Use-ElectronTools.ps1
   Set-Location harmony-electron
   ohpm install
   devecocli build
   ```

4. 真机安装前，用 DevEco Studio 打开 `harmony-electron`，为自己的设备配置签名。签名和本地 SDK 配置由使用者生成；安装时保留已有应用数据。

环境脚本将临时文件放在仓库 `tmp/`，设备地址通过可选环境变量 `DRAWIO_PAD_ADDRESS` 提供。[工具说明](harmony-electron/tools/README.md)

## 验证范围

本地验收记录：主机适配回归 260/260，真机窗口检查 7/7。功能基线覆盖多开、剪贴板、六格式保存与文件打开方式、导入导出、系统打印保存 PDF、权限拒绝与恢复。普通 Pad 模式隐藏应用窗口三键、保留系统时间并同步背景；自由多窗保留 HDS 三键。

实机范围为 WEB-W00、HarmonyOS 7、API 26；包声明最低 API 17。其他版本、机型及实体打印机输出尚未实机验证。在线更新不在本项目范围。主机测试命令见 [验证说明](verification/README.md)。

## 来源与许可

draw.io Desktop 32.6.1、draw.io Web、HarmonyOS Electron 及各依赖保留各自许可，见 [来源说明](docs/HARMONY-SOURCES.md)。
