// One bounded request per process. Public WebKit / PDFKit only; no user profile.
import AppKit
import WebKit
import Network
import PDFKit

struct Request: Decodable {
    let url: String?
    let proxyPort: UInt16?
    let pdf: String?
}

// This bounded, offscreen rendering surface needs animation frames even while
// it is occluded. AppKit still owns its window; no visible UI or focus is taken.
@MainActor
final class CaptureWindow: NSWindow {
    override var occlusionState: NSWindow.OcclusionState { .visible }
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class Renderer: NSObject, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView?
    private var window: NSWindow?
    private var finished = false
    private var snapshotScheduled = false
    private var navigationGeneration = 0
    private var probe: String?
    private var probeStarted = 0.0
    private var stableSince = 0.0
    private var paintSignature: UInt32?
    private var qualityDeadline = 8.0
    private var parentMonitor: DispatchSourceProcess?
    private var terminationMonitor: DispatchSourceSignal?

    func finish(_ value: [String: Any]) {
        guard !finished else { return }
        finished = true
        parentMonitor?.cancel()
        terminationMonitor?.cancel()
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        window?.orderOut(nil)
        window?.contentView = nil
        window?.close()
        webView = nil
        window = nil
        if let bytes = try? JSONSerialization.data(withJSONObject: value) {
            FileHandle.standardOutput.write(bytes)
            FileHandle.standardOutput.write(Data([10]))
        }
        // WebKit observes normal AppKit termination to release its prewarmed
        // process. Calling exit() here skips that lifecycle notification.
        NSApplication.shared.terminate(nil)
    }

    func fail(_ reason: String) { finish(["error": reason]) }

