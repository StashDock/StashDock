// In-process AppKit lifecycle. Shared Rust owns search, export and placement.
import AppKit
import QuartzCore

private typealias EventSink = @convention(c) (UnsafePointer<CChar>) -> Void
@MainActor final class SearchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    // This accessory is anchored to the folder, including at screen edges.
    // AppKit's default top-edge constraint moves the entire transparent panel
    // down, breaking that anchor even though Rust placed it correctly above.
    override func constrainFrameRect(_ frameRect:NSRect,to screen:NSScreen?) -> NSRect { frameRect }
}
@MainActor final class SearchCanvas: NSView {
    weak var owner: SearchOwner?
    override var isFlipped: Bool { true }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); owner?.updateAppearance() }
    override func scrollWheel(with event:NSEvent) { owner?.flow.scrollWheel(with:event) }
}

@MainActor final class SearchOwner: NSObject, NSTextFieldDelegate, NSWindowDelegate {
    let panel: SearchPanel
    let canvas = SearchCanvas(frame:NSRect(x:0,y:0,width:480,height:316))
    let input = SearchInput(frame:.zero)
    let clear = ClearSearchButton(frame:NSRect(x:143,y:10,width:24,height:24))
    let magnifier = NSImageView(frame:NSRect(x:17,y:13,width:18,height:18))
    let fieldSurface = SearchSurface(frame:.zero)
    let status = NSTextField(labelWithString:"")
    var flow = SearchFlow(frame:.zero)
    private var retiringFlow: SearchFlow?
    private var retirement: DispatchWorkItem?
    private let callback: EventSink
    var attached = false, open = false, folderHover = false, searchHover = false, dragging = false
    private(set) var folderGestureActive = false
    var pendingCopies: Set<String> = []
    var copyPending: Bool { !cards.isEmpty && pendingCopies.contains(cards[cardIndex].id) }
    var flowFocused = false
    var draggingFlow: SearchFlow?
    var chinese = false, dark = false
    var anchor = 240.0
    var cards: [SearchCard] = []
    var selected = 0
    var cardIndex: Int { cards.isEmpty ? 0 : ((selected % cards.count)+cards.count)%cards.count }
    var copiedId = ""
    var session = UUID().uuidString
    var queryToken = ""
    private var requestedMarks:Set<String> = []
    private var controls: [String:NSImage] = [:]
    private var intent: DispatchWorkItem?, searchWork: DispatchWorkItem?, exitWork: DispatchWorkItem?, copyWork: DispatchWorkItem?
    private var localMonitor: Any?, globalMonitor: Any?
    private var priorApp: NSRunningApplication?, priorWindow: NSWindow?
    private var takingFocus = false
    private var intentGeneration:UInt64 = 0
    init(callback: @escaping @convention(c) (UnsafePointer<CChar>) -> Void) {
        self.callback = callback
        panel = SearchPanel(contentRect:canvas.bounds,styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
        super.init()
        panel.title = "StashDock Quick Search"; panel.isReleasedWhenClosed = false
        panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false
        panel.level = .floating; panel.hidesOnDeactivate = false; panel.acceptsMouseMovedEvents = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces,.fullScreenAuxiliary,.ignoresCycle]
        panel.contentView = canvas; panel.delegate = self
        canvas.owner = self; canvas.wantsLayer = true; canvas.clipsToBounds = false
        flow.owner = self; canvas.addSubview(flow)
        fieldSurface.owner = self; canvas.addSubview(fieldSurface)
        fieldSurface.addSubview(magnifier)
        input.cell = CenteredSearchCell(textCell:"")
        input.frame = NSRect(x:43,y:0,width:92,height:44)
        input.owner = self; input.delegate = self
        input.isBordered = false; input.isBezeled = false; input.drawsBackground = false
        input.isEditable = true; input.isSelectable = true
        input.focusRingType = .none; input.font = SearchTypeface.font(14)
        input.setAccessibilitySubrole(.searchField)
        input.cell?.isScrollable = true; input.cell?.usesSingleLineMode = true
        input.isAutomaticTextCompletionEnabled = false
        fieldSurface.addSubview(input)
        clear.owner = self; fieldSurface.addSubview(clear)
        input.nextKeyView = clear; clear.nextKeyView = flow; flow.nextKeyView = input
        status.font = SearchTypeface.font(14); status.alignment = .center
        status.setAccessibilityRole(.staticText); canvas.addSubview(status)
        NotificationCenter.default.addObserver(self,selector:#selector(screenChanged),name:NSApplication.didChangeScreenParametersNotification,object:nil)
        NSWorkspace.shared.notificationCenter.addObserver(self,selector:#selector(willSleep),name:NSWorkspace.willSleepNotification,object:nil)
        NSWorkspace.shared.notificationCenter.addObserver(self,selector:#selector(accessibilityChanged),name:NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,object:nil)
    }
    func text(_ en:String,_ zh:String) -> String { chinese ? zh : en }
    func localized(_ label:String) -> String {
        guard chinese else { return label }
        return ["Note":"笔记","Web page":"网页","Repository":"代码仓库","Image":"图片","Document":"文档","Spreadsheet":"电子表格","Presentation":"演示文稿","Archive":"压缩包","Video":"视频","Audio":"音频","Structured data":"结构化数据","Code":"代码","Text file":"文本文件","File":"文件"][label] ?? label
    }
    func color(_ role:String) -> NSColor { SearchDesign.color(SearchDesign.theme(dark)[role]) }
    func controlImage(_ name:String,role:String) -> NSImage? { controls["control_\(dark ? "dark" : "light")_\(role)_\(name)"] }
    func send(_ action:String,_ extra:[String:Any] = [:],session scope:String? = nil) {
        var message = extra; message["action"] = action; message["session"] = scope ?? session
        guard let data = try? JSONSerialization.data(withJSONObject:message), let raw = String(data:data,encoding:.utf8) else { return }
        raw.withCString { callback($0) }
    }
    func configure(_ data:[String:Any]) {
        chinese = data["chinese"] as? Bool ?? false
        let theme = data["theme"] as? String
        panel.appearance = theme == "light" ? NSAppearance(named:.aqua) : theme == "dark" ? NSAppearance(named:.darkAqua) : nil
        if let assets = data["controls"] as? [String:String] { controls = assets.compactMapValues(decodeSearchImage) }
        input.placeholderString = text("Search","搜索")
        input.setAccessibilityLabel(text("Search references","搜索收藏"))
        clear.setAccessibilityLabel(text("Clear search","清除搜索"))
        anchor = data["anchor"] as? Double ?? 240
        if let x = data["x"] as? Double, let y = data["y"] as? Double { panel.setFrame(NSRect(x:x,y:y,width:480,height:316),display:false) }
        fieldSurface.frame = NSRect(x:anchor-92,y:240,width:184,height:44)
        placeFlow(flow)
        status.frame = NSRect(x:anchor-230,y:207,width:460,height:21)
        updateAppearance()
        if open { updatePointer() }
    }
    private func placeFlow(_ view:SearchFlow) {
        view.frame = NSRect(x:anchor-230,y:52,width:460,height:176)
        view.place()
    }
    func updateAppearance() {
        let match = (panel.appearance ?? NSApp.effectiveAppearance).bestMatch(from:[.aqua,.darkAqua])
        dark = match == .darkAqua
        input.textColor = color("foreground")
        input.placeholderAttributedString = NSAttributedString(string:text("Search","搜索"),attributes:[.font:SearchTypeface.font(14),.foregroundColor:color("text-muted"),.kern:-0.14])
        magnifier.image = controlImage("search",role:input.stringValue.isEmpty && !panel.isKeyWindow ? "text-muted" : "foreground")
        clear.refresh(); fieldSurface.refresh(); flow.refreshCards(); status.textColor = color("text-secondary")
    }
    func hover(_ inside:Bool) { folderHover = inside && !folderGestureActive; scheduleIntent() }
    func folderGesture(_ active:Bool) {
        folderGestureActive = active
        folderHover = false; searchHover = false
        if active { close(immediate:true) }
        // The native release first configures the new position, then reports a
        // fresh hover. No old tracking event/intent may reopen the old frame.
    }
    func detach(hide:Bool) {
        if hide { attached = false; folderGestureActive = false }
        folderHover = false; searchHover = false
        close(immediate:true)
    }
    private func wantsOpen() -> Bool { attached && !folderGestureActive && (folderHover || searchHover || !input.stringValue.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || panel.isKeyWindow || dragging) }
    private func cancelIntent() { intentGeneration &+= 1; intent?.cancel(); intent = nil }
    private func scheduleIntent() {
        if wantsOpen() == open { cancelIntent(); return }
        // Repeated mouseMoved reports are not a new enter/leave. Windows
        // reports pointer transitions; don't restart its 180ms clock per move.
        guard intent == nil else { return }
        intentGeneration &+= 1
        let generation = intentGeneration
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.intentGeneration == generation else { return }
            self.intent = nil
            guard self.wantsOpen() != self.open else { return }
            if self.wantsOpen() { self.show() } else { self.close() }
        }
        intent = work; DispatchQueue.main.asyncAfter(deadline:.now()+SearchDesign.interaction("intent"),execute:work)
    }
    private func show() {
        guard attached && !folderGestureActive else { return }
        let reversing = panel.isVisible && exitWork != nil
        exitWork?.cancel(); exitWork = nil; retirement?.cancel()
        session = UUID().uuidString; open = true; requestedMarks = []
        input.stringValue = ""; cards = []; selected = 0; copiedId = ""; flowFocused = false
        status.stringValue = ""; clear.setShown(false,immediate:true)
        flow.reset(); retiringFlow?.removeFromSuperview(); retiringFlow = nil
        fieldSurface.isHidden = false
        panel.orderFrontRegardless(); installMonitors(); updatePointer(); updateAppearance()
        visibility(fieldSurface.layer!,showing:true,field:true,initial:!reversing)
        send("visibility",["visible":true])
    }
    func focusSearch() {
        guard attached && !folderGestureActive else { return }
        if !open { show() }
        priorApp = NSWorkspace.shared.frontmostApplication; priorWindow = NSApp.keyWindow
        panel.makeKey(); panel.makeFirstResponder(input); cancelIntent(); updateAppearance()
    }
    func close(immediate:Bool = false,restoreFocus:Bool = false) {
        cancelIntent(); searchWork?.cancel(); exitWork?.cancel(); copyWork?.cancel(); retirement?.cancel()
        let wasOpen = open
        open = false; pendingCopies = []; queryToken = ""; requestedMarks = []; session = UUID().uuidString
        folderHover = false; searchHover = false
        flow.cancelHoverTracking(); retiringFlow?.cancelHoverTracking()
        removeMonitors(); panel.ignoresMouseEvents = true
        if panel.isKeyWindow { panel.resignKey() }
        if restoreFocus {
            if priorApp?.processIdentifier == ProcessInfo.processInfo.processIdentifier, let priorWindow, priorWindow.isVisible { priorWindow.makeKey() }
            else if let priorApp, !priorApp.isTerminated, NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier { priorApp.activate(options:[]) }
        }
        priorApp = nil; priorWindow = nil
        if immediate || SearchDesign.reduced { panel.orderOut(nil); flow.reset(); retiringFlow?.removeFromSuperview(); retiringFlow = nil }
        else if wasOpen {
            flow.animateVisibility(showing:false)
            retiringFlow?.animateVisibility(showing:false)
            visibility(fieldSurface.layer!,showing:false,field:true)
            status.stringValue = ""
            let closingSession = session
            let work = DispatchWorkItem { [weak self] in
                guard let self, !self.open, self.session == closingSession else { return }
                self.panel.orderOut(nil); self.flow.reset(); self.retiringFlow?.removeFromSuperview(); self.retiringFlow = nil; self.exitWork = nil
            }
            exitWork = work; DispatchQueue.main.asyncAfter(deadline:.now()+SearchDesign.interaction("closeStagger")+SearchDesign.duration("standard"),execute:work)
        }
        input.stringValue = ""; cards = []; copiedId = ""
        if wasOpen { send("visibility",["visible":false,"releaseDelay":immediate || SearchDesign.reduced ? 0 : SearchDesign.interaction("folderRelease")]) }
    }
    func updatePointer(at screenPoint:NSPoint? = nil) {
        guard open else { return }
        let local = canvas.convert(panel.convertPoint(fromScreen:screenPoint ?? NSEvent.mouseLocation),from:nil)
        // The same settled field+shadow and flow+shadow regions as Windows.
        let fieldRegion = fieldSurface.frame.insetBy(dx:-32,dy:-32)
        let flowRegion = NSRect(x:0,y:flow.frame.minY-40,width:480,height:240)
        searchHover = fieldRegion.contains(local) || (!cards.isEmpty && flowRegion.contains(local)) || (!status.stringValue.isEmpty && status.frame.insetBy(dx:-8,dy:-8).contains(local))
        panel.ignoresMouseEvents = !searchHover && !dragging
        flow.trackPointer(flow.convert(local,from:canvas)); scheduleIntent()
    }
    private func installMonitors() {
        removeMonitors()
        let mask:NSEvent.EventTypeMask = [.mouseMoved,.leftMouseDown,.rightMouseDown]
        localMonitor = NSEvent.addLocalMonitorForEvents(matching:mask.union(.scrollWheel)) { [weak self] event in
            guard let self else { return event }
            if event.type == .scrollWheel, event.window === self.panel, !self.cards.isEmpty {
                self.flow.scrollWheel(with:event); return nil
            }
            self.updatePointer(at:event.window?.convertPoint(toScreen:event.locationInWindow))
            if event.type != .mouseMoved {
                if event.window !== self.panel && !self.folderHover { self.close() }
                else if event.window === self.panel && self.fieldSurface.frame.contains(self.canvas.convert(event.locationInWindow,from:nil)) && !self.panel.isKeyWindow {
                    self.takingFocus = true
                    self.priorApp = NSWorkspace.shared.frontmostApplication; self.priorWindow = NSApp.keyWindow
                    self.panel.makeKey(); self.takingFocus = false; self.updateAppearance()
                }
            }
            return event
        }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching:mask) { [weak self] event in
            self?.updatePointer(); if event.type != .mouseMoved { self?.close() }
        }
    }
    private func removeMonitors() {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }; if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        localMonitor = nil; globalMonitor = nil
    }
    func clearQuery() { input.stringValue = ""; controlTextDidChange(Notification(name:NSControl.textDidChangeNotification)); panel.makeFirstResponder(input) }
    func controlTextDidBeginEditing(_ obj:Notification) {
        if let editor = input.currentEditor() as? NSTextView {
            editor.typingAttributes = [.font:SearchTypeface.font(14),.foregroundColor:color("foreground"),.kern:-0.14]
        }
    }
    func controlTextDidChange(_ obj:Notification) {
        searchWork?.cancel(); let query = String(input.stringValue.prefix(500)).trimmingCharacters(in:.whitespacesAndNewlines)
        queryToken = UUID().uuidString; requestedMarks = []; clear.setShown(!input.stringValue.isEmpty)
        status.stringValue = ""; updateAppearance()
        if query.isEmpty { replaceCards([]); updatePointer(); return }
        // Retain the last settled cards until the new query has answered. There
        // is no invented Searching label or flickering empty card frame.
        let token = queryToken
        let work = DispatchWorkItem { [weak self] in self?.send("search",["query":query,"token":token]) }
        searchWork = work; DispatchQueue.main.asyncAfter(deadline:.now()+SearchDesign.interaction("debounce"),execute:work)
    }
    func control(_ control:NSControl,textView:NSTextView,doCommandBy commandSelector:Selector) -> Bool {
        switch NSStringFromSelector(commandSelector) {
        case "cancelOperation:": close(restoreFocus:true); return true
        case "moveUp:": step(-1); return true
        case "moveDown:": step(1); return true
        case "insertNewline:": return true
        default:return false
        }
    }
    func step(_ delta:Int) { flow.go(selected+delta) }
    func requestMarks() {
        guard open, !cards.isEmpty else { return }
        let visible = [selected,selected+1,selected-1,selected+2,selected-2].filter { cards.count >= 3 || (0..<cards.count).contains($0) }
            .map { cards[(($0 % cards.count)+cards.count)%cards.count] }
        var ids:[String] = []
        for card in visible where card.webMark == true && card.mark == nil && !requestedMarks.contains(card.id) && !ids.contains(card.id) { ids.append(card.id) }
        guard !ids.isEmpty else { return }
        requestedMarks.formUnion(ids); send("marks",["ids":ids,"token":queryToken])
    }
    private func replaceCards(_ items:[SearchCard]) {
        if cards.map(\.id) == items.map(\.id) { cards = items; flow.refreshCards(); return }
        let old = flow
        retirement?.cancel(); retiringFlow?.removeFromSuperview()
        let hadResults = !cards.isEmpty
        cards = items; selected = 0
        flow = SearchFlow(frame:.zero); flow.owner = self; placeFlow(flow)
        canvas.addSubview(flow,positioned:.below,relativeTo:fieldSurface)
        clear.nextKeyView = flow; flow.nextKeyView = input
        flow.replace()
        if !items.isEmpty { flow.animateVisibility(showing:true,initial:true) }
        if hadResults && !SearchDesign.reduced {
            old.retiring = true; old.cancelHoverTracking(); retiringFlow = old
            old.animateRetirement()
            let work = DispatchWorkItem { [weak self,weak old] in
                guard let self, self.retiringFlow === old else { return }
                old?.removeFromSuperview(); self.retiringFlow = nil
            }
            retirement = work; DispatchQueue.main.asyncAfter(deadline:.now()+SearchDesign.duration("exit"),execute:work)
        } else { old.removeFromSuperview() }
    }
    func openLibrary() { send("open",["query":input.stringValue.trimmingCharacters(in:.whitespacesAndNewlines)]); close(immediate:true) }
    func copyCurrent() {
        guard !copyPending, !cards.isEmpty else { return }
        copyWork?.cancel(); copiedId = ""; status.stringValue = ""
        let id = cards[cardIndex].id; pendingCopies.insert(id)
        flow.refreshCards(); send("copy",["id":id])
    }
    func response(_ data:Data) {
        guard let json = try? JSONSerialization.jsonObject(with:data) as? [String:Any], json["session"] as? String == session, open else { return }
        switch json["action"] as? String {
        case "search":
            guard json["token"] as? String == queryToken else { return }
            let items = (try? JSONDecoder().decode([SearchCard].self,from:JSONSerialization.data(withJSONObject:json["items"] ?? []))) ?? []
            replaceCards(items)
            status.stringValue = json["error"] != nil ? text("Search failed. Try again.","搜索失败，请重试。") : cards.isEmpty ? text("No matching references","没有匹配的收藏") : ""
            updatePointer(); requestMarks(); NSAccessibility.post(element:status,notification:.valueChanged)
        case "mark":
            guard json["token"] as? String == queryToken, let id = json["id"] as? String,
                  let mark = json["mark"] as? String, mark.count <= 32768,
                  let index = cards.firstIndex(where:{ $0.id == id && $0.webMark == true }), decodeSearchImage(mark) != nil else { return }
            cards[index].mark = mark; flow.refreshCards()
        case "marksRetry":
            guard json["token"] as? String == queryToken, let ids = json["ids"] as? [String] else { return }
            requestedMarks.subtract(ids)
        case "copy":
            let scope = session, id = json["id"] as? String ?? "", ok = json["error"] == nil
            // Arc commits the new label while its loading slot is still visible.
            // The 1800ms acknowledgement clock starts at clipboard completion.
            copyWork?.cancel(); copiedId = ok ? id : ""; flow.refreshCards()
            DispatchQueue.main.asyncAfter(deadline:.now()+SearchDesign.duration("fast")) { [weak self] in
                guard let self, self.open, self.session == scope else { return }
                self.pendingCopies.remove(id); self.flow.refreshCards()
                if !ok { self.status.stringValue = self.text("Could not copy. Try again.","复制失败，请重试。") }
            }
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.session == scope, self.copiedId == id else { return }
                self.copiedId = ""; self.flow.refreshCards()
            }
            copyWork = work; DispatchQueue.main.asyncAfter(deadline:.now()+SearchDesign.interaction("copied"),execute:work)
        case "prepareDrag":
            if json["error"] != nil { status.stringValue = text("Could not drag. Try again.","拖出失败，请重试。") }
        default:break
        }
    }
    func offerDrag(_ data:Data) -> Bool {
        guard let json = try? JSONSerialization.jsonObject(with:data) as? [String:Any], open, json["session"] as? String == session, let token = json["token"] as? String else { return false }
        return flow.prepared(token,paths:json["paths"] as? [String] ?? [],text:json["text"] as? String)
    }
    func windowDidResignKey(_ notification:Notification) { if open && !takingFocus && !dragging { close() } }
    @objc private func screenChanged() { if attached { close(immediate:true); send("place") } }
    @objc private func willSleep() { close(immediate:true) }
    @objc private func accessibilityChanged() {
        guard open else { return }
        if SearchDesign.reduced {
            clear.setShown(!input.stringValue.isEmpty,immediate:true)
            fieldSurface.layer?.removeAllAnimations()
            withoutActions {
                fieldSurface.layer?.transform = CATransform3DIdentity
                fieldSurface.layer?.opacity = 1
                fieldSurface.layer?.setValue(0,forKeyPath:"filters.searchBlur.inputRadius")
            }
            retirement?.cancel(); retiringFlow?.removeFromSuperview(); retiringFlow = nil
        }
        flow.motionPreferenceChanged()
    }
}

