//! Public AppKit transport for text and file groups.
use crate::reference_drag::{DragHotspot, DragOutcome, DragStatus};
use crate::reference_transfer::Transfer;
use objc2::{
    define_class, msg_send, rc::Retained, runtime::ProtocolObject, AnyThread, DefinedClass,
    MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSApplication, NSDragOperation, NSDraggingContext, NSDraggingFormation, NSDraggingItem,
    NSDraggingSession, NSDraggingSource, NSEvent, NSImage, NSPasteboard, NSPasteboardItem,
    NSPasteboardTypeString, NSPasteboardWriting, NSView,
};
use objc2_foundation::{
    NSArray, NSData, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSURL,
};
use std::{cell::RefCell, sync::mpsc::Sender, time::Instant};

fn writers(
    transfer: &Transfer,
) -> Result<Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>>, String> {
    if let Transfer::Text(text) = transfer {
        let item = NSPasteboardItem::new();
        if !item.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString }) {
            return Err("The reference text could not be prepared.".into());
        }
        return Ok(vec![ProtocolObject::from_retained(item)]);
    }
    let files = transfer.files();
    if files.is_empty() || files.len() > 10_001 {
        return Err("Invalid outgoing file group.".into());
    }
    let mut urls = Vec::with_capacity(files.len());
    for file in files {
        if !file.is_absolute() || !file.is_file() {
            return Err("An outgoing file is unavailable. Copy again.".into());
        }
        let path = file
            .to_str()
            .ok_or("The outgoing filename is not supported.")?;
        urls.push(ProtocolObject::<dyn NSPasteboardWriting>::from_retained(
            NSURL::fileURLWithPath(&NSString::from_str(path)),
        ));
    }
    Ok(urls)
}

fn write_transfer(pasteboard: &NSPasteboard, transfer: &Transfer) -> Result<(), String> {
    let objects = NSArray::from_retained_slice(&writers(transfer)?);
    pasteboard.clearContents();
    if !pasteboard.writeObjects(&objects) {
        return Err("The references could not be copied. Try again.".into());
    }
    Ok(())
}

pub fn copy_to_clipboard(transfer: &Transfer) -> Result<(), String> {
    write_transfer(&NSPasteboard::generalPasteboard(), transfer)
}

struct DragState {
    completion: RefCell<Option<Sender<Result<DragOutcome, String>>>>,
    started: Instant,
}
define_class!(
    // NSObject has no extra subclassing invariants; AppKit calls on the UI thread.
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[ivars = DragState]
    struct StashDockDragSource;
    unsafe impl NSObjectProtocol for StashDockDragSource {}
    unsafe impl NSDraggingSource for StashDockDragSource {
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        fn operation(
            &self,
            _session: &NSDraggingSession,
            _context: NSDraggingContext,
        ) -> NSDragOperation {
            NSDragOperation::Copy
        }
        #[unsafe(method(draggingSession:endedAtPoint:operation:))]
        fn ended(&self, _session: &NSDraggingSession, _point: NSPoint, operation: NSDragOperation) {
            if let Some(completion) = self.ivars().completion.borrow_mut().take() {
                let dropped = operation.contains(NSDragOperation::Copy);
                let mut outcome = DragOutcome::released();
                outcome.dropped = dropped;
                outcome.status = if dropped {
                    DragStatus::Dropped
                } else {
                    DragStatus::Cancelled
                };
                outcome.effect = operation.bits() as u32;
                outcome.elapsed_ms = self.ivars().started.elapsed().as_millis() as u64;
                outcome.preview_ready = true;
                outcome.copy_target_seen = dropped;
                let _ = completion.send(Ok(outcome));
            }
        }
    }
);
thread_local! {
    // AppKit does not retain a session's source. Keep one bounded delegate until
    // the next drag, avoiding release of `self` inside its completion callback.
    static DRAG_SOURCE: RefCell<Option<Retained<StashDockDragSource>>> = const { RefCell::new(None) };
}

