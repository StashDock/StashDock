// AppKit rendering of FolderSearch / FolderSearchCard, not a new visual design.
// Core Animation owns every animation; no display-link, timer loop or WebView.
import AppKit
import QuartzCore
import CoreImage
import CoreText

@MainActor enum SearchTypeface {
    static func register(_ url: URL?) {
        if let url { CTFontManagerRegisterFontsForURL(url as CFURL,.process,nil) }
    }
    static func font(_ size:Double, medium:Bool = false) -> NSFont {
        NSFont(name:medium ? "Inter-Regular_Medium" : "Inter-Regular",size:size) ?? .systemFont(ofSize:size,weight:medium ? .medium : .regular)
    }
}

struct SearchCard: Decodable, Equatable {
    let id: String
    let title: String
    let preview: String?
    let icon: String?
    var mark: String?
    let site: String?
    let webMark: Bool?
    let visual: String?
    let label: String?
}

@MainActor enum SearchDesign {
    static let data = try! JSONSerialization.jsonObject(with: Data(searchTokenJSON.utf8)) as! [String: Any]
    static func theme(_ dark: Bool) -> [String: Any] { (data["themes"] as! [String: [String: Any]])[dark ? "dark" : "light"]! }
    static func color(_ values: Any?) -> NSColor {
        let rgb = values as? [Double] ?? [0,0,0]
        return NSColor(srgbRed: rgb[0], green: rgb[1], blue: rgb[2], alpha: 1)
    }
    static func duration(_ key: String) -> Double { ((data["motion"] as! [String: Any])["duration"] as! [String: Double])[key]! }
    static func control(_ key:String) -> Double { (data["controls"] as! [String:Double])[key]! }
    static func blur(_ key:String) -> Double { ((data["motion"] as! [String:Any])["blur"] as! [String:Double])[key]! }
    static func interaction(_ key: String) -> Double { (data["interaction"] as! [String: Double])[key]! }
    static func ease(_ key: String) -> CAMediaTimingFunction {
        let a = ((data["motion"] as! [String: Any])["ease"] as! [String: [Double]])[key]!
        return CAMediaTimingFunction(controlPoints: Float(a[0]), Float(a[1]), Float(a[2]), Float(a[3]))
    }
    static func spring(_ key: String) -> (Double, Double) {
        let p = ((data["motion"] as! [String: Any])["spring"] as! [String: [String: Any]])[key]!
        if let stiffness = p["stiffness"] as? Double { return (stiffness, p["damping"] as! Double) }
        // Motion 14 getSpringOptions: visualDuration uses a 1.2 period factor.
        let w = 2 * Double.pi / ((p["visualDuration"] as! Double) * 1.2)
        return (w * w, 2 * (1 - (p["bounce"] as! Double)) * w)
    }
    static func springIsTimeDefined(_ key:String) -> Bool {
        (((data["motion"] as! [String:Any])["spring"] as! [String:[String:Any]])[key]?["visualDuration"]) != nil
    }
    static var reduced: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
}

// The same continuous distance -> 3D placement as FolderSearch.tsx::place.
struct SearchPlacement {
    let x: Double, z: Double, angle: Double, scale: Double, opacity: Float, order: Double
    init(_ d: Double) {
        let a = abs(d), near = min(a, 1), sign = d < 0 ? -1.0 : 1.0
        x = sign * (a <= 1 ? a * 232 * 0.47 : 232 * 0.47 + (a - 1) * 232 * 0.2)
        z = -near * 150 - max(0, a - 1) * 80
        angle = -min(1, max(-1, d)) * 48 * .pi / 180
        scale = 1 - near * 0.06
        opacity = Float(a <= 1 ? 1 - a * 0.25 : max(0, 0.75 - (a - 1) * 1.1))
        // Windows' z-index is discrete, including its stable ties. Keep the
        // native depth offset tiny so it doesn't change the 1100pt projection.
        order = -round(a * 10) * 0.001
    }
    var transform: CATransform3D {
        var t = CATransform3DMakeTranslation(x, 0, z)
        t = CATransform3DRotate(t, angle, 0, 1, 0)
        return CATransform3DScale(t, scale, scale, 1)
    }
    /// Invert the projected card plane, not a CALayer model already set to the
    /// animation's destination. Coordinates are relative to the flow centre.
    func localPoint(_ point: NSPoint) -> NSPoint? {
        let t = transform, perspective = 1100.0
        let denominator = t.m11 + point.x * t.m13 / perspective
        guard abs(denominator) > 0.000001 else { return nil }
        let x = (point.x * (1 - t.m43 / perspective) - t.m41) / denominator
        let w = 1 - (t.m13 * x + t.m43) / perspective
        return NSPoint(x:x + 116,y:point.y * w / t.m22 + 84)
    }
}

