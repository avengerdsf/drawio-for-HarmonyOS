# 主机回归测试

22 个 `*.test.mjs` 共 260 项，覆盖 Electron 桥接、窗口、输入、剪贴板、文件权限、导出、字体和生命周期。完整性测试逐个核验内置 Desktop 原包的 4,068 个文件。

需要 Node.js 24、DevEco Studio，以及 `harmony-electron/web_engine` 的 ohpm 依赖。先按根目录构建说明安装依赖。

在仓库根目录的 PowerShell 7 执行：

```powershell
$env:DEVECO_PATH = '<DevEco Studio安装目录>'
New-Item -ItemType Directory -Force tmp | Out-Null
$env:TEMP = Join-Path $PWD 'tmp'
$env:TMP = $env:TEMP
$env:NODE_DISABLE_COMPILE_CACHE = '1'
$tests = Get-ChildItem verification -File -Filter '*.test.mjs' |
    Sort-Object Name | Select-Object -ExpandProperty FullName
node --test --test-reporter=tap @tests
```

SDK 布局不同的安装可设置 `ARKTS_TYPESCRIPT` 指向 hvigor TypeScript 模块、`ARKTS_LOADER` 指向 SDK `ets-loader` 目录。

这些测试不会启动设备或应用界面；真机系统接口和交互须在对应设备上验证。`NativeAcceptanceCleanup.ets` 是主机测试用的清理实现样本，不加入应用模块入口。

运行时恢复脚本的合成 ZIP 测试：

```powershell
./harmony-electron/tools/Restore-ElectronRuntime.test.ps1
```

设备截图、原始 dump、运行日志、导出测试文件及测试生成目录不保存在源码仓库。
