//! Windows text and file transport for the foreground StashDock source window.
//! Never synthesize input, change focus, or attach input queues.
use super::reference_drag::{DragOutcome, DragStatus};
use super::reference_transfer::Transfer;
use std::{
    cell::RefCell,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Instant,
};
use windows::{
    core::*,
    Win32::{
        Foundation::*,
        Graphics::Gdi::*,
        System::{Com::*, Memory::*, Ole::*, SystemServices::MODIFIERKEYS_FLAGS},
        UI::{Input::KeyboardAndMouse::*, Shell::*},
    },
};

#[derive(Default)]
struct Feedback {
    copy_target_seen: bool,
    query_count: u32,
    first_queue_button_down: Option<bool>,
    first_physical_button_down: Option<bool>,
}

#[implement(IDropSource)]
struct Source {
    started: Instant,
    feedback: Arc<Mutex<Feedback>>,
}

fn drag_action(escape: bool, physical_button_down: bool, timed_out: bool) -> HRESULT {
    if escape || timed_out {
        DRAGDROP_S_CANCEL
    } else if !physical_button_down {
        DRAGDROP_S_DROP
    } else {
        S_OK
    }
}

#[allow(non_snake_case)]
impl IDropSource_Impl for Source {
    fn QueryContinueDrag(&self, escape: BOOL, keys: MODIFIERKEYS_FLAGS) -> HRESULT {
        // Read the physical held button as the cursor leaves the source WebView.
        // Foreign-process gestures are rejected before this loop can begin.
        let physical = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0 };
        let mut feedback = self.feedback.lock().unwrap_or_else(|e| e.into_inner());
        feedback.query_count += 1;
        feedback
            .first_queue_button_down
            .get_or_insert(keys.0 & 1 != 0);
        feedback.first_physical_button_down.get_or_insert(physical);
        drag_action(
            escape.as_bool(),
            physical,
            self.started.elapsed().as_secs() >= 45,
        )
    }
    fn GiveFeedback(&self, effect: DROPEFFECT) -> HRESULT {
        if effect.0 & DROPEFFECT_COPY.0 != 0 {
            self.feedback
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .copy_target_seen = true;
        }
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

struct OleSession;
impl Drop for OleSession {
    fn drop(&mut self) {
        unsafe {
            OleUninitialize();
        }
    }
}
struct Bitmap(HBITMAP);
impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(HGDIOBJ(self.0 .0));
        }
    }
}
struct ButtonState;
impl Drop for ButtonState {
    fn drop(&mut self) {
        let _ = sync_button_state();
    }
}

fn sync_button_state() -> Result<bool> {
    unsafe {
        let mut keys = [0_u8; 256];
        GetKeyboardState(&mut keys)?;
        let queued = keys[VK_LBUTTON.0 as usize] & 0x80 != 0;
        let down = GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0;
        keys[VK_LBUTTON.0 as usize] =
            (keys[VK_LBUTTON.0 as usize] & 1) | if down { 0x80 } else { 0 };
        // This updates ONLY this thread's state table, not system input or any
        // other application. OLE sees the actual held button at loop entry.
        SetKeyboardState(&keys)?;
        Ok(queued)
    }
}

fn premultiplied_bgra(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .flat_map(|p| {
            let alpha = p[3] as u16;
            [
                (p[2] as u16 * alpha / 255) as u8,
                (p[1] as u16 * alpha / 255) as u8,
                (p[0] as u16 * alpha / 255) as u8,
                p[3],
            ]
        })
        .collect()
}

