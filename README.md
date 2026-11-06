<p align="center">
  <a href="https://stashdock.app"><img src="assets/readme/brand.png" alt="StashDock" width="600"></a>
</p>

<p align="center">English · <a href="README.zh-CN.md">简体中文</a></p>

<h1 align="center">Your context, ready for any AI.</h1>

<p align="center">
  A local, visual context library built for AI.<br>
  Keep links, files and prompts/rules ready for your next conversation.
</p>

<p align="center">
  <a href="https://stashdock.app"><img src="https://img.shields.io/badge/Website-stashdock.app-2563eb?style=flat-square" alt="Website: stashdock.app"></a>
  <a href="https://stashdock.app/guide#install-desktop"><img src="https://img.shields.io/badge/Download-Windows_%26_macOS-7c3aed?style=flat-square" alt="Download for Windows and macOS"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3-b7791f?style=flat-square" alt="License: AGPL v3"></a>
  <a href="https://chromewebstore.google.com/detail/bbglcpbhnobjhgccjinejnnlcefelkee"><img src="https://img.shields.io/badge/Chrome-Add_to_Chrome-008f55?style=flat-square&amp;logo=googlechrome&amp;logoColor=white" alt="Add to Chrome"></a>
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=0KamZB7aFMY"><img src="https://img.shields.io/badge/Video-YouTube-ff0000?style=flat-square&amp;logo=youtube&amp;logoColor=white" alt="Watch the launch film on YouTube"></a>
  <a href="https://www.bilibili.com/video/BV1ZL4c6NEmM/"><img src="https://img.shields.io/badge/Video-Bilibili-00a1d6?style=flat-square&amp;logo=bilibili&amp;logoColor=white" alt="Watch the launch film on Bilibili"></a>
</p>

<p align="center">
  <a href="https://stashdock.app/guide">Guide</a> ·
  <a href="https://github.com/StashDock/StashDock/issues">Feedback</a>
</p>

[![StashDock website](assets/readme/website.jpg)](https://stashdock.app)

## Overview

Reference links, project files and reusable prompts/rules can be spread across
browser bookmarks, local folders and previous conversations. Preparing context
for a new AI conversation can require locating and assembling that material again.

StashDock provides a local, visual library for collecting, organizing and
reusing this context. Browse reference cards, search saved material and manage
tags, then use selected references through the ChatGPT plugin or the standalone
desktop app.

## ChatGPT plugin

The **StashDock ChatGPT plugin** opens the library in a sidebar alongside the
conversation. It supports reference browsing and management, with **Add to chat**
for inserting selected references directly into the current conversation.

![Select references and add them to your AI conversation](assets/readme/ai-sidebar.gif)

## Desktop app

You can also download **StashDock Desktop**, a standalone app for Windows and
Mac. It provides a dedicated library panel for browsing and managing references,
with copy and drag-and-drop actions for use in any AI app.

The floating folder can be positioned beside other applications. Hover to open
quick search, drag a reference into a conversation, or click the folder to open
the full library.

![Search, scroll through references, drag one into AI, then open the full library](assets/readme/desktop-workflow.gif)

*Product previews use sample references. [Try them on the website](https://stashdock.app/#how).*

## Core capabilities

| Capability | Description |
| --- | --- |
| Reference import | Import bookmarks from Chrome, Edge, Firefox and Safari; add links, local files and notes for prompts/rules. Browser bookmark import does not require an extension. |
| Browser capture | Save the current page's link, available readable content and cover through the Chrome extension. Review and edit the capture before saving. |
| Visual organization | Browse reference cards in grid or list view, search the library, and manage favorites and tags. |
| Context editing | Edit the final context associated with a reference before using it with AI. |
| Context sets | Group related references with tags for reuse across projects, tasks and conversations. |

## AI integration: MCP and Skills

StashDock exposes library tools through the Model Context Protocol (MCP) and
includes a Skill for reference retrieval, saving and organization. Supported
workflows include:

- **Reference retrieval and recommendation:** identify saved material relevant to the current project or task.
- **Context capture:** save reusable notes and links from the conversation to the library.
- **Tag organization:** propose and apply tag changes, with the proposed changes available for review before application.

These capabilities support workflows such as project reference libraries,
design research and reusable prompts/rules across AI applications.

## Get StashDock

| | Desktop | ChatGPT plugin |
| --- | --- | --- |
| **Windows** · Windows 10/11, x64 | [Download installer](https://github.com/StashDock/StashDock/releases/download/v1.0.3/StashDock_1.0.3_x64-setup.exe) | [Download plugin](https://github.com/StashDock/StashDock/releases/download/v1.0.1/stashdock-plugin-1.0.1-win32-x64.zip) |
| **Mac** · macOS 14+, Apple Silicon | [Download DMG](https://github.com/StashDock/StashDock/releases/download/v1.0.0/StashDock_1.0.0_aarch64.dmg) | [Download plugin](https://github.com/StashDock/StashDock/releases/download/v1.0.0/stashdock-plugin-1.0.0-darwin-arm64.zip) |

[Add to Chrome](https://chromewebstore.google.com/detail/bbglcpbhnobjhgccjinejnnlcefelkee) · [Installation guide](https://stashdock.app/guide#install-browser)

Choose the ChatGPT plugin, the standalone Desktop app, or both. Each works on
its own; when installed together, they share the same local library.

Add the Chrome extension to save pages as you browse. Install and open Desktop
or the AI plugin once to set it up. Page saving then works even when Desktop
and the AI app are closed.

Your system may show a standard new-app verification prompt on first launch:

- **Windows:** If “Windows protected your PC” appears, click **More info → Run anyway**.
- **Mac:** If macOS prevents StashDock from opening, go to **System Settings → Privacy & Security → Open Anyway**, then confirm with **Open**.

## Local storage

References are stored on the local device. Desktop and the ChatGPT plugin
operate independently and use the same library when installed on the same
computer. Users select which references to provide to AI. Libraries on
different computers do not sync automatically.

## Technology stack

| Layer | Technologies |
| --- | --- |
| Shared interface | React 19, TypeScript, Arc UI/Radix UI, Tailwind CSS and Motion |
| Desktop application | Tauri 2 and Rust, with native Windows and macOS integrations |
| Local storage and search | SQLite with FTS5 full-text indexing |
| AI integration | Node.js, MCP SDK, MCP Apps and Skills |
| Browser extension | Chrome Manifest V3, Side Panel API and Native Messaging |
| Build tooling | Vite and esbuild |

Shared interface and library logic are reused across the desktop app and AI
plugin. Platform-specific adapters handle native application behavior, AI-host
communication and browser integration.

## License

StashDock is licensed under GNU AGPL v3.

[GNU AGPL v3 license](LICENSE) · [Licensing details](LICENSING.md) · [Third-party notices](THIRD_PARTY_NOTICES.md) ·
[Privacy](https://stashdock.app/privacy)
