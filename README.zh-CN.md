<p align="center">
  <a href="https://stashdock.app"><img src="assets/readme/brand.png" alt="StashDock" width="600"></a>
</p>

<p align="center"><a href="README.md">English</a> · 简体中文</p>

<h1 align="center">你的上下文，随时交给任何 AI。</h1>

<p align="center">
  为 AI 而生的本地可视化上下文收藏夹。<br>
  收好链接、文件和 Prompt/规则，随时带进下一次对话。
</p>

<p align="center">
  <a href="https://stashdock.app"><img src="https://img.shields.io/badge/Website-stashdock.app-2563eb?style=flat-square" alt="官网：stashdock.app"></a>
  <a href="https://stashdock.app/guide#install-desktop"><img src="https://img.shields.io/badge/Download-Windows_%26_macOS-7c3aed?style=flat-square" alt="下载 Windows 和 macOS 版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-b7791f?style=flat-square" alt="许可证：AGPL v3"></a>
  <a href="https://chromewebstore.google.com/detail/bbglcpbhnobjhgccjinejnnlcefelkee"><img src="https://img.shields.io/badge/Chrome-Add_to_Chrome-008f55?style=flat-square&amp;logo=googlechrome&amp;logoColor=white" alt="添加至 Chrome"></a>
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=0KamZB7aFMY"><img src="https://img.shields.io/badge/Video-YouTube-ff0000?style=flat-square&amp;logo=youtube&amp;logoColor=white" alt="在 YouTube 观看宣传片"></a>
  <a href="https://www.bilibili.com/video/BV1ZL4c6NEmM/"><img src="https://img.shields.io/badge/Video-Bilibili-00a1d6?style=flat-square&amp;logo=bilibili&amp;logoColor=white" alt="在 Bilibili 观看宣传片"></a>
</p>

<p align="center">
  <a href="https://stashdock.app/guide">使用指南</a> ·
  <a href="https://github.com/StashDock/StashDock/issues">反馈</a>
</p>

[![StashDock 官网](assets/readme/website.jpg)](https://stashdock.app)

## 产品概述

参考链接、项目文件和可复用的 Prompt/规则，可能分散在浏览器收藏夹、本地文件夹和历史对话中。为新的 AI 对话准备上下文时，往往需要重新定位并汇集这些资料。

StashDock 提供本地可视化收藏库，用于集中收集、组织和复用这些上下文。用户可以通过卡片浏览、搜索和标签管理参考，再通过 ChatGPT 插件或独立桌面应用，将选定内容用于 AI 对话。

## ChatGPT 插件

**StashDock ChatGPT 插件**在对话侧边栏中提供收藏库，支持参考浏览与管理。选中参考后，通过 **Add to chat（添加到对话）** 可直接加入当前聊天。

![选择收藏并添加到 AI 对话](assets/readme/ai-sidebar.gif)

## 独立桌面应用

你也可以下载 **StashDock Desktop**，在 Windows 或 Mac 上使用独立桌面应用。桌面端提供专属收藏库面板，支持参考浏览与管理，并通过复制、拖拽将参考用于任意 AI 应用。

悬浮文件夹可定位在其他应用旁。悬停打开快捷搜索，拖拽参考至对话，或点击文件夹展开完整收藏库。

![搜索、滚动浏览卡片、拖入 AI，再打开完整收藏库](assets/readme/desktop-workflow.gif)

*演示使用示例收藏。[在官网亲自试试](https://stashdock.app/#how)。*

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 参考导入 | 从 Chrome、Edge、Firefox 和 Safari 导入书签，添加链接、本地文件和用于保存 Prompt/规则的笔记。浏览器书签导入无需安装扩展。 |
| 网页采集 | 通过 Chrome 扩展保存当前网页的链接、可获取的正文和封面，支持保存前查看与编辑。 |
| 可视化管理 | 支持网格与列表视图、收藏库搜索，以及收藏标记和标签管理。 |
| 上下文编辑 | 编辑参考最终提供给 AI 的上下文。 |
| 上下文组合 | 使用标签组织相关参考，为项目、任务和后续对话复用。 |

## AI 集成：MCP 与 Skills

StashDock 通过 Model Context Protocol（MCP）提供收藏库工具，并随附用于参考检索、保存和整理的 Skill。支持的工作流包括：

- **参考检索与推荐：**根据当前项目或任务查找相关收藏。
- **上下文保存：**将对话中可复用的笔记与链接保存到收藏库。
- **标签整理：**规划并应用标签调整，支持在应用前查看变更方案。

这些能力可用于项目参考库、设计研究，以及跨 AI 应用的 Prompt/规则复用等工作流。

## 下载 StashDock

| | 桌面应用 | ChatGPT 插件 |
| --- | --- | --- |
| **Windows** · Windows 10/11，x64 | [下载安装包](https://github.com/StashDock/StashDock/releases/download/v1.0.3/StashDock_1.0.3_x64-setup.exe) | [下载插件](https://github.com/StashDock/StashDock/releases/download/v1.0.1/stashdock-plugin-1.0.1-win32-x64.zip) |
| **Mac** · macOS 14+，Apple 芯片 | [下载 DMG](https://github.com/StashDock/StashDock/releases/download/v1.0.0/StashDock_1.0.0_aarch64.dmg) | [下载插件](https://github.com/StashDock/StashDock/releases/download/v1.0.0/stashdock-plugin-1.0.0-darwin-arm64.zip) |

[添加至 Chrome](https://chromewebstore.google.com/detail/bbglcpbhnobjhgccjinejnnlcefelkee) · [安装指南](https://stashdock.app/guide#install-browser)

ChatGPT 插件和独立桌面应用可任选其一，也可以同时安装。两者都能独立使用，同时安装时共享同一份本地收藏库。

需要随手保存网页时，再安装 Chrome 扩展。安装并打开桌面应用或 AI 插件一次，完成配置后，即使两端都已退出，扩展仍能保存网页。

首次打开时，系统可能显示新应用的常规验证提示：

- **Windows：**如果出现「Windows 已保护你的电脑」，点击 **更多信息 → 仍要运行**。
- **Mac：**如果 macOS 提示无法打开 StashDock，进入 **系统设置 → 隐私与安全性 → 仍要打开**，再点击 **打开**。

## 本地存储

收藏保存在本地设备。桌面应用与 ChatGPT 插件均可独立运行，在同一台电脑上使用同一份收藏库。用户自行选择提供给 AI 的参考，不同电脑之间不会自动同步收藏库。

## 技术栈

| 层次 | 技术 |
| --- | --- |
| 共享界面 | React 19、TypeScript、Arc UI/Radix UI、Tailwind CSS、Motion |
| 桌面应用 | Tauri 2、Rust，以及 Windows、macOS 原生集成 |
| 本地存储与检索 | SQLite、FTS5 全文索引 |
| AI 集成 | Node.js、MCP SDK、MCP Apps、Skills |
| 浏览器扩展 | Chrome Manifest V3、Side Panel API、Native Messaging |
| 构建工具 | Vite、esbuild |

桌面应用与 AI 插件复用共享界面和收藏库逻辑，平台适配层负责原生应用行为、AI 宿主通信及浏览器集成。

## 许可证

StashDock 以 GNU AGPL v3 协议开源。

[GNU AGPL v3 许可证](LICENSE) · [许可说明](LICENSING.md) · [第三方软件声明](THIRD_PARTY_NOTICES.md) ·
[隐私政策](https://stashdock.app/privacy)
