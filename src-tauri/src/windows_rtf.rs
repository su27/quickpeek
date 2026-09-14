//! Read-only system Rich Edit. No Office automation, OLE objects, or link activation.
use std::{
    fs::File,
    io::Read,
    path::Path,
    time::{Duration, Instant},
};
use windows::{
    core::*,
    Win32::{
        Foundation::{FreeLibrary, HGLOBAL, HMODULE, HWND, LPARAM, RECT, WPARAM},
        System::{
            Com::{IDataObject, StructuredStorage::IStorage},
            LibraryLoader::{LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32},
            Ole::{
                IOleInPlaceFrame, IOleInPlaceUIWindow, IOleObject, DROPEFFECT, OLEINPLACEFRAMEINFO,
            },
            SystemServices::{MODIFIERKEYS_FLAGS, RECO_FLAGS},
        },
        UI::{Controls::RichEdit::*, WindowsAndMessaging::*},
    },
};

pub struct RtfLibrary(HMODULE);
impl Drop for RtfLibrary {
    fn drop(&mut self) {
        unsafe {
            let _ = FreeLibrary(self.0);
        }
    }
}

fn denied<T>() -> Result<T> {
    Err(Error::new(
        HRESULT(0x80070005_u32 as i32),
        "只读预览不允许嵌入对象",
    ))
}

#[implement(IRichEditOleCallback)]
struct NoObjects;
impl IRichEditOleCallback_Impl for NoObjects_Impl {
    fn GetNewStorage(&self) -> Result<IStorage> {
        denied()
    }
    fn GetInPlaceContext(
        &self,
        _: OutRef<'_, IOleInPlaceFrame>,
        _: OutRef<'_, IOleInPlaceUIWindow>,
        _: *mut OLEINPLACEFRAMEINFO,
    ) -> Result<()> {
        denied()
    }
    fn ShowContainerUI(&self, _: BOOL) -> Result<()> {
        denied()
    }
    fn QueryInsertObject(&self, _: *mut GUID, _: Ref<'_, IStorage>, _: i32) -> Result<()> {
        denied()
    }
    fn DeleteObject(&self, _: Ref<'_, IOleObject>) -> Result<()> {
        Ok(())
    }
    fn QueryAcceptData(
        &self,
        _: Ref<'_, IDataObject>,
        _: *mut u16,
        _: RECO_FLAGS,
        _: BOOL,
        _: HGLOBAL,
    ) -> Result<()> {
        denied()
    }
    fn ContextSensitiveHelp(&self, _: BOOL) -> Result<()> {
        denied()
    }
    fn GetClipboardData(
        &self,
        _: *mut CHARRANGE,
        _: u32,
        _: OutRef<'_, IDataObject>,
    ) -> Result<()> {
        denied()
    }
    fn GetDragDropEffect(&self, _: BOOL, _: MODIFIERKEYS_FLAGS, _: *mut DROPEFFECT) -> Result<()> {
        denied()
    }
    fn GetContextMenu(
        &self,
        _: RICH_EDIT_GET_CONTEXT_MENU_SEL_TYPE,
        _: Ref<'_, IOleObject>,
        _: *mut CHARRANGE,
        _: *mut HMENU,
    ) -> Result<()> {
        denied()
    }
}

struct Input {
    file: File,
    generation: u32,
    deadline: Instant,
    remaining: usize,
}
unsafe extern "system" fn read_rtf(
    cookie: usize,
    buffer: *mut u8,
    capacity: i32,
    read: *mut i32,
) -> u32 {
    let input = &mut *(cookie as *mut Input);
    *read = 0;
    if !crate::preview_generation_is_current(input.generation)
        || Instant::now() > input.deadline
        || capacity < 0
    {
        return 1;
    }
    if input.remaining == 0 {
        return 0;
    }
    let target = std::slice::from_raw_parts_mut(buffer, (capacity as usize).min(input.remaining));
    match input.file.read(target) {
        Ok(count) => {
            input.remaining -= count;
            *read = count as i32;
            0
        }
        Err(_) => 1,
    }
}