// Analytic spring sampled once per user action, submitted as compositor-owned
// keyframes. Interrupted wheel/key actions inherit current position AND velocity.
struct SearchSpring {
    let from: Double, to: Double, velocity: Double, stiffness: Double, damping: Double
    let start: Double
    func state(_ elapsed: Double) -> (value: Double, velocity: Double) {
        let t = max(0, elapsed), w = sqrt(stiffness), decay = damping / 2
        let displacement = from - to
        if abs(decay - w) < 0.00001 {
            let b = velocity + w * displacement, e = exp(-w * t)
            return (to + (displacement + b * t) * e, (b - w * (displacement + b * t)) * e)
        }
        let wd = sqrt(max(0.000001, stiffness - decay * decay))
        let b = (velocity + decay * displacement) / wd
        let c = cos(wd * t), s = sin(wd * t), e = exp(-decay * t)
        return (to + e * (displacement * c + b * s), e * ((b * wd - decay * displacement) * c - (displacement * wd + decay * b) * s))
    }
    var duration: Double {
        let granular = abs(to - from) < 5
        for i in 1...240 {
            let t = Double(i) / 120, s = state(t)
            if abs(s.value - to) < (granular ? 0.005 : 0.5) && abs(s.velocity) < (granular ? 0.01 : 2) { return t }
        }
        return 2
    }
}

@MainActor func withoutActions(_ work: () -> Void) {
    CATransaction.begin(); CATransaction.setDisableActions(true); work(); CATransaction.commit()
}
@MainActor func tween(_ layer: CALayer, _ key: String, to: Any, duration: Double, ease: String = "standard", delay: Double = 0, from explicit: Any? = nil) {
    let from = explicit ?? layer.presentation()?.value(forKeyPath: key) ?? layer.value(forKeyPath: key)
    withoutActions { layer.setValue(to, forKeyPath: key) }
    guard !SearchDesign.reduced else { layer.removeAnimation(forKey: key); return }
    let a = CABasicAnimation(keyPath: key); a.fromValue = from; a.toValue = to
    a.duration = duration; a.beginTime = CACurrentMediaTime() + delay
    a.fillMode = .backwards; a.timingFunction = SearchDesign.ease(ease)
    layer.add(a, forKey: key)
}
@MainActor func blurLayer(_ layer: CALayer) {
    let filter = CIFilter(name: "CIGaussianBlur")!
    filter.name = "searchBlur"; filter.setValue(0, forKey: kCIInputRadiusKey)
    withoutActions { layer.filters = [filter] }
}
@MainActor func visibility(_ layer: CALayer, showing: Bool, field: Bool, initial: Bool = false) {
    let y = field ? 18.0 : showing ? 14.0 : 22.0
    let sx = field ? 0.78 : showing ? 0.96 : 0.94
    let sy = field ? 0.6 : sx
    // The field contains AppKit text/control views, so its backing anchor must
    // remain AppKit's (0,0). Encode the CSS fold origin in the 2D transform.
    let pivot = field ? NSPoint(x:layer.bounds.midX,y:layer.bounds.height) : .zero
    let folded = CATransform3DScale(CATransform3DMakeTranslation(pivot.x*(1-sx), y+pivot.y*(1-sy), 0), sx, sy, 1)
    let target = showing ? CATransform3DIdentity : folded
    let from = initial ? folded : layer.presentation()?.transform ?? layer.transform
    let duration = SearchDesign.duration(field ? "standard" : "exit")
    let delay = !showing && field ? SearchDesign.interaction("closeStagger") : 0
    if showing && !SearchDesign.reduced {
        let physics = SearchDesign.spring("smooth")
        let springs = [(from.m11,1.0),(from.m22,1.0),(from.m41,0.0),(from.m42-pivot.y*(1-from.m22),0.0)].map {
            SearchSpring(from:$0.0,to:$0.1,velocity:0,stiffness:physics.0,damping:physics.1,start:0)
        }
        let times = springs.map(\.duration), total = times.max()!
        let count = Int(ceil(total * 120))
        let a = CAKeyframeAnimation(keyPath:"transform")
        // Independent components preserve the exact folding origin, including
        // reversal from the presentation transform rather than a remounted view.
        a.values = (0...count).map { i in
            let time = Double(i)/Double(count)*total
            let values = springs.enumerated().map { j,s in time >= times[j] ? s.to : s.state(time).value }
            var t = CATransform3DIdentity
            t.m11 = values[0]; t.m22 = values[1]
            t.m41 = field ? pivot.x*(1-values[0]) : values[2]
            t.m42 = values[3]+pivot.y*(1-values[1])
            return NSValue(caTransform3D:t)
        }
        a.duration = total; a.calculationMode = .linear
        withoutActions { layer.transform = target }
        layer.add(a, forKey:"transform")
    } else {
        tween(layer,"transform",to:NSValue(caTransform3D:target),duration:duration,ease:field ? "inOut" : "standard",delay:delay,from:NSValue(caTransform3D:from))
    }
    tween(layer,"opacity",to:showing ? 1.0 : 0.0,duration:SearchDesign.duration(field ? "fast" : showing ? "standard" : "exit"),ease:showing ? "enter" : "standard",delay:delay + (!showing && field ? SearchDesign.interaction("closeOpacityDelay") : 0),from:initial ? 0 : nil)
    tween(layer,"filters.searchBlur.inputRadius",to:showing ? 0.0 : 2.0,duration:showing ? SearchDesign.duration("standard") : duration,delay:delay,from:initial ? 4.0 : nil)
}

