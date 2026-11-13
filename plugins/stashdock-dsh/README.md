# StashDock for DeepSeek Harness

Open a conversation, expand the right sidebar, and select **StashDock** from its new-tab guide. The shelf uses the same local library and interface as the ChatGPT plugin. **Add to chat** adds links and notes as compact context quotes. Files enter the native attachment rail directly; a context quote accompanies them only when you have added supplemental instructions or selected links/notes as well. Upload progress, retry and removal use DeepSeek Harness's own controls. Your existing draft stays in place; send it from DeepSeek Harness when ready.

## Install

### With AI

Copy `https://github.com/StashDock/StashDock` into a local DeepSeek Harness conversation and ask it to install **the StashDock plugin for DeepSeek Harness** on this computer. After installation, fully quit and reopen DeepSeek Harness, then select StashDock in the right sidebar.

### Manually

Requires DeepSeek Harness 0.2.2-rc.1 or a compatible 0.2 release. Use the `stashdock-dsh-<version>-<platform>.tgz` package for your computer. For Desktop, use the `dsh` command supplied by the installed application; the standalone npm CLI cannot manage its reserved `desktop` profile.

```sh
dsh plugin --profile desktop add "/absolute/path/to/stashdock-dsh-package.tgz"
```

Restart DeepSeek Harness after adding the bundle. For a custom local Web profile, use that profile name instead of `desktop`.

## Save pages from Chrome

Open DeepSeek Harness once after installation. Install the [StashDock Chrome extension](https://chromewebstore.google.com/detail/bbglcpbhnobjhgccjinejnnlcefelkee) and use **Save page** from its sidebar. The local save component can run when DeepSeek Harness is closed.

## Update

In StashDock, choose **Settings → About → Check for updates**. Download the DSH package for your platform from the release page, add it to the same profile with the command above, then restart DeepSeek Harness.

## Build from source

Run `npm run plugin:build` followed by `npm run dsh:pack` on the target OS. The package is created under `output/dsh/<platform>/`.

The adapter uses the host's authenticated connection and session-scoped composer API. The host only enables library access for loopback deployments. Search, save, and tag operations use the shared StashDock tools and the `use-stashdock` skill.

Native-file intake is verified against DeepSeek Harness **0.2.2-rc.1** in an ordinary conversation. Its exported `ConversationController` provides draft-file creation, while the typed `IConversation` extension contract does not yet include that method. This dependency is isolated in `draft.mjs` and capability-checked at runtime. If the host does not expose it, file context retains the existing ID-based `get_stashdock_file` reading instructions. ChatGPT delivery is unchanged. Recheck this adapter when updating the DSH host.

The adapter resolves originals by saved reference ID through the shared library, streams binary data over fixed authenticated local routes and reads at most two files concurrently. It accepts up to 30 references per operation, 512 MB per file and 1 GB per batch, with DSH's current image limits applied as well. Host/model support determines which files the AI can understand. DSH owns image normalization after intake.