pub fn open(parent: HWND, path: &Path, generation: u32) -> Result<(HWND, RtfLibrary)> {
    let mut file = File::open(path).map_err(|_| Error::from_win32())?;
    let size = file.metadata().map_err(|_| Error::from_win32())?.len();
    if size > 20 * 1024 * 1024 {
        return denied();
    }
    let mut signature = [0; 5];
    file.read_exact(&mut signature)
        .map_err(|_| Error::new(HRESULT(-2147467259), "RTF 文件不完整"))?;
    if &signature != b"{\\rtf" {
        return denied();
    }
    use std::io::Seek;
    file.rewind().map_err(|_| Error::from_win32())?;
    unsafe {
        let library = RtfLibrary(LoadLibraryExW(
            w!("msftedit.dll"),
            None,
            LOAD_LIBRARY_SEARCH_SYSTEM32,
        )?);
        let mut bounds = RECT::default();
        GetClientRect(parent, &mut bounds)?;
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            MSFTEDIT_CLASS,
            w!(""),
            WS_CHILD
                | WS_VSCROLL
                | WS_CLIPSIBLINGS
                | WINDOW_STYLE((ES_MULTILINE | ES_READONLY) as u32),
            0,
            0,
            bounds.right.max(1),
            bounds.bottom.max(1),
            Some(parent),
            None,
            None,
            None,
        )?;
        let callback: IRichEditOleCallback = NoObjects.into();
        let accepted = SendMessageW(
            hwnd,
            EM_SETOLECALLBACK,
            None,
            Some(LPARAM(callback.as_raw() as isize)),
        );
        if accepted.0 == 0 {
            let _ = DestroyWindow(hwnd);
            return denied();
        }
        SendMessageW(hwnd, EM_EXLIMITTEXT, None, Some(LPARAM(20 * 1024 * 1024)));
        // A zero target width enables wrapping to the control width.
        SendMessageW(hwnd, EM_SETTARGETDEVICE, None, Some(LPARAM(0)));
        let mut input = Input {
            file,
            generation,
            deadline: Instant::now() + Duration::from_secs(10),
            remaining: size as usize,
        };
        let mut stream = EDITSTREAM {
            dwCookie: &mut input as *mut Input as usize,
            dwError: 0,
            pfnCallback: Some(read_rtf),
        };
        SendMessageW(
            hwnd,
            EM_STREAMIN,
            Some(WPARAM(SF_RTF as usize)),
            Some(LPARAM(&mut stream as *mut EDITSTREAM as isize)),
        );
        if stream.dwError != 0 || !crate::preview_generation_is_current(generation) {
            let _ = DestroyWindow(hwnd);
            return Err(Error::new(HRESULT(-2147467259), "RTF 读取失败或已取消"));
        }
        Ok((hwnd, library))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    unsafe fn assert_paints_text(child: HWND) {
        use windows::Win32::Graphics::Gdi::*;
        let mut rect = RECT::default();
        GetClientRect(child, &mut rect).unwrap();
        let dc = CreateCompatibleDC(None);
        let mut info = BITMAPINFO::default();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = rect.right;
        info.bmiHeader.biHeight = -rect.bottom;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        let mut bits = std::ptr::null_mut();
        let bitmap = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0).unwrap();
        let old = SelectObject(dc, bitmap.into());
        let count = (rect.right * rect.bottom) as usize;
        std::ptr::write_bytes(bits, 0x77, count * 4);
        SendMessageW(
            child,
            WM_PRINTCLIENT,
            Some(WPARAM(dc.0 as usize)),
            Some(LPARAM((PRF_CLIENT | PRF_ERASEBKGND) as isize)),
        );
        let _ = GdiFlush();
        let pixels = std::slice::from_raw_parts(bits as *const u32, count);
        let white = pixels
            .iter()
            .filter(|pixel| **pixel & 0xffffff == 0xffffff)
            .count();
        let black = pixels
            .iter()
            .filter(|pixel| **pixel & 0xffffff == 0)
            .count();
        SelectObject(dc, old);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(dc);
        eprintln!("RTF painted white={white} black={black} total={count}");
        assert!(white > count / 2, "RTF background did not paint");
        assert!(black > 100, "RTF text did not paint");
    }
    #[test]
    fn embedded_objects_are_denied() {
        let callback: IRichEditOleCallback = NoObjects.into();
        unsafe {
            assert!(callback.GetNewStorage().is_err());
            assert!(callback
                .QueryInsertObject(std::ptr::null_mut(), None::<&IStorage>, 0)
                .is_err());
        }
    }

    #[test]
    #[ignore = "hidden native control smoke test; run with --test-threads=1"]
    fn native_rtf_readonly_lifecycle() {
        let generated_path =
            std::env::temp_dir().join(format!("quickpeek-rtf-test-{}.rtf", std::process::id()));
        std::fs::write(
            &generated_path,
            br"{\rtf1\ansi Hello \b bold\b0\par Unicode: \u20013?\u25991?}",
        )
        .unwrap();
        let path = std::env::var_os("QUICKPEEK_RTF_FIXTURE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| generated_path.clone());
        unsafe {
            let parent = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("hidden test"),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                850,
                700,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let generation = crate::PREVIEW_GENERATION.load(std::sync::atomic::Ordering::SeqCst);
            let (child, library) = open(parent, &path, generation).unwrap();
            assert!(!IsWindowVisible(child).as_bool());
            assert!(GetWindowTextLengthW(child) > 10);
            let mut text = vec![0u16; (GetWindowTextLengthW(child) + 1) as usize];
            GetWindowTextW(child, &mut text);
            let text = String::from_utf16_lossy(&text);
            eprintln!(
                "RTF text length={}, prefix={:?}",
                text.len(),
                text.chars().take(80).collect::<String>()
            );
            if std::env::var_os("QUICKPEEK_RTF_FIXTURE").is_some() {
                assert!(text.contains("软件许可证和担保"));
            }
            assert_ne!(GetWindowLongW(child, GWL_STYLE) & ES_READONLY, 0);
            assert_paints_text(child);
            DestroyWindow(child).unwrap();
            drop(library);
            assert!(!IsWindow(Some(child)).as_bool());
            DestroyWindow(parent).unwrap();
        }
        std::fs::remove_file(generated_path).unwrap();
    }
}