@MainActor func decodeSearchImage(_ raw: String?) -> NSImage? {
    guard let raw, let comma = raw.firstIndex(of:","), raw.hasPrefix("data:image/"),
          let data = Data(base64Encoded:String(raw[raw.index(after:comma)...])), data.count <= 400_000 else { return nil }
    return NSImage(data:data)
}
@MainActor func searchBitmap(_ size: NSSize, scale: Double, drawing: () -> Void) -> CGImage {
    let rep = NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:Int(ceil(size.width*scale)),pixelsHigh:Int(ceil(size.height*scale)),bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
    let cg = NSGraphicsContext(bitmapImageRep:rep)!.cgContext
    // index.css uses grayscale antialiasing. Quartz's extra font smoothing
    // otherwise makes the very same Inter 500 outlines look heavier.
    cg.setShouldAntialias(true); cg.setShouldSmoothFonts(false)
    cg.setShouldSubpixelPositionFonts(true); cg.setShouldSubpixelQuantizeFonts(false)
    cg.scaleBy(x:scale,y:scale); cg.translateBy(x:0,y:size.height); cg.scaleBy(x:1,y:-1)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(cgContext:cg,flipped:true)
    drawing()
    NSGraphicsContext.restoreGraphicsState()
    return rep.cgImage!
}
@MainActor func drawSearchText(_ text: String, rect: NSRect, size: Double, medium: Bool, color: NSColor, truncate: Bool = true, tracking:Double? = nil) {
    let font = SearchTypeface.font(size,medium:medium)
    let p = NSMutableParagraphStyle(); p.lineBreakMode = truncate ? .byTruncatingTail : .byClipping
    let height = ceil(font.ascender - font.descender)
    let y = rect.midY - height / 2
    (text as NSString).draw(in:NSRect(x:rect.minX,y:y,width:rect.width,height:height+2),withAttributes:[.font:font,.foregroundColor:color,.kern:tracking ?? -size*0.01,.paragraphStyle:p])
}
@MainActor func imageIn(_ image: NSImage?, _ rect: NSRect) {
    image?.draw(in:rect,from:.zero,operation:.sourceOver,fraction:1,respectFlipped:true,hints:[.interpolation:NSImageInterpolation.high])
}

@MainActor func configureSearchRim(_ rim:CAShapeLayer,rect:NSRect,radius:Double,dark:Bool) {
    let tokens = SearchDesign.theme(dark)["elevation"] as! [[String:Any]]
    guard let token = tokens.first(where:{ ($0["spread"] as! Double) > 0 }) else { rim.isHidden = true; return }
    let spread = token["spread"] as! Double
    rim.isHidden = false; rim.frame = rect; rim.fillColor = nil
    rim.path = CGPath(roundedRect:rect.insetBy(dx:-spread/2,dy:-spread/2),cornerWidth:radius+spread/2,cornerHeight:radius+spread/2,transform:nil)
    rim.strokeColor = SearchDesign.color(token["color"]).withAlphaComponent(token["opacity"] as! Double).cgColor
    rim.lineWidth = spread
}
@MainActor func configureSearchShadow(_ key: CALayer, _ ambient: CALayer, rect: NSRect, radius: Double, dark: Bool) {
    // CSS box-shadow blur is twice the Gaussian standard deviation.
    let shadows = SearchDesign.theme(dark)["elevation"] as! [[String:Any]]
    for (layer,token) in zip([key,ambient],shadows) {
        let l = layer
        l.shadowColor = SearchDesign.color(token["color"]).cgColor
        l.shadowOpacity = Float(token["opacity"] as! Double); l.shadowRadius = (token["blur"] as! Double) / 2
        l.shadowOffset = NSSize(width:0,height:token["dy"] as! Double)
        l.shadowPath = CGPath(roundedRect:rect,cornerWidth:radius,cornerHeight:radius,transform:nil)
    }
}

