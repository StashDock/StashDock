# UI dependency notices

StashDock's original application code is licensed under GNU AGPL v3 only. This does not replace the licenses of its dependencies, fonts or third-party assets. See LICENSING.md for scope and earlier MIT releases.

- Arc's free components: Copyright (c) 2026 Elia Kuratli, MIT. Vendored under src/components/arc with the original license. Source: https://uiarc.dev/r/ and https://uiarc.dev/license. No Pro source is included.
- Arc's development Skill and reference documents: Copyright (c) 2026 Elia Kuratli, MIT; the original license is retained in `.agents/skills/arc/LICENSE`.
- Motion 14.0.0: MIT, including its matching framer-motion runtime dependency. Source: https://github.com/motiondivision/motion.
- Lucide React: ISC, with the upstream additional icon attribution included in its license. Source: https://github.com/lucide-icons/lucide.
- Markdown previews use react-markdown and remark-gfm (MIT) with their unified ecosystem dependencies. Source: https://github.com/remarkjs/react-markdown and https://github.com/remarkjs/remark-gfm. The plugin build retains the licenses of bundled packages.
- Iconify React, vscode-icons and Icons8 Flat Color Icons: MIT. StashDock imports a fixed local subset of their colorful file-type artwork through Iconify's offline renderer. Sources: https://github.com/iconify/iconify, https://github.com/vscode-icons/vscode-icons and https://github.com/icons8/flat-color-icons. Original icon geometry and colors are retained.
- Inter: Copyright 2016 The Inter Project Authors, SIL Open Font License 1.1. Source: https://github.com/rsms/inter. Distributed unmodified through Fontsource.
- Geist: Copyright 2024 The Geist Project Authors, SIL Open Font License 1.1. Source: https://github.com/vercel/geist-font. Distributed unmodified through Fontsource.
- Archived builds using drag 2.1.1: Copyright CrabNebula Ltd., MIT or Apache-2.0. Source: https://github.com/crabnebula-dev/drag-rs. Current outgoing file transport uses the Windows bindings directly; the archived executables still include unmodified drag 2.1.1.

Full notices are retained in public/licenses and copied by Vite into the packaged frontend. Other dependency notices remain in their npm/Cargo distributions; this is an inventory of the UI dependencies introduced during Arc adoption, not an exhaustive license audit.

The plain-HTML browser extension also distributes Arc foundation, the unmodified
Inter font and official Lucide SVGs. Their original notices are copied to
extension/ui by scripts/sync-extension-ui.mjs. Its save-only popup bundles React,
Motion and Radix with the dependency licenses in extension/ui/notices.

The MCP App plugin bundles the official MCP SDK, MCP Apps SDK and OpenAI MCP
Extensions SDK. `scripts/build-mcp-app.mjs` copies the original license files for
the packages actually bundled in the UI/server, embedded fonts and Arc into
`plugins/stashdock/notices`, with a generated dependency/version inventory. The
portable plugin therefore retains its notices without shipping node_modules.

Desktop web previews additionally use image 0.25.10 and resvg 0.45.1 (without
font/system-resource features), under their MIT license option. Their original
notices are retained in public/licenses and copied into the packaged frontend.
Windows capture uses webview2-com (MIT) and windows-rs (MIT/Apache-2.0) against
the OS Evergreen WebView2 Runtime; Chrome/Edge binaries are not redistributed.
The Windows MCP plugin includes the unchanged official Node.js executable and
its complete license/third-party notice file in `notices/Node.js-LICENSE`.
# Browser page capture

Mozilla Readability 0.6.0 is bundled in the browser extension (Apache-2.0).
The original license and notice ship as `extension/ui/READABILITY-LICENSE`
and `extension/ui/READABILITY-NOTICE`. Upstream: https://github.com/mozilla/readability.

# Platform source marks

The Zhihu, Instagram, Reddit and LinkedIn source icons are from Simple Icons,
licensed under CC0-1.0. The full license is included in
`public/licenses/SimpleIcons-CC0.txt` and the packaged Codex notices.
Brand trademarks remain the property of their respective owners.
The Xiaohongshu PNG is the unmodified asset supplied by the user for this project.