    func jpeg(_ image: NSImage, requireDetail: Bool = false) -> String? {
        guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
        if requireDetail {
            var pixels = [UInt8](repeating: 0, count: 64 * 40 * 4)
            let detailed = pixels.withUnsafeMutableBytes { bytes -> Bool in
                guard let context = CGContext(data: bytes.baseAddress, width: 64, height: 40, bitsPerComponent: 8, bytesPerRow: 64 * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
                context.draw(cgImage, in: CGRect(x: 0, y: 0, width: 64, height: 40))
                let values = bytes.bindMemory(to: UInt8.self)
                return stride(from: 4, to: values.count, by: 4).contains { index in
                    (0..<3).contains { abs(Int(values[index + $0]) - Int(values[$0])) > 12 }
                }
            }
            guard detailed else { return nil }
        }
        let normalized: CGImage
        if cgImage.width == 1280 && cgImage.height == 800 { normalized = cgImage }
        else {
            guard let context = CGContext(data: nil, width: 1280, height: 800, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: 1280, height: 800))
            guard let resized = context.makeImage() else { return nil }
            normalized = resized
        }
        let bitmap = NSBitmapImageRep(cgImage: normalized)
        guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.78]),
              data.count < 3_700_000 else { return nil }
        return "data:image/jpeg;base64," + data.base64EncodedString()
    }

    func start(_ request: Request) {
        // Main queue timeout also covers PDFKit parsing/rendering once it yields;
        // the Rust owner enforces a separate hard deadline and kills this process.
        DispatchQueue.main.asyncAfter(deadline: .now() + 19) { [weak self] in self?.fail("Screenshot timed out.") }
        signal(SIGTERM, SIG_IGN)
        let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termination.setEventHandler { NSApplication.shared.terminate(nil) }
        terminationMonitor = termination
        termination.resume()
        let parent = getppid()
        guard parent > 1 else { fail("Capture owner exited."); return }
        let monitor = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .global(qos: .utility))
        monitor.setEventHandler {
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { exit(0) }
        }
        parentMonitor = monitor
        monitor.resume()
        if let pdf = request.pdf { renderPDF(pdf); return }
        guard let probeURL = Bundle.main.url(forResource: "preview-ready", withExtension: "js"),
              let probe = try? String(contentsOf: probeURL, encoding: .utf8) else {
            fail("The renderer readiness resource is unavailable."); return
        }
        self.probe = probe
        guard let raw = request.url, let url = URL(string: raw),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.user == nil, url.password == nil,
              let port = request.proxyPort, port > 0 else {
            fail("Invalid renderer request."); return
        }
        let store = WKWebsiteDataStore.nonPersistent()
        var proxy = ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!))
        proxy.allowFailover = false
        proxy.excludedDomains = []
        store.proxyConfigurations = [proxy]
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        configuration.applicationNameForUserAgent = "StashDockPreview/1"
        // Per-view public restriction mode disables unproxied capabilities such
        // as WebRTC/WebTransport and Service Workers while ordinary page scripts
        // render. This does not change the user's device-wide Lockdown setting.
        configuration.defaultWebpagePreferences.isLockdownModeEnabled = true
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.inactiveSchedulingPolicy = .none
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserActionForPlayback = .all
        configuration.suppressesIncrementalRendering = true
        // Restrict every resource to HTTP(S) or inline data. HTTP(S)
        // destinations (including redirects/subresources) are pinned by PublicProxy.
        // CFNetwork can bypass explicit proxies for loopback. Only DNS host URLs
        // on standard web ports may leave this renderer. No IP literal, numeric/
        // hex shorthand, userinfo, single-label host or local suffix is admitted.
        let publicPattern = #"^https?://([a-z0-9-]+\.)+[a-z][a-z0-9-]+\.?"#
        var policy: [[String: Any]] = [
            ["trigger": ["url-filter": ".*"], "action": ["type": "block"]]
        ]
        // WebKit's content-rule regex subset excludes alternation. Keep each
        // allowed port/suffix in its own rule rather than broadening a regex.
        for suffix in ["/", ":80/", ":443/"] {
            policy.append(["trigger": ["url-filter": publicPattern + suffix], "action": ["type": "ignore-previous-rules"]])
        }
        policy.append(["trigger": ["url-filter": "^data:"], "action": ["type": "ignore-previous-rules"]])
        for suffix in ["localhost", "local", "internal", #"localhost\.localdomain"#] {
            policy.append(["trigger": ["url-filter": #"^https?://([a-z0-9-]+\.)*"# + suffix + #"\.?[:/]"#], "action": ["type": "block"]])
        }
        let rules = String(data: try! JSONSerialization.data(withJSONObject: policy), encoding: .utf8)!
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "stashdock-public-dns-v3", encodedContentRuleList: rules) { [weak self] list, error in
            guard let self, !self.finished else { return }
            guard let list, error == nil else {
                if let error { FileHandle.standardError.write(Data("Renderer policy: \(error)\n".utf8)) }
                self.fail("The renderer could not enforce resource restrictions."); return
            }
            configuration.userContentController.add(list)
            let frame = NSRect(x: 0, y: 0, width: 1280, height: 800)
            let view = WKWebView(frame: frame, configuration: configuration)
            view.navigationDelegate = self
            view.uiDelegate = self
            view.allowsLinkPreview = false
            let window = CaptureWindow(contentRect: NSRect(x: -20000, y: -20000, width: 1280, height: 800), styleMask: .borderless, backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.ignoresMouseEvents = true
            window.isExcludedFromWindowsMenu = true
            window.contentView = view
            window.orderBack(nil)
            self.window = window
            self.webView = view
            view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 16))
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let host = url?.host?.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")) ?? ""
        let local = ["localhost", "local", "internal", "localhost.localdomain"].contains { host == $0 || host.hasSuffix("." + $0) }
        let dns = host.range(of: #"^([a-z0-9-]+\.)+[a-z][a-z0-9-]+$"#, options: .regularExpression) != nil
        let allowed = ["http", "https"].contains(url?.scheme?.lowercased() ?? "") && url?.user == nil && url?.password == nil && dns && !local && (url?.port == nil || [80,443].contains(url!.port!))
        decisionHandler(allowed && !finished ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let response = navigationResponse.response as? HTTPURLResponse
        let attachment = response?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().contains("attachment") ?? false
        let valid = navigationResponse.canShowMIMEType && !attachment && (!navigationResponse.isForMainFrame || (response.map { (200..<300).contains($0.statusCode) } ?? false))
        decisionHandler(valid ? .allow : .cancel)
        if !valid && navigationResponse.isForMainFrame { fail("This page could not be rendered.") }
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        navigationGeneration += 1
        snapshotScheduled = false
        paintSignature = nil
        qualityDeadline = 8
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { beginReadiness(webView) }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { beginReadiness(webView) }
    private func beginReadiness(_ webView: WKWebView) {
        guard !snapshotScheduled, !finished else { return }
        snapshotScheduled = true
        probeStarted = ProcessInfo.processInfo.systemUptime
        stableSince = probeStarted
        checkReadiness(webView, generation: navigationGeneration)
    }
    private func checkReadiness(_ webView: WKWebView, generation: Int) {
        guard !finished, navigationGeneration == generation, let probe else { return }
        guard ProcessInfo.processInfo.systemUptime - probeStarted < qualityDeadline else {
            fail("The page did not produce a complete viewport in time."); return
        }
        // A still capture fast-forwards finite CSS entrance effects and pauses
        // decorative infinite effects. Application probing stays in its own
        // content world, without invoking website functions.
        let still = "for (const a of document.getAnimations().slice(0,256)) { try { const end = a.effect?.getComputedTiming().endTime; if (Number.isFinite(end)) a.finish(); else a.pause(); } catch {} };"
        webView.evaluateJavaScript(still + probe, in: nil, in: .defaultClient) { [weak self, weak webView] result in
            guard let self, let webView, !self.finished, self.navigationGeneration == generation else { return }
            let now = ProcessInfo.processInfo.systemUptime
            if case .success(let value) = result, let scene = value as? [String: Any],
               let signature = (scene["paintSignature"] as? NSNumber)?.uint32Value {
                if self.paintSignature != signature { self.stableSince = now; self.paintSignature = signature }
                let stable = now - self.stableSince >= 0.6
                let ready = scene["ready"] as? Bool == true
                let age = now - self.probeStarted
                let blocked = scene["busy"] as? Bool == true || scene["blocked"] as? Bool == true
                let subject = scene["subject"] as? Bool == true
                if stable && scene["errorPage"] as? Bool == true {
                    self.fail("The page rendered an error instead of reference content."); return
                }
                // A loading layer with content behind it, a first-screen image,
                // or recent visual progress earns one bounded extension. A
                // stagnant blank screen still stops after eight seconds.
                if age >= 7 && (now - self.stableSince < 1.5 || scene["blocked"] as? Bool == true || scene["pendingImages"] as? Bool == true) { self.qualityDeadline = 12 }
                let usefulFallback = age >= 4 && scene["pendingImages"] as? Bool != true
                if subject && !blocked && stable && age >= 0.8 && (ready || usefulFallback) {
                    self.capture(webView, generation: generation); return
                }
            }
            self.waitForReadiness(webView, generation: generation)
        }
    }
    private func waitForReadiness(_ webView: WKWebView, generation: Int) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self, weak webView] in
            guard let self, let webView else { return }
            self.checkReadiness(webView, generation: generation)
        }
    }
    private func capture(_ webView: WKWebView, generation: Int) {
        guard !finished, navigationGeneration == generation else { return }
        let configuration = WKSnapshotConfiguration()
        configuration.rect = NSRect(x: 0, y: 0, width: 1280, height: 800)
        configuration.snapshotWidth = 1280
        configuration.afterScreenUpdates = true
        webView.takeSnapshot(with: configuration) { [weak self] image, error in
            guard let self, !self.finished, self.navigationGeneration == generation else { return }
            guard error == nil, let image else { self.fail("This page could not be captured."); return }
            guard let preview = self.jpeg(image, requireDetail: true) else {
                self.waitForReadiness(webView, generation: generation); return
            }
            // An app-owned isolated-world read cannot execute page scripts. Bound
            // HTML inside WebKit before it crosses the renderer process boundary.
            let script = "({title: document.title.slice(0,500), html: document.documentElement.outerHTML.slice(0,2000000)})"
            webView.evaluateJavaScript(script, in: nil, in: .defaultClient) { [weak self] result in
                guard let self, !self.finished, self.navigationGeneration == generation else { return }
                var payload: [String: Any] = ["preview": preview]
                if case .success(let value) = result, let page = value as? [String: Any] {
                    payload["title"] = page["title"]
                    if let html = page["html"] as? String {
                        payload["html"] = String(decoding: html.utf8.prefix(2_000_000), as: UTF8.self)
                    }
                }
                self.finish(payload)
            }
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail("This page could not be rendered.") }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail("This page could not be rendered.") }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail("The screenshot renderer stopped.") }
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        completionHandler(challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust ? .performDefaultHandling : .cancelAuthenticationChallenge, nil)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) { completionHandler() }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) { completionHandler(false) }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) { completionHandler(nil) }
    @available(macOS 27.0, *)
    func webView(_ webView: WKWebView, requestGeolocationPermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }

    private func renderPDF(_ base64: String) {
        guard let data = Data(base64Encoded: base64), data.count <= 32 * 1024 * 1024,
              data.starts(with: Data("%PDF-".utf8)), let document = PDFDocument(data: data),
              !document.isLocked, (1...1000).contains(document.pageCount), let page = document.page(at: 0) else {
            fail("This PDF could not be read automatically. Enter its details manually."); return
        }
        let bounds = page.bounds(for: .cropBox)
        guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0, bounds.width <= 20000, bounds.height <= 20000 else { fail("Unsupported PDF page size."); return }
        var content = ""
        for index in 0..<document.pageCount {
            if content.count >= 50000 { break }
            let text = document.page(at: index)?.string ?? ""
            content += String(text.prefix(50000 - content.count)) + "\n\n"
        }
        content = String(content.trimmingCharacters(in: .whitespacesAndNewlines).prefix(50000))
        let title = (document.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = content.split(separator: "\n").first.map(String.init) ?? ""
        guard let context = CGContext(data: nil, width: 1280, height: 800, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fail("The PDF preview could not be rendered."); return }
        context.setFillColor(NSColor.white.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: 1280, height: 800))
        let scale = min(1120 / bounds.width, 760 / bounds.height)
        context.translateBy(x: (1280 - bounds.width * scale) / 2, y: 780 - bounds.height * scale)
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: -bounds.origin.x, y: -bounds.origin.y)
        page.draw(with: .cropBox, to: context)
        guard let image = context.makeImage(), let preview = jpeg(NSImage(cgImage: image, size: NSSize(width: 1280, height: 800))) else { fail("The PDF preview could not be rendered."); return }
        finish(["preview": preview, "title": String((title?.isEmpty == false ? title! : fallback).prefix(500)), "content": content])
    }
}

@main
struct PreviewMain {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        // One bounded JSON request; no arguments choose a file, command or output path.
        signal(SIGPIPE, SIG_IGN)
        var input = Data()
        while input.count <= 45_000_000 {
            let chunk = FileHandle.standardInput.readData(ofLength: min(65536, 45_000_001 - input.count))
            if chunk.isEmpty { break }
            input.append(chunk)
        }
        let renderer = Renderer()
        guard input.count <= 45_000_000, let request = try? JSONDecoder().decode(Request.self, from: input), (request.pdf != nil) != (request.url != nil) else {
            renderer.fail("Invalid renderer request."); return
        }
        renderer.start(request)
        withExtendedLifetime(renderer) { app.run() }
    }
}