fn drag_bitmap(png: &[u8]) -> std::result::Result<(Bitmap, i32, i32), String> {
    let image =
        tauri::image::Image::from_bytes(png).map_err(|_| "Could not decode the drag preview.")?;
    let width = image.width() as i32;
    let height = image.height() as i32;
    if width <= 0
        || height <= 0
        || width > 2048
        || height > 1536
        || width as i64 * height as i64 > 2_000_000
    {
        return Err("Invalid drag preview dimensions.".into());
    }
    let mut info = BITMAPINFO::default();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let mut bits = std::ptr::null_mut();
    let bitmap = Bitmap(
        unsafe { CreateDIBSection(HDC(0), &info, DIB_RGB_COLORS, &mut bits, HANDLE(0), 0) }
            .map_err(|e| format!("Could not create the drag preview: {e}"))?,
    );
    if bits.is_null() {
        return Err("Could not paint the drag preview.".into());
    }
    let pixels = premultiplied_bgra(image.rgba());
    unsafe {
        std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits.cast(), pixels.len());
    }
    Ok((bitmap, width, height))
}

fn classify_drop(result: HRESULT, effect: u32) -> DragStatus {
    if result == DRAGDROP_S_CANCEL {
        DragStatus::Cancelled
    } else if result == DRAGDROP_S_DROP && effect & DROPEFFECT_COPY.0 != 0 {
        DragStatus::Dropped
    } else {
        DragStatus::Rejected
    }
}

struct Pidl(*mut Common::ITEMIDLIST);
impl Drop for Pidl {
    fn drop(&mut self) {
        unsafe {
            ILFree(Some(self.0));
        }
    }
}

fn shell_data(files: &[PathBuf]) -> Result<IDataObject> {
    if files.is_empty() || files.iter().any(|file| file.parent() != files[0].parent()) {
        return Err(E_INVALIDARG.into());
    }
    let mut pidls = Vec::new();
    for file in files {
        let path: Vec<u16> = file
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut pidl = std::ptr::null_mut();
        unsafe { SHParseDisplayName(PCWSTR(path.as_ptr()), None, &mut pidl, 0, None) }?;
        pidls.push(Pidl(pidl));
    }
    let pointers: Vec<_> = pidls
        .iter()
        .map(|pidl| pidl.0 as *const Common::ITEMIDLIST)
        .collect();
    let items = unsafe { SHCreateShellItemArrayFromIDLists(&pointers) }?;
    // A flat Shell array supplies normal multi-file CF_HDROP and Shell formats.
    unsafe { items.BindToHandler(None, &BHID_DataObject) }
}

// The Shell object owns and duplicates STGMEDIUMs, including the drag image.
// Expose only formats we set: an empty Shell object also advertises CF_HDROP.
#[implement(IDataObject)]
struct TextData {
    storage: IDataObject,
    formats: RefCell<Vec<FORMATETC>>,
}

impl TextData {
    fn supports(&self, format: *const FORMATETC) -> bool {
        // COM supplies a valid FORMATETC for the duration of the call.
        let Some(format) = (unsafe { format.as_ref() }) else {
            return false;
        };
        self.formats.borrow().iter().any(|stored| {
            stored.cfFormat == format.cfFormat
                && stored.dwAspect == format.dwAspect
                && stored.lindex == format.lindex
                && stored.tymed & format.tymed != 0
        })
    }
}