@MainActor private var searchOwner: SearchOwner?
@_cdecl("stashdock_search_install") @MainActor
public func searchInstall(_ callback:@escaping @convention(c) (UnsafePointer<CChar>) -> Void) {
    SearchTypeface.register(Bundle.main.url(forResource:"inter-latin-wght-normal",withExtension:"woff2",subdirectory:"Fonts"))
    searchOwner = SearchOwner(callback:callback)
}
@_cdecl("stashdock_search_attach") @MainActor
public func searchAttach(_ raw:UnsafePointer<CChar>) {
    guard let data = String(cString:raw).data(using:.utf8), let config = try? JSONSerialization.jsonObject(with:data) as? [String:Any] else { return }
    searchOwner?.configure(config); searchOwner?.attached = true
}
@_cdecl("stashdock_search_hover") @MainActor
public func searchHover(_ inside:Bool) { searchOwner?.hover(inside) }
@_cdecl("stashdock_search_focus") @MainActor
public func searchFocus() { searchOwner?.focusSearch() }
@_cdecl("stashdock_search_folder_gesture") @MainActor
public func searchFolderGesture(_ active:Bool) { searchOwner?.folderGesture(active) }
@_cdecl("stashdock_search_detach") @MainActor
public func searchDetach(_ hide:Bool) { searchOwner?.detach(hide:hide) }
@_cdecl("stashdock_search_response") @MainActor
public func searchResponse(_ raw:UnsafePointer<CChar>) { if let data = String(cString:raw).data(using:.utf8) { searchOwner?.response(data) } }
@_cdecl("stashdock_search_offer_drag") @MainActor
public func searchOfferDrag(_ raw:UnsafePointer<CChar>) -> Bool { guard let data = String(cString:raw).data(using:.utf8) else { return false }; return searchOwner?.offerDrag(data) ?? false }