@MainActor final class SearchCardLayer {
    let root = CALayer(), lift = CALayer(), surface = CALayer(), ambient = CALayer(), artwork = CALayer(), caption = CALayer(), rim = CAShapeLayer()
    let copyPresentation = SearchCopyPresentation()
    var copy:CALayer { copyPresentation.root }
    private(set) var card: SearchCard
    let virtual: Int
    weak var owner: SearchOwner?
    var hovered = false
    private var buttonHovered = false
    var copyRect:NSRect { copyBounds(at:CACurrentMediaTime()) }
    func copyBounds(at time:Double) -> NSRect {
        let width = copyPresentation.width(at:time)
        return NSRect(x:223-width,y:123,width:width,height:36)
    }
    private var image: CGImage?, captionImage:CGImage?
    private var baseKey = "", captionKey = ""
    private var previewImage: NSImage?, iconImage: NSImage?, markImage: NSImage?
    init(card: SearchCard, virtual: Int, owner: SearchOwner) {
        self.card = card; self.virtual = virtual; self.owner = owner
        previewImage = decodeSearchImage(card.preview); iconImage = decodeSearchImage(card.icon)
        markImage = decodeSearchImage(card.mark ?? (card.webMark == true ? nil : card.icon))
        root.bounds = NSRect(x:0,y:0,width:232,height:168); root.position = NSPoint(x:116,y:84)
        lift.frame = root.bounds; root.addSublayer(lift)
        for child in [ambient,surface,artwork,caption,rim,copy] { lift.addSublayer(child) }
        ambient.frame = root.bounds; surface.frame = root.bounds; artwork.frame = root.bounds; caption.frame = root.bounds
        surface.cornerRadius = 26; ambient.cornerRadius = 26
        refresh()
    }
    func update(_ item:SearchCard) {
        if item != card {
            card = item; baseKey = ""; captionKey = ""; image = nil
            previewImage = decodeSearchImage(item.preview); iconImage = decodeSearchImage(item.icon)
            markImage = decodeSearchImage(item.mark ?? (item.webMark == true ? nil : item.icon))
        }
        refresh()
    }
    func refresh() {
        guard let owner else { return }
        let scale = owner.panel.backingScaleFactor
        let palette = SearchDesign.theme(owner.dark)
        let kind = card.visual ?? "file"
        let cover = (palette["covers"] as! [String:[String:Any]])[kind] ?? [:]
        let label = owner.localized(card.label ?? "File")
        let copied = owner.copiedId == card.id
        let pending = owner.pendingCopies.contains(card.id)
        let buttonLabel = owner.text(copied ? "Copied" : "Copy",copied ? "已复制" : "复制")
        let width = SearchCopyPresentation.naturalWidth(buttonLabel)
        let key = "\(owner.dark)-\(owner.chinese)-\(scale)"
        if image == nil || baseKey != key {
        baseKey = key
        image = searchBitmap(NSSize(width:232,height:168),scale:scale) {
            // CSS border-box 232x168, padding 8 + border 1 => 214x106 cover.
            let outer = NSBezierPath(roundedRect:NSRect(x:0.5,y:0.5,width:231,height:167),xRadius:25.5,yRadius:25.5)
            owner.color("surface").setFill(); outer.fill()
            owner.color("border").setStroke(); outer.lineWidth = 1; outer.stroke()
            NSGraphicsContext.saveGraphicsState()
            let rect = NSRect(x:9,y:9,width:214,height:106)
            NSBezierPath(roundedRect:rect,xRadius:18,yRadius:18).addClip()
            owner.color("surface-muted").setFill(); rect.fill()
            if let preview = previewImage {
                // object-fit:cover; object-position:top, exactly as PreviewArtwork.
                let ratio = max(rect.width/preview.size.width,rect.height/preview.size.height)
                let size = NSSize(width:preview.size.width*ratio,height:preview.size.height*ratio)
                imageIn(preview,NSRect(x:rect.midX-size.width/2,y:rect.minY,width:size.width,height:size.height))
            } else {
                SearchDesign.color(cover["fill"]).setFill(); rect.fill()
                let side = max(64,min(96,rect.width*0.34))
                imageIn(iconImage,NSRect(x:rect.midX-side/2,y:rect.midY-side/2-side*0.08,width:side,height:side))
                drawSearchText(label,rect:NSRect(x:25,y:rect.maxY-12-18,width:182,height:18),size:12,medium:true,color:SearchDesign.color(cover["caption"]))
            }
            NSGraphicsContext.restoreGraphicsState()
        }
        }
        let rowKey = "\(key)-\(width)"
        if captionKey != rowKey {
            captionKey = rowKey
            captionImage = searchBitmap(NSSize(width:232,height:168),scale:scale) {
            if let mark = markImage { imageIn(mark,NSRect(x:17,y:133,width:16,height:16)) }
            else if card.webMark == true { drawSearchText(String((card.site ?? "").prefix(1)).uppercased(),rect:NSRect(x:17,y:133,width:16,height:16),size:12,medium:true,color:owner.color("text-secondary")) }
            drawSearchText(card.title,rect:NSRect(x:41,y:123,width:max(0,223-width-8-41),height:36),size:14,medium:true,color:owner.color("foreground"))
        }
        }
        withoutActions {
            artwork.contents = image; artwork.contentsScale = scale
            caption.contents = captionImage; caption.contentsScale = scale
            surface.backgroundColor = owner.color("surface").cgColor
            ambient.backgroundColor = owner.color("surface").cgColor
            configureSearchShadow(surface,ambient,rect:root.bounds,radius:26,dark:owner.dark)
            configureSearchRim(rim,rect:root.bounds,radius:26,dark:owner.dark)
        }
        copyPresentation.update(owner:owner,label:buttonLabel,copied:copied,pending:pending,
            visible:virtual == owner.selected && (hovered || copied || pending || owner.flowFocused),buttonHovered:buttonHovered)
    }
    func hover(_ over: Bool, copyOver:Bool = false) {
        guard hovered != over || buttonHovered != copyOver, let owner else { return }
        hovered = over; buttonHovered = copyOver
        tween(lift,"transform.translation.y",to:over && !SearchDesign.reduced ? -3.0 : 0.0,duration:SearchDesign.duration("fast"))
        let visible = virtual == owner.selected && (over || owner.copiedId == card.id || owner.copyPending || owner.flowFocused)
        copyPresentation.show(visible,buttonHovered:buttonHovered)
    }
    func dragImage() -> NSImage? {
        guard let image else { return nil }
        let size = NSSize(width:232,height:168)
        let composed = searchBitmap(size,scale:Double(owner?.panel.backingScaleFactor ?? 2)) {
            let rect = NSRect(origin:.zero,size:size)
            imageIn(NSImage(cgImage:image,size:size),rect)
            if let row = captionImage { imageIn(NSImage(cgImage:row,size:size),rect) }
        }
        return NSImage(cgImage:composed,size:size)
    }
}