impl IDataObject_Impl for TextData {
    fn GetData(&self, format: *const FORMATETC) -> Result<STGMEDIUM> {
        self.QueryGetData(format).ok()?;
        unsafe { self.storage.GetData(format) }
    }
    fn GetDataHere(&self, format: *const FORMATETC, medium: *mut STGMEDIUM) -> Result<()> {
        self.QueryGetData(format).ok()?;
        unsafe { self.storage.GetDataHere(format, medium) }
    }
    fn QueryGetData(&self, format: *const FORMATETC) -> HRESULT {
        if !self.supports(format) {
            return DV_E_FORMATETC;
        }
        unsafe { self.storage.QueryGetData(format) }
    }
    fn GetCanonicalFormatEtc(&self, format: *const FORMATETC, output: *mut FORMATETC) -> HRESULT {
        unsafe { self.storage.GetCanonicalFormatEtc(format, output) }
    }
    fn SetData(
        &self,
        format: *const FORMATETC,
        medium: *const STGMEDIUM,
        release: BOOL,
    ) -> Result<()> {
        let value = unsafe { format.as_ref() }.ok_or_else(|| Error::from(E_POINTER))?;
        // No target-device allocations are retained from a caller-owned pointer.
        if !value.ptd.is_null() {
            return Err(DV_E_DVTARGETDEVICE.into());
        }
        unsafe { self.storage.SetData(format, medium, release) }?;
        let mut formats = self.formats.borrow_mut();
        if let Some(stored) = formats.iter_mut().find(|stored| {
            stored.cfFormat == value.cfFormat
                && stored.dwAspect == value.dwAspect
                && stored.lindex == value.lindex
        }) {
            stored.tymed |= value.tymed;
        } else {
            formats.push(*value);
        }
        Ok(())
    }
    fn EnumFormatEtc(&self, direction: u32) -> Result<IEnumFORMATETC> {
        if direction != DATADIR_GET.0 as u32 {
            return Err(E_NOTIMPL.into());
        }
        unsafe { SHCreateStdEnumFmtEtc(&self.formats.borrow()) }
    }
    fn DAdvise(
        &self,
        format: *const FORMATETC,
        flags: u32,
        sink: Option<&IAdviseSink>,
    ) -> Result<u32> {
        unsafe { self.storage.DAdvise(format, flags, sink) }
    }
    fn DUnadvise(&self, connection: u32) -> Result<()> {
        unsafe { self.storage.DUnadvise(connection) }
    }
    fn EnumDAdvise(&self) -> Result<IEnumSTATDATA> {
        unsafe { self.storage.EnumDAdvise() }
    }
}

fn transfer_data(transfer: &Transfer) -> Result<IDataObject> {
    let text = match transfer {
        Transfer::Text(text) => text,
        Transfer::Files { files, .. } => return shell_data(files),
    };
    let data: IDataObject = TextData {
        storage: unsafe { SHCreateDataObject(None, None, None::<&IDataObject>) }?,
        formats: RefCell::new(Vec::new()),
    }
    .into();
    if text.contains('\0') {
        return Err(Error::new(
            E_INVALIDARG,
            "The note contains unsupported null characters.".into(),
        ));
    }
    let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, text.len() * std::mem::size_of::<u16>()) }?;
    let target = unsafe { GlobalLock(handle) }.cast::<u16>();
    if target.is_null() {
        let error = Error::from_win32();
        let _ = unsafe { GlobalFree(handle) };
        return Err(error);
    }
    unsafe { std::ptr::copy_nonoverlapping(text.as_ptr(), target, text.len()) };
    let _ = unsafe { GlobalUnlock(handle) };
    let format = FORMATETC {
        cfFormat: CF_UNICODETEXT.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0 as u32,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let medium = STGMEDIUM {
        tymed: TYMED_HGLOBAL.0 as u32,
        u: STGMEDIUM_0 { hGlobal: handle },
        pUnkForRelease: std::mem::ManuallyDrop::new(None),
    };
    if let Err(error) = unsafe { data.SetData(&format, &medium, true) } {
        let _ = unsafe { GlobalFree(handle) };
        return Err(error);
    }
    Ok(data)
}

/// Use the same data object as dragging and keep the formats after app exit.
pub fn copy_to_clipboard(transfer: &Transfer) -> std::result::Result<(), String> {
    unsafe { OleInitialize(None) }
        .map_err(|e| format!("Could not initialize clipboard copying: {e}"))?;
    let _ole = OleSession;
    let data =
        transfer_data(transfer).map_err(|e| format!("Could not prepare the reference: {e}"))?;
    unsafe { OleSetClipboard(&data) }
        .map_err(|e| format!("Clipboard access was blocked. Try again: {e}"))?;
    // Materialize the formats now so copying survives this object's lifetime.
    unsafe { OleFlushClipboard() }
        .map_err(|e| format!("Could not finish clipboard copying. Try again: {e}"))
}

