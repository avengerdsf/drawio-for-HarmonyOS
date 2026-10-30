# 代码与运行时来源

| 内容 | 来源 | 版本或校验 |
| --- | --- | --- |
| 仓库根目录 Web 源码 | [jgraph/drawio](https://github.com/jgraph/drawio) | 原有 `dev` 提交 `84487b4891cbc0f32d7e30f34cf878c87cb1f414` |
| 内置 Desktop 程序 | [jgraph/drawio-desktop](https://github.com/jgraph/drawio-desktop/tree/v32.6.1) | 32.6.1；文件校验见 `verification/windows-app-32.6.1-manifest.json` |
| HarmonyOS Electron 运行时与宿主基础 | [CPF-Electron/Electron](https://gitcode.com/CPF-Electron/Electron) | 归档 v37.2.1；API target 提交 `cc29ebbebf505ea8e68290e998212eec6b4b4e3b` |
| 窗口 SVG | DevEco Studio SDK Previewer 的 container-modal 资源 | API 26；原字节及 SHA-256 见 `window-controls-provenance.json` |
| 本机 CLI 工具 | DevEco CLI | 1.2.0；MIT 许可见 `harmony-electron/tools/licenses/deveco-cli-LICENSE` |

内置 Desktop 位于 `harmony-electron/web_engine/src/main/resources/resfile/resources/app/upstream/`，其 `LICENSE` 为 GPL-3.0，内嵌 `drawio/LICENSE` 为 Apache-2.0。图片、图形库、模板及 Node 依赖的许可文件随原目录保留。仓库根目录 `LICENSE` 沿用原 Web 项目许可，各组件适用其对应许可。

运行时 ZIP 的下载 URL、字节数和 SHA-256 固定在 `harmony-electron/runtime-provenance.json`。二进制依赖由恢复脚本获取，使用时同时保留并遵循对应发行包的许可和第三方声明。

鸿蒙适配涉及窗口、文件与系统集成、权限、剪贴板、导出和输入处理；内置 Desktop 原包不作源码改写。