// Accessibility reads immutable semantic snapshots. It never synchronously
// waits on AppKit from an AX thread; actions are dispatched to the UI owner.
final class SearchAction: NSAccessibilityElement, @unchecked Sendable {
    private weak var flow: SearchFlow?
    private let copy: Bool
    private let label: String
    private let screenFrame: NSRect
    private let referenceId: String
    private let scope: String
    @MainActor init(flow: SearchFlow, copy: Bool) {
        self.flow = flow; self.copy = copy
        let owner = flow.owner!
        let current = flow.slots[owner.selected]!
        let title = owner.cards[owner.cardIndex].title
        referenceId = owner.cards[owner.cardIndex].id; scope = owner.session
        label = copy ? owner.text("Copy for AI", "复制给 AI") + ": " + title : title
        let rect = copy ? current.copyRect : current.root.bounds
        let box = current.root.convert(rect,to:flow.layer)
        screenFrame = flow.window?.convertToScreen(flow.convert(box,to:nil)) ?? .zero
        super.init(); setAccessibilityParent(flow)
    }
    override func accessibilityRole() -> NSAccessibility.Role? { .button }
    override func isAccessibilityEnabled() -> Bool { true }
    override func accessibilityLabel() -> String? { label }
    override func accessibilityFrame() -> NSRect { screenFrame }
    override func accessibilityPerformPress() -> Bool {
        let target = flow, isCopy = copy, id = referenceId, session = scope
        DispatchQueue.main.async {
            guard let owner = target?.owner, owner.open, owner.session == session,
                  !owner.cards.isEmpty, owner.cards[owner.cardIndex].id == id else { return }
            if isCopy { owner.copyCurrent() } else { owner.openLibrary() }
        }
        return true
    }
}

private struct SearchHoverTarget: Equatable {
    var virtual: Int? = nil
    var copy = false
}