pub fn start(
    transfer: &Transfer,
    png: &[u8],
    hotspot: Option<super::reference_drag::DragHotspot>,
) -> std::result::Result<DragOutcome, String> {
    unsafe { OleInitialize(None) }
        .map_err(|e| format!("Could not initialize reference dragging: {e}"))?;
    let _ole = OleSession;
    let data = transfer_data(transfer)
        .map_err(|e| format!("Could not prepare the reference transfer: {e}"))?;
    let (bitmap, width, height) = drag_bitmap(png)?;
    let helper: IDragSourceHelper =
        unsafe { CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER) }
            .map_err(|e| format!("Could not initialize the drag preview: {e}"))?;
    let hotspot = hotspot.unwrap_or(super::reference_drag::DragHotspot { x: 24, y: 24 });
    let image = SHDRAGIMAGE {
        sizeDragImage: SIZE {
            cx: width,
            cy: height,
        },
        ptOffset: POINT {
            x: hotspot.x.clamp(0, width - 1),
            y: hotspot.y.clamp(0, height - 1),
        },
        hbmpDragImage: bitmap.0,
        crColorKey: COLORREF(0xffffffff),
    };
    unsafe { helper.InitializeFromBitmap(&image, &data) }
        .map_err(|e| format!("Could not attach the drag preview: {e}"))?;
    let before =
        sync_button_state().map_err(|e| format!("Could not synchronize the drag gesture: {e}"))?;
    let _button = ButtonState;
    if unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) >= 0 } {
        return Ok(DragOutcome::released());
    }
    let started = Instant::now();
    let feedback = Arc::new(Mutex::new(Feedback::default()));
    let source: IDropSource = Source {
        started,
        feedback: feedback.clone(),
    }
    .into();
    let mut effect = DROPEFFECT::default();
    let result = unsafe { DoDragDrop(&data, &source, DROPEFFECT_COPY, &mut effect) };
    if result.is_err() {
        return Err(format!("Windows reference dragging failed: {result:?}"));
    }
    let feedback = feedback.lock().unwrap_or_else(|e| e.into_inner());
    let status = classify_drop(result, effect.0);
    Ok(DragOutcome {
        dropped: status == DragStatus::Dropped,
        status,
        elapsed_ms: started.elapsed().as_millis() as u64,
        effect: effect.0,
        hresult: Some(result.0),
        preview_ready: true,
        copy_target_seen: feedback.copy_target_seen,
        queue_button_before: Some(before),
        query_count: feedback.query_count,
        first_queue_button_down: feedback.first_queue_button_down,
        first_physical_button_down: feedback.first_physical_button_down,
    })
}

use std::os::windows::ffi::OsStrExt;