pub fn start_drag(
    source: &tauri::WebviewWindow,
    transfer: &Transfer,
    png: &[u8],
    hotspot: Option<DragHotspot>,
    completion: Sender<Result<DragOutcome, String>>,
) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("Native dragging requires the UI thread.")?;
    let app = NSApplication::sharedApplication(mtm);
    if !app.isActive() || !source.is_focused().map_err(|e| e.to_string())? {
        return Err("The drag source is no longer the foreground app.".into());
    }
    if NSEvent::pressedMouseButtons() & 1 == 0 {
        let _ = completion.send(Ok(DragOutcome::released()));
        return Ok(());
    }
    let event = app
        .currentEvent()
        .ok_or("The original drag gesture is unavailable.")?;
    let pointer = source.ns_view().map_err(|e| e.to_string())?;
    // SAFETY: Tauri owns this live NSView, and we are on its UI thread.
    let view =
        unsafe { pointer.cast::<NSView>().as_ref() }.ok_or("The drag source is unavailable.")?;
    if view
        .window()
        .is_none_or(|window| window.windowNumber() != event.windowNumber())
    {
        return Err("The original drag gesture belongs to another window.".into());
    }
    let image = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(png))
        .ok_or("The drag preview could not be read.")?;
    let size = NSSize::new(
        u32::from_be_bytes(png[16..20].try_into().unwrap()) as f64,
        u32::from_be_bytes(png[20..24].try_into().unwrap()) as f64,
    );
    image.setSize(size);
    let point = view.convertPoint_fromView(event.locationInWindow(), None);
    let hotspot = hotspot.unwrap_or(DragHotspot { x: 24, y: 24 });
    let x = (hotspot.x as f64).clamp(0.0, size.width - 1.0);
    let y = (hotspot.y as f64).clamp(0.0, size.height - 1.0);
    let origin = NSPoint::new(
        point.x - x,
        if view.isFlipped() {
            point.y - y
        } else {
            point.y - size.height + y
        },
    );
    let writers = writers(transfer)?;
    let mut items = Vec::with_capacity(writers.len());
    for (index, writer) in writers.iter().enumerate() {
        let item = NSDraggingItem::initWithPasteboardWriter(NSDraggingItem::alloc(), writer);
        // SAFETY: NSImage is a documented contents type. One preview represents
        // the complete selection while each item keeps its pasteboard data.
        unsafe {
            item.setDraggingFrame_contents(
                NSRect::new(origin, size),
                if index == 0 { Some(&image) } else { None },
            )
        };
        items.push(item);
    }
    let allocated = StashDockDragSource::alloc(mtm).set_ivars(DragState {
        completion: RefCell::new(Some(completion)),
        started: Instant::now(),
    });
    // SAFETY: NSObject's init has the declared signature and initializes super.
    let delegate: Retained<StashDockDragSource> = unsafe { msg_send![super(allocated), init] };
    DRAG_SOURCE.with(|slot| *slot.borrow_mut() = Some(delegate.clone()));
    let session = view.beginDraggingSessionWithItems_event_source(
        &NSArray::from_retained_slice(&items),
        &event,
        ProtocolObject::from_ref(&*delegate),
    );
    session.setDraggingFormation(NSDraggingFormation::None);
    session.setAnimatesToStartingPositionsOnCancelOrFail(true);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2_app_kit::NSPasteboardTypeFileURL;
    use std::path::PathBuf;

    #[test]
    fn note_transfer_is_text_with_no_file_url() {
        let board = NSPasteboard::pasteboardWithUniqueName();
        let body = "Note body 中文";
        write_transfer(&board, &Transfer::Text(body.into())).unwrap();
        let items = board.pasteboardItems().unwrap();
        assert_eq!(items.len(), 1);
        let item = items.iter().next().unwrap();
        assert_eq!(
            item
                .stringForType(unsafe { NSPasteboardTypeString })
                .unwrap()
                .to_string(),
            body
        );
        assert!(item
            .stringForType(unsafe { NSPasteboardTypeFileURL })
            .is_none());
        board.clearContents();
    }

    #[test]
    fn named_pasteboard_receives_separate_real_files_and_rejects_missing_files() {
        let root =
            std::env::temp_dir().join(format!("stashdock-pasteboard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        // The transport treats format bytes as opaque; this does not assert
        // PDF/Office parsing or receipt in an AI application's composer.
        let payloads: Vec<(&str, &[u8])> = vec![
            ("Original 中文.pdf", b"%PDF-1.7\0\xff original bytes"),
            ("Office 📚.docx", b"PK\x03\x04\0\xfe opaque package bytes"),
            ("Image.png", b"\x89PNG\r\n\x1a\n\0\xff opaque raster bytes"),
            ("Original.txt", "Text file 中文".as_bytes()),
            ("Context.md", b"# Supplemental context"),
        ];
        let files: Vec<PathBuf> = payloads.iter().map(|(name, _)| root.join(name)).collect();
        for (path, (_, bytes)) in files.iter().zip(&payloads) {
            std::fs::write(path, bytes).unwrap();
        }
        let board = NSPasteboard::pasteboardWithUniqueName();
        write_transfer(
            &board,
            &Transfer::Files {
                context_file: Some(files.last().unwrap().clone()),
                files: files.clone(),
            },
        )
        .unwrap();
        let items = board.pasteboardItems().unwrap();
        assert_eq!(items.len(), files.len());
        for (index, item) in items.iter().enumerate() {
            let url = item
                .stringForType(unsafe { NSPasteboardTypeFileURL })
                .unwrap();
            let path = url::Url::parse(&url.to_string())
                .unwrap()
                .to_file_path()
                .unwrap();
            assert_eq!(path, files[index]);
            assert_eq!(std::fs::read(path).unwrap(), payloads[index].1);
        }
        let missing = root.join("missing.txt");
        assert!(write_transfer(
            &board,
            &Transfer::Files {
                context_file: Some(missing.clone()),
                files: vec![missing]
            }
        )
        .is_err());
        assert_eq!(board.pasteboardItems().unwrap().len(), files.len());
        board.clearContents();
        std::fs::remove_dir_all(root).unwrap();
    }
}