@MainActor final class SearchFlow: NSView, NSDraggingSource {
    weak var owner: SearchOwner?
    // AppKit owns the backing layer's zero anchor. Only this app-owned carrier
    // may scale/fold the scene around the field-facing centre edge.
    let motionRoot = CALayer()
    let content = CALayer(), maskGradient = CAGradientLayer(), stage = CALayer()
    var slots: [Int:SearchCardLayer] = [:]
    var retiring = false
    private var movement: SearchSpring?
    private var finish: DispatchWorkItem?
    private var motionGeneration: UInt64 = 0
    private var blurFinish: DispatchWorkItem?
    private var hoverBoundary: DispatchWorkItem?
    private var hoverGeneration = 0
    private var lastPointer: NSPoint?
    private var wheelDelta = 0.0
    private var press: NSEvent?
    private var pressedVirtual: Int?
    private var pressedCopy = false
    private var dragWanted = false, dragStarted = false
    private var dragWriters: [NSPasteboardWriting] = []
    private var exportToken = "", exportSession = ""
    private var dragCard: SearchCardLayer?
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { owner?.cards.isEmpty == false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func hitTest(_ point:NSPoint) -> NSView? { retiring ? nil : super.hitTest(point) }
    override init(frame:NSRect) {
        super.init(frame:frame); wantsLayer = true; clipsToBounds = false
        // App-owned sublayers, never 3D-transform an NSView backing layer.
        layer!.addSublayer(motionRoot)
        content.bounds = NSRect(x:0,y:0,width:460,height:320); content.position = NSPoint(x:230,y:88)
        motionRoot.addSublayer(content)
        maskGradient.frame = content.bounds
        maskGradient.startPoint = NSPoint(x:0,y:0.5); maskGradient.endPoint = NSPoint(x:1,y:0.5)
        maskGradient.colors = [NSColor.clear.cgColor,NSColor.black.cgColor,NSColor.black.cgColor,NSColor.clear.cgColor]
        maskGradient.locations = [0,0.14,0.86,1]; content.mask = maskGradient
        stage.bounds = NSRect(x:0,y:0,width:232,height:168); stage.position = NSPoint(x:230,y:160)
        var perspective = CATransform3DIdentity; perspective.m34 = -1/1100
        stage.sublayerTransform = perspective; content.addSublayer(stage)
        setAccessibilityElement(false)
    }
    required init?(coder:NSCoder) { fatalError("No archives") }
    func place() {
        withoutActions {
            motionRoot.bounds = NSRect(x:0,y:0,width:460,height:176)
            motionRoot.anchorPoint = NSPoint(x:0.5,y:1)
            motionRoot.position = NSPoint(x:230,y:176)
        }
    }
    private func clearBlur() {
        blurFinish?.cancel(); blurFinish = nil
        motionRoot.removeAnimation(forKey:"filters.searchBlur.inputRadius")
        withoutActions { motionRoot.filters = nil }
    }
    func animateVisibility(showing:Bool,initial:Bool = false) {
        blurFinish?.cancel()
        if motionRoot.filters == nil { blurLayer(motionRoot) }
        visibility(motionRoot,showing:showing,field:false,initial:initial)
        if showing {
            // Blur belongs to appearance, never the steady/scrolling carousel.
            // Detach the CI filter at zero instead of resampling every turn.
            let work = DispatchWorkItem { [weak self] in self?.clearBlur() }
            blurFinish = work
            DispatchQueue.main.asyncAfter(deadline:.now()+SearchDesign.duration("standard"),execute:work)
        }
    }
    func animateRetirement() {
        blurFinish?.cancel()
        if motionRoot.filters == nil { blurLayer(motionRoot) }
        let folded = CATransform3DScale(CATransform3DMakeTranslation(0,7,0),0.98,0.98,1)
        tween(motionRoot,"transform",to:NSValue(caTransform3D:folded),duration:SearchDesign.duration("exit"))
        tween(motionRoot,"opacity",to:0.0,duration:SearchDesign.duration("exit"))
        tween(motionRoot,"filters.searchBlur.inputRadius",to:2.0,duration:SearchDesign.duration("exit"))
    }
    override func becomeFirstResponder() -> Bool { owner?.flowFocused = true; refreshCards(); return true }
    override func resignFirstResponder() -> Bool { owner?.flowFocused = false; refreshCards(); return true }
    override func keyDown(with event:NSEvent) {
        switch event.keyCode {
        case 125: owner?.step(1)
        case 126: owner?.step(-1)
        case 53: owner?.close(restoreFocus:true)
        case 49: owner?.copyCurrent()
        case 48: if event.modifierFlags.contains(.shift) { window?.selectPreviousKeyView(self) } else { window?.selectNextKeyView(self) }
        default: super.keyDown(with:event)
        }
    }
    func reset() {
        motionGeneration &+= 1
        finish?.cancel(); cancelHoverTracking(); movement = nil; wheelDelta = 0; lastPointer = nil
        clearBlur()
        slots.values.forEach { $0.root.removeFromSuperlayer() }; slots = [:]
        setAccessibilityChildren([])
    }
    func refreshCards() {
        guard let owner, !owner.cards.isEmpty else { return }
        for slot in slots.values {
            let index = ((slot.virtual % owner.cards.count)+owner.cards.count)%owner.cards.count
            slot.update(owner.cards[index])
        }
        pointerMoved(); updateAccessibility()
    }
    func replace() {
        reset()
        guard let owner, !owner.cards.isEmpty else { return }
        ensureSlots(from:0,to:0)
        applyPosition(0)
        updateAccessibility()
    }
    private func ensureSlots(from:Double,to:Double) {
        guard let owner, !owner.cards.isEmpty else { return }
        let range = (Int(floor(min(from,to)))-2)...(Int(ceil(max(from,to)))+2)
        // Recycle fully invisible slots even during an uninterrupted scroll.
        for key in Array(slots.keys) where !range.contains(key) { slots.removeValue(forKey:key)?.root.removeFromSuperlayer() }
        for virtual in range where slots[virtual] == nil {
            if owner.cards.count < 3 && !(0..<owner.cards.count).contains(virtual) { continue }
            let item = owner.cards[((virtual % owner.cards.count)+owner.cards.count)%owner.cards.count]
            let card = SearchCardLayer(card:item,virtual:virtual,owner:owner)
            // Never publish a default identity/opaque card at the centre.
            // AX/layout work may commit the tree before animations are ready.
            let initial = SearchPlacement(Double(virtual)-from)
            withoutActions {
                card.root.transform = initial.transform; card.root.opacity = initial.opacity
                card.root.zPosition = initial.order
                slots[virtual] = card; stage.addSublayer(card.root)
            }
        }
        // Equal Windows z-index values paint in virtual/DOM order, including
        // after adding a negative slot on reversal (not native insertion order).
        withoutActions { stage.sublayers = slots.keys.sorted().compactMap { slots[$0]?.root } }
    }
    var position: Double {
        guard let movement else { return Double(owner?.selected ?? 0) }
        return movement.state(CACurrentMediaTime()-movement.start).value
    }
    private func applyPosition(_ position:Double) {
        withoutActions {
            for (virtual,card) in slots {
                let p = SearchPlacement(Double(virtual)-position)
                card.root.transform = p.transform; card.root.opacity = p.opacity
                card.root.zPosition = p.order
            }
        }
    }
    func go(_ next:Int) {
        guard let owner, !owner.cards.isEmpty, !owner.dragging else { return }
        var target = owner.cards.count >= 3 ? next : min(owner.cards.count-1,max(0,next))
        guard target != owner.selected else { return }
        clearBlur()
        let now = CACurrentMediaTime()
        let state = movement?.state(now-(movement?.start ?? now)) ?? (Double(owner.selected),0)
        if owner.cards.count >= 3 && abs(Double(target)-state.0) > 32 {
            // Redundant whole revolutions have identical content. Coalesce a
            // queued input burst rather than allocating an unbounded strip.
            target -= Int((Double(target)-state.0)/Double(owner.cards.count))*owner.cards.count
        }
        owner.selected = target
        finish?.cancel()
        motionGeneration &+= 1
        let generation = motionGeneration
        let physics = SearchDesign.spring("gentle")
        let spring = SearchSpring(from:state.0,to:Double(target),velocity:state.1,stiffness:physics.0,damping:physics.1,start:now)
        // Publish all additions, target models and their presentation override
        // in one transaction. No intermediate tree may show target/defaults.
        CATransaction.begin(); CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        ensureSlots(from:state.0,to:Double(target))
        movement = spring
        updateAccessibility(); owner.requestMarks()
        if SearchDesign.reduced { applyPosition(Double(target)); settle(); return }
        let duration = spring.duration, samples = Int(ceil(duration*120))
        let positions = (0...samples).map { $0 == samples ? Double(target) : spring.state(Double($0)/Double(samples)*duration).value }
        for (virtual,card) in slots {
            let placements = positions.map { SearchPlacement(Double(virtual)-$0) }
            withoutActions {
                let last = placements.last!
                card.root.transform = last.transform; card.root.opacity = last.opacity
                card.root.zPosition = last.order
            }
            let transform = CAKeyframeAnimation(keyPath:"transform"); transform.values = placements.map { NSValue(caTransform3D:$0.transform) }
            let opacity = CAKeyframeAnimation(keyPath:"opacity"); opacity.values = placements.map { NSNumber(value:$0.opacity) }
            let order = CAKeyframeAnimation(keyPath:"zPosition"); order.values = placements.map(\.order)
            for animation in [transform,opacity,order] { animation.duration = duration; animation.calculationMode = .linear }
            order.calculationMode = .discrete
            let group = CAAnimationGroup(); group.animations = [transform,opacity,order]; group.duration = duration
            group.beginTime = card.root.convertTime(now,from:nil); group.fillMode = .backwards
            card.root.add(group,forKey:"cover-flow")
            card.refresh()
        }
        pointerMoved()
        let work = DispatchWorkItem { [weak self] in self?.settle(generation:generation) }
        finish = work; DispatchQueue.main.asyncAfter(deadline:.now()+duration,execute:work)
        NSAccessibility.post(element:self,notification:.valueChanged)
    }
    private func updateAccessibility() {
        guard let owner, !owner.cards.isEmpty, slots[owner.selected] != nil else { return }
        setAccessibilityChildren([SearchAction(flow:self,copy:false),SearchAction(flow:self,copy:true)])
    }
    private func settle(generation:UInt64? = nil) {
        if let generation, generation != motionGeneration { return }
        guard let owner else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        cancelHoverTracking()
        movement = nil
        let keep = (owner.selected-2)...(owner.selected+2)
        for key in Array(slots.keys) where !keep.contains(key) { slots.removeValue(forKey:key)?.root.removeFromSuperlayer() }
        slots.values.forEach { $0.root.removeAnimation(forKey:"cover-flow") }
        applyPosition(Double(owner.selected)); pointerMoved(); updateAccessibility()
    }
    func motionPreferenceChanged() {
        if SearchDesign.reduced {
            finish?.cancel(); settle(); clearBlur(); motionRoot.removeAllAnimations()
            withoutActions {
                motionRoot.transform = CATransform3DIdentity; motionRoot.opacity = 1
                for slot in slots.values { slot.lift.removeAllAnimations(); slot.lift.transform = CATransform3DIdentity; slot.copyPresentation.reduceMotion() }
            }
        }
        refreshCards()
    }
    override func scrollWheel(with event:NSEvent) {
        guard owner?.cards.isEmpty == false else { return }
        // DOM wheel positive is down; AppKit's scrolling delta has the reverse sign.
        let x = event.scrollingDeltaX, y = event.scrollingDeltaY
        wheelDelta -= (abs(y) >= abs(x) ? y : x) * (event.hasPreciseScrollingDeltas ? 1 : 16)
        if abs(wheelDelta) >= 48 { owner?.step(wheelDelta > 0 ? 1 : -1); wheelDelta = 0 }
        trackPointer(convert(event.locationInWindow,from:nil))
    }
    func hit(_ point:NSPoint, at position:Double? = nil) -> (SearchCardLayer,NSPoint)? {
        let position = position ?? self.position
        for card in slots.values.sorted(by:{ abs(Double($0.virtual)-position) < abs(Double($1.virtual)-position) }) {
            let placement = SearchPlacement(Double(card.virtual)-position)
            guard placement.opacity > 0.02,
                  let local = placement.localPoint(NSPoint(x:point.x-230,y:point.y-88)) else { continue }
            if NSBezierPath(roundedRect:card.root.bounds,xRadius:26,yRadius:26).contains(local) { return (card,local) }
        }
        return nil
    }
    func cancelHoverTracking() {
        hoverBoundary?.cancel(); hoverBoundary = nil; hoverGeneration += 1
    }
    private func hoverTarget(_ point:NSPoint, at position:Double, time:Double) -> SearchHoverTarget {
        guard let (card,local) = hit(point,at:position), card.virtual == owner?.selected else { return SearchHoverTarget() }
        return SearchHoverTarget(virtual:card.virtual,copy:card.copyBounds(at:time).contains(local))
    }
    /// A stationary pointer still enters/leaves moving cards, just like CSS
    /// :hover. Plan only actual hit-boundary changes along the submitted spring.
    /// One cancellable wake-up per boundary, never a frame/idle polling loop.
    func trackPointer(_ point:NSPoint) {
        cancelHoverTracking()
        guard owner?.open == true, !retiring else { return }
        lastPointer = point
        let now = CACurrentMediaTime()
        let target = hoverTarget(point,at:position,time:now)
        for card in slots.values { card.hover(card.virtual == target.virtual,copyOver:card.virtual == target.virtual && target.copy) }
        guard !SearchDesign.reduced else { return }
        let end = max(movement.map { $0.start+$0.duration } ?? 0,slots[owner?.selected ?? 0]?.copyPresentation.animationEnd ?? 0)
        guard end > now else { return }
        let count = Int(ceil((end-now)*120))
        for sample in 1...count {
            let time = min(end,now+Double(sample)/120)
            let future = movement.map { time >= $0.start+$0.duration ? $0.to : $0.state(time-$0.start).value } ?? position
            guard hoverTarget(point,at:future,time:time) != target else { continue }
            let generation = hoverGeneration
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.hoverGeneration == generation else { return }
                self.trackPointer(point)
            }
            hoverBoundary = work
            DispatchQueue.main.asyncAfter(deadline:.now()+max(0,time-now),execute:work)
            break
        }
    }
    func pointerMoved() {
        guard let window else { return }
        let point = lastPointer ?? convert(window.convertPoint(fromScreen:NSEvent.mouseLocation),from:nil)
        trackPointer(point)
    }
    override func mouseMoved(with event:NSEvent) { trackPointer(convert(event.locationInWindow,from:nil)) }
    override func mouseDown(with event:NSEvent) {
        trackPointer(convert(event.locationInWindow,from:nil))
        guard let (card,point) = hit(convert(event.locationInWindow,from:nil)), let owner else { return }
        pressedCopy = card.virtual == owner.selected && card.copyRect.contains(point) && (card.hovered || owner.flowFocused || owner.copiedId == card.card.id)
        if pressedCopy { tween(card.copy,"transform.scale",to:0.97,duration:SearchDesign.duration("instant")); tween(card.copy,"opacity",to:0.84,duration:SearchDesign.duration("instant")) }
        press = event; pressedVirtual = card.virtual; dragCard = card
        dragWanted = false; dragStarted = false; dragWriters = []
        exportToken = UUID().uuidString; exportSession = owner.session
    }
    override func mouseDragged(with event:NSEvent) {
        guard !pressedCopy, let press, let owner, pressedVirtual == owner.selected, !dragStarted else { return }
        if hypot(event.locationInWindow.x-press.locationInWindow.x,event.locationInWindow.y-press.locationInWindow.y) >= 5 && !dragWanted {
            dragWanted = true
            if let dragCard { owner.send("prepareDrag",["id":dragCard.card.id,"token":exportToken]) }
        }
        _ = beginIfReady()
    }
    override func mouseUp(with event:NSEvent) {
        defer { press = nil; pressedVirtual = nil; dragWriters = []; pressedCopy = false }
        guard press != nil, !dragWanted, !dragStarted, let virtual = pressedVirtual, let owner else { return }
        if pressedCopy, let dragCard { searchScaleSpring(dragCard.copy,to:1,spring:"snappy") }
        guard let (card,point) = hit(convert(event.locationInWindow,from:nil)), card.virtual == virtual else { return }
        if pressedCopy { if card.copyRect.contains(point) { owner.copyCurrent() }; return }
        if virtual == owner.selected { owner.openLibrary() } else { go(virtual); trackPointer(convert(event.locationInWindow,from:nil)) }
    }
    func prepared(_ token:String, paths:[String], text:String?) -> Bool {
        guard token == exportToken, press != nil else { return false }
        if let text {
            let item = NSPasteboardItem()
            guard item.setString(text,forType:.string) else { return false }
            dragWriters = [item]
        } else {
            dragWriters = paths.map { NSURL(fileURLWithPath:$0) }
        }
        return beginIfReady()
    }
    private func beginIfReady() -> Bool {
        guard dragWanted, !dragStarted, let press, !dragWriters.isEmpty, let dragCard,
              NSEvent.pressedMouseButtons & 1 != 0, window?.windowNumber == press.windowNumber else { return false }
        let frame = dragCard.root.convert(dragCard.root.bounds,to:layer)
        let items = dragWriters.enumerated().map { i,writer in
            let item = NSDraggingItem(pasteboardWriter:writer)
            item.setDraggingFrame(frame,contents:i == 0 ? dragCard.dragImage() : nil); return item
        }
        dragStarted = true; owner?.dragging = true; owner?.draggingFlow = self
        let session = beginDraggingSession(with:items,event:press,source:self)
        session.draggingFormation = .none; session.animatesToStartingPositionsOnCancelOrFail = true
        return true
    }
    func draggingSession(_ session:NSDraggingSession,sourceOperationMaskFor context:NSDraggingContext) -> NSDragOperation { .copy }
    func draggingSession(_ session:NSDraggingSession,endedAt point:NSPoint,operation:NSDragOperation) {
        press = nil; dragWriters = []; dragCard = nil
        owner?.send("dragFinished",["token":exportToken,"dropped":operation.contains(.copy)],session:exportSession)
        owner?.dragging = false; owner?.updatePointer()
        let owner = owner
        DispatchQueue.main.async { [self] in if owner?.draggingFlow === self { owner?.draggingFlow = nil } }
    }
}