#[cfg(test)]
mod tests {
    use super::*;
    fn retry_clipboard<T>(mut action: impl FnMut() -> Result<T>) -> Result<T> {
        for attempt in 0..20 {
            match action() {
                Err(error)
                    if (error.code().0 == 0x800401D0_u32 as i32
                        || error.code().0 == 0x800401D4_u32 as i32)
                        && attempt < 19 =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(50))
                }
                result => return result,
            }
        }
        unreachable!()
    }
    #[test]
    #[ignore = "Writes the OS clipboard; run explicitly for file-copy acceptance"]
    fn copied_files_and_note_text_survive_the_source_thread() {
        assert_eq!(
            std::env::var("STASHDOCK_CLIPBOARD_TEST").as_deref(),
            Ok("1")
        );
        unsafe { OleInitialize(None) }.unwrap();
        let _ole = OleSession;
        // Preserve the user's clipboard while explicitly exercising the real OS
        // transport. Keep the previous IDataObject alive until after restoration.
        struct Restore(Option<IDataObject>);
        impl Restore {
            fn restore(&mut self) -> Result<()> {
                if let Some(previous) = self.0.as_ref() {
                    retry_clipboard(|| unsafe { OleSetClipboard(previous) })?;
                    retry_clipboard(|| unsafe { OleFlushClipboard() })?;
                    self.0 = None;
                }
                Ok(())
            }
        }
        impl Drop for Restore {
            fn drop(&mut self) {
                if let Err(error) = self.restore() {
                    eprintln!("Could not restore the clipboard: {error}");
                }
            }
        }
        let mut restore = Restore(Some(
            retry_clipboard(|| unsafe { OleGetClipboard() })
                .expect("Preserve the clipboard before writing any fixture"),
        ));
        let folder =
            std::env::temp_dir().join(format!("stashdock-clipboard-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join(super::super::reference_drag::export_filename(
            "## Clipboard test 资料",
            1,
        ));
        let content = "# StashDock context\n\n## Clipboard test 资料\nSource: StashDock\n\nFull Markdown context.\n";
        std::fs::write(&file, content).unwrap();
        let pdf = folder.join("Original 资料.pdf");
        let document = folder.join("Original.docx");
        std::fs::write(&pdf, b"%PDF-1.4\0 unchanged original").unwrap();
        std::fs::write(&document, b"PK\0 unchanged original").unwrap();
        let sources = vec![pdf.clone(), document.clone(), file.clone()];
        let transfer = Transfer::Files {
            files: sources,
            context_file: Some(file.clone()),
        };
        std::thread::spawn(move || copy_to_clipboard(&transfer).unwrap())
            .join()
            .unwrap();
        // Read from a new COM apartment after the copying thread and IDataObject
        // have ended. No receiver depends on the app keeping a hidden object alive.
        let data = retry_clipboard(|| unsafe { OleGetClipboard() }).unwrap();
        let format = FORMATETC {
            cfFormat: CF_HDROP.0 as u16,
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
            ..Default::default()
        };
        let mut medium = unsafe { data.GetData(&format) }.unwrap();
        let hdrop = HDROP(unsafe { medium.u.hGlobal.0 } as isize);
        assert_eq!(unsafe { DragQueryFileW(hdrop, u32::MAX, None) }, 3);
        for (index, expected) in [&pdf, &document, &file].into_iter().enumerate() {
            let mut path = [0_u16; 4096];
            let count = unsafe { DragQueryFileW(hdrop, index as u32, Some(&mut path)) };
            assert_eq!(
                PathBuf::from(String::from_utf16_lossy(&path[..count as usize])),
                *expected
            );
        }
        unsafe {
            ReleaseStgMedium(&mut medium);
        }
        assert_eq!(std::fs::read_to_string(&file).unwrap(), content);
        assert_eq!(
            std::fs::read(&pdf).unwrap(),
            b"%PDF-1.4\0 unchanged original"
        );
        drop(data);
        let note = "Note body 中文\nReady for the conversation.";
        // Verify originals-only payloads through the real persistent OLE path.
        let bare = Transfer::Files { files: vec![pdf.clone(), document.clone()], context_file: None };
        std::thread::spawn(move || copy_to_clipboard(&bare).unwrap()).join().unwrap();
        let data = retry_clipboard(|| unsafe { OleGetClipboard() }).unwrap();
        let mut medium = unsafe { data.GetData(&format) }.unwrap();
        let hdrop = HDROP(unsafe { medium.u.hGlobal.0 } as isize);
        assert_eq!(unsafe { DragQueryFileW(hdrop, u32::MAX, None) }, 2);
        unsafe { ReleaseStgMedium(&mut medium); }
        drop(data);
        std::thread::spawn(move || copy_to_clipboard(&Transfer::Text(note.into())).unwrap())
            .join()
            .unwrap();
        let data = retry_clipboard(|| unsafe { OleGetClipboard() }).unwrap();
        let text_format = FORMATETC {
            cfFormat: CF_UNICODETEXT.0,
            ..format
        };
        let mut medium = unsafe { data.GetData(&text_format) }.unwrap();
        unsafe {
            let handle = medium.u.hGlobal;
            let ptr = GlobalLock(handle).cast::<u16>();
            assert!(!ptr.is_null());
            let units = std::slice::from_raw_parts(ptr, note.encode_utf16().count());
            assert_eq!(String::from_utf16(units).unwrap(), note);
            let _ = GlobalUnlock(handle);
            ReleaseStgMedium(&mut medium);
            assert!(data.QueryGetData(&format).is_err());
        }
        drop(data);
        restore
            .restore()
            .expect("Restore the user's clipboard before removing fixture files");
        for file in [pdf, document, file] {
            std::fs::remove_file(file).unwrap();
        }
        std::fs::remove_dir(folder).unwrap();
    }
    #[test]
    fn a_foreign_queue_cannot_end_a_physically_held_gesture() {
        assert_eq!(drag_action(false, true, false), S_OK);
        assert_eq!(drag_action(false, false, false), DRAGDROP_S_DROP);
        assert_eq!(drag_action(true, true, false), DRAGDROP_S_CANCEL);
        assert_eq!(drag_action(false, true, true), DRAGDROP_S_CANCEL);
    }
    #[test]
    fn drop_requires_an_accepted_copy_effect() {
        assert_eq!(classify_drop(DRAGDROP_S_DROP, 0), DragStatus::Rejected);
        assert_eq!(
            classify_drop(DRAGDROP_S_DROP, DROPEFFECT_MOVE.0),
            DragStatus::Rejected
        );
        assert_eq!(
            classify_drop(DRAGDROP_S_DROP, DROPEFFECT_COPY.0),
            DragStatus::Dropped
        );
        assert_eq!(classify_drop(DRAGDROP_S_CANCEL, 1), DragStatus::Cancelled);
    }
    #[test]
    fn bitmap_preserves_alpha_and_converts_rgba_to_premultiplied_bgra() {
        assert_eq!(
            premultiplied_bgra(&[255, 0, 128, 128, 5, 10, 15, 255]),
            [64, 0, 128, 128, 15, 10, 5, 255]
        );
    }
    #[test]
    fn note_transfer_has_unicode_text_and_no_file_drop() {
        unsafe { OleInitialize(None) }.unwrap();
        let _ole = OleSession;
        let body = "笔记\nA complete note";
        let data = transfer_data(&Transfer::Text(body.into())).unwrap();
        let mut format = FORMATETC {
            cfFormat: CF_UNICODETEXT.0 as u16,
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
            ..Default::default()
        };
        unsafe {
            let mut medium = data.GetData(&format).unwrap();
            let handle = medium.u.hGlobal;
            let ptr = GlobalLock(handle).cast::<u16>();
            assert!(!ptr.is_null());
            let units = std::slice::from_raw_parts(ptr, body.encode_utf16().count() + 1);
            assert_eq!(String::from_utf16(&units[..units.len() - 1]).unwrap(), body);
            assert_eq!(units.last(), Some(&0));
            let _ = GlobalUnlock(handle);
            ReleaseStgMedium(&mut medium);
            format.cfFormat = CF_HDROP.0 as u16;
            assert!(data.QueryGetData(&format).is_err());
            assert!(data.GetData(&format).is_err());
            let enumerator = data.EnumFormatEtc(DATADIR_GET.0 as u32).unwrap();
            let mut formats = [FORMATETC::default(); 8];
            let mut count = 0;
            enumerator
                .Next(&mut formats, Some(&mut count))
                .ok()
                .unwrap();
            assert_eq!(count, 1);
            assert_eq!(formats[0].cfFormat, CF_UNICODETEXT.0);
            let (bitmap, width, height) =
                drag_bitmap(include_bytes!("../icons/32x32.png")).unwrap();
            let helper: IDragSourceHelper =
                CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER).unwrap();
            helper
                .InitializeFromBitmap(
                    &SHDRAGIMAGE {
                        sizeDragImage: SIZE {
                            cx: width,
                            cy: height,
                        },
                        ptOffset: POINT { x: 8, y: 8 },
                        hbmpDragImage: bitmap.0,
                        crColorKey: COLORREF(0xffffffff),
                    },
                    &data,
                )
                .unwrap();
            assert!(data.QueryGetData(&format).is_err());
        }
    }

    #[test]
    fn windows_shell_exports_a_real_file_and_accepts_the_alpha_preview() {
        unsafe { OleInitialize(None) }.unwrap();
        let _ole = OleSession;
        let file = std::env::temp_dir().join(format!(
            "StashDock drag test 资料 {}.md",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&file, "# Reference context\n\nA real local file.").unwrap();
        let result = (|| -> Result<()> {
            let data = shell_data(&[file.clone()])?;
            let format = FORMATETC {
                cfFormat: CF_HDROP.0 as u16,
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
                ..Default::default()
            };
            unsafe {
                data.QueryGetData(&format).ok()?;
            }
            let mut medium = unsafe { data.GetData(&format) }?;
            let mut path = [0_u16; 4096];
            let count =
                unsafe { DragQueryFileW(HDROP(medium.u.hGlobal.0 as isize), 0, Some(&mut path)) };
            unsafe {
                ReleaseStgMedium(&mut medium);
            }
            assert_eq!(
                String::from_utf16_lossy(&path[..count as usize]),
                file.to_string_lossy()
            );
            let (bitmap, width, height) =
                drag_bitmap(include_bytes!("../icons/32x32.png")).unwrap();
            assert_eq!((width, height), (32, 32));
            let helper: IDragSourceHelper =
                unsafe { CoCreateInstance(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER) }?;
            unsafe {
                helper.InitializeFromBitmap(
                    &SHDRAGIMAGE {
                        sizeDragImage: SIZE {
                            cx: width,
                            cy: height,
                        },
                        ptOffset: POINT { x: 8, y: 8 },
                        hbmpDragImage: bitmap.0,
                        crColorKey: COLORREF(0xffffffff),
                    },
                    &data,
                )
            }?;
            Ok(())
        })();
        let _ = std::fs::remove_file(&file);
        result.unwrap();
    }
    #[test]
    fn windows_shell_multifile_group_contains_originals_and_markdown_without_a_zip() {
        unsafe { OleInitialize(None) }.unwrap();
        let _ole = OleSession;
        let folder =
            std::env::temp_dir().join(format!("stashdock-shell-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&folder).unwrap();
        let files = [
            folder.join("Original 资料.pdf"),
            folder.join("Original.docx"),
            folder.join("StashDock context.md"),
        ];
        for (index, file) in files.iter().enumerate() {
            std::fs::write(file, format!("Unchanged fixture {index}")).unwrap();
        }
        let result = (|| -> Result<()> {
            let data = shell_data(&files)?;
            let format = FORMATETC {
                cfFormat: CF_HDROP.0 as u16,
                dwAspect: DVASPECT_CONTENT.0,
                lindex: -1,
                tymed: TYMED_HGLOBAL.0 as u32,
                ..Default::default()
            };
            let mut medium = unsafe { data.GetData(&format) }?;
            let hdrop = HDROP(unsafe { medium.u.hGlobal.0 } as isize);
            assert_eq!(unsafe { DragQueryFileW(hdrop, u32::MAX, None) }, 3);
            for (index, expected) in files.iter().enumerate() {
                let mut path = [0_u16; 4096];
                let count = unsafe { DragQueryFileW(hdrop, index as u32, Some(&mut path)) };
                assert_eq!(
                    PathBuf::from(String::from_utf16_lossy(&path[..count as usize])),
                    *expected
                );
            }
            unsafe {
                ReleaseStgMedium(&mut medium);
            }
            Ok(())
        })();
        for file in files {
            let _ = std::fs::remove_file(file);
        }
        let _ = std::fs::remove_dir(folder);
        result.unwrap();
    }
}
