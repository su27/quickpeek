use std::{
    collections::VecDeque,
    ffi::c_void,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc::{self, Sender},
        Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use windows::{
    core::{w, IUnknown, Interface, GUID, HSTRING, PCWSTR},
    Win32::{
        Foundation::{ERROR_SUCCESS, HWND, RECT},
        System::{
            Com::{
                CLSIDFromString, CoCreateInstance, CoInitializeEx, CoUninitialize, IBindCtx,
                IStream, CLSCTX_INPROC_SERVER, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED,
                STGM_READ,
            },
            Registry::{RegGetValueW, HKEY_CLASSES_ROOT, RRF_RT_REG_SZ},
        },
        UI::{
            HiDpi::{GetWindowDpiAwarenessContext, SetThreadDpiAwarenessContext},
            Shell::{
                IInitializeWithItem, IPreviewHandler, IShellItem,
                PropertiesSystem::{IInitializeWithFile, IInitializeWithStream},
                SHCreateItemFromParsingName, SHCreateStreamOnFileEx,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, DispatchMessageW, GetClientRect, GetMessageW,
                PeekMessageW, PostThreadMessageW, SetWindowPos, ShowWindow, TranslateMessage,
                HWND_TOP, MSG, PM_NOREMOVE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER,
                SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNOACTIVATE, WINDOW_EX_STYLE, WM_APP,
                WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
            },
        },
    },
};

const PREVIEW_HANDLER_SHELLEX_KEY: &str = r"shellex\{8895b1c6-b41f-4c1c-a562-0d564250836f}";
const WM_QUICKPEEK_PREVIEW_HANDLER_ACTION: u32 = WM_APP + 0x61;
const WM_QUICKPEEK_PREVIEW_HANDLER_RESIZE: u32 = WM_APP + 0x62;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

static THREAD_ID: AtomicU32 = AtomicU32::new(0);
static ACTIONS: OnceLock<Mutex<VecDeque<Action>>> = OnceLock::new();

enum Action {
    Prepare {
        path: PathBuf,
        generation: u32,
        reply: Sender<bool>,
    },
    Activate {
        generation: u32,
        reply: Sender<bool>,
    },
    Unload {
        generation: Option<u32>,
    },
}

fn action_queue() -> &'static Mutex<VecDeque<Action>> {
    ACTIONS.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn post_action(action: Action) -> Result<(), String> {
    let thread_id = THREAD_ID.load(Ordering::SeqCst);
    if thread_id == 0 {
        return Err("Windows 系统预览宿主尚未就绪".to_string());
    }
    action_queue()
        .lock()
        .map_err(|_| "系统预览请求队列不可用".to_string())?
        .push_back(action);
    unsafe {
        PostThreadMessageW(
            thread_id,
            WM_QUICKPEEK_PREVIEW_HANDLER_ACTION,
            Default::default(),
            Default::default(),
        )
        .map_err(|error| format!("无法通知系统预览宿主：{error}"))?;
    }
    Ok(())
}

// The deadline is a failure limit, not a rendering delay. Cancellation is checked
// even while a third-party COM server is busy, so later files can still load.
fn wait_for_reply(receiver: mpsc::Receiver<bool>, generation: u32) -> Result<bool, String> {
    let deadline = Instant::now() + REQUEST_TIMEOUT;
    loop {
        if !crate::preview_generation_is_current(generation) {
            let _ = unload(Some(generation));
            return Ok(false);
        }
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(result) => return Ok(result),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(false),
            Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < deadline => {}
            Err(_) => {
                let _ = unload(Some(generation));
                return Err("Windows 系统预览处理器响应超时".to_string());
            }
        }
    }
}

pub fn prepare(path: PathBuf, generation: u32) -> Result<bool, String> {
    if !crate::preview_generation_is_current(generation) {
        return Ok(false);
    }
    let (sender, receiver) = mpsc::channel();
    post_action(Action::Prepare {
        path,
        generation,
        reply: sender,
    })?;
    wait_for_reply(receiver, generation)
}

pub fn activate(generation: u32) -> Result<bool, String> {
    let (sender, receiver) = mpsc::channel();
    post_action(Action::Activate {
        generation,
        reply: sender,
    })?;
    wait_for_reply(receiver, generation)
}

pub fn unload(generation: Option<u32>) -> Result<(), String> {
    if THREAD_ID.load(Ordering::SeqCst) == 0 {
        return Ok(());
    }
    post_action(Action::Unload { generation })
}

pub fn resize() {
    let thread_id = THREAD_ID.load(Ordering::SeqCst);
    if thread_id == 0 {
        return;
    }
    unsafe {
        let _ = PostThreadMessageW(
            thread_id,
            WM_QUICKPEEK_PREVIEW_HANDLER_RESIZE,
            Default::default(),
            Default::default(),
        );
    }
}

pub fn start(parent: HWND) {
    if THREAD_ID.load(Ordering::SeqCst) != 0 {
        return;
    }
    let parent_value = parent.0 as isize;
    let (ready_sender, ready_receiver) = mpsc::channel();
    std::thread::spawn(move || unsafe {
        let parent = HWND(parent_value as *mut c_void);
        // A worker defaults to the process DPI context, which need not match
        // Tauri's window thread. Cross-DPI parenting can reset window coordinates.
        let dpi_context = GetWindowDpiAwarenessContext(parent);
        let _ = SetThreadDpiAwarenessContext(dpi_context);
        let initialization = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if initialization.is_err() {
            let _ = ready_sender.send(false);
            return;
        }

        // PostThreadMessage requires the target thread to own a message queue.
        let mut bootstrap_message = MSG::default();
        let _ = PeekMessageW(&mut bootstrap_message, None, 0, 0, PM_NOREMOVE);
        THREAD_ID.store(
            windows::Win32::System::Threading::GetCurrentThreadId(),
            Ordering::SeqCst,
        );
        let _ = ready_sender.send(true);

        let mut controller = PreviewHandlerController::default();
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).0 > 0 {
            if message.message == WM_QUICKPEEK_PREVIEW_HANDLER_ACTION {
                loop {
                    let action = action_queue()
                        .lock()
                        .ok()
                        .and_then(|mut queue| queue.pop_front());
                    let Some(action) = action else {
                        break;
                    };
                    match action {
                        Action::Prepare {
                            path,
                            generation,
                            reply,
                        } => {
                            let prepared = controller.prepare(parent, &path, generation);
                            if reply.send(prepared).is_err() {
                                controller.unload(Some(generation));
                            }
                        }
                        Action::Activate { generation, reply } => {
                            let activated = controller.activate(generation);
                            if reply.send(activated).is_err() {
                                controller.unload(Some(generation));
                            }
                        }
                        Action::Unload { generation } => {
                            controller.unload(generation);
                        }
                    }
                }
            } else if message.message == WM_QUICKPEEK_PREVIEW_HANDLER_RESIZE {
                controller.resize(parent);
            } else {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }

        controller.unload(None);
        THREAD_ID.store(0, Ordering::SeqCst);
        CoUninitialize();
    });

    if !ready_receiver
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or(false)
    {
        crate::diagnostic_log("Windows 系统预览宿主启动失败");
    }
}

#[derive(Default)]
struct PreviewHandlerController {
    active: Option<PreviewHandlerHost>,
    pending: Option<PreviewHandlerHost>,
}

impl PreviewHandlerController {
    fn prepare(&mut self, parent: HWND, path: &Path, generation: u32) -> bool {
        if !crate::preview_generation_is_current(generation) {
            return false;
        }
        self.pending = None;
        match PreviewHandlerHost::open(parent, path, generation) {
            Ok(Some(host)) if crate::preview_generation_is_current(generation) => {
                self.pending = Some(host);
                true
            }
            Ok(Some(_)) => false,
            Ok(None) => {
                crate::diagnostic_log("当前系统没有为 .doc 注册预览处理器");
                false
            }
            Err(error) => {
                crate::diagnostic_log(&format!("Windows 系统预览处理器无法打开文件：{error}"));
                false
            }
        }
    }

    fn activate(&mut self, generation: u32) -> bool {
        if !crate::preview_generation_is_current(generation)
            || self
                .pending
                .as_ref()
                .is_none_or(|host| host.generation != generation)
        {
            self.unload(Some(generation));
            return false;
        }
        let Some(pending) = self.pending.take() else {
            return false;
        };
        if let Err(error) = pending.show() {
            crate::diagnostic_log(&format!("Windows 系统预览窗口无法显示：{error}"));
            return false;
        }

        // The new host is already above the WebView before the old one is released,
        // so switching between legacy Word files does not expose a white frame.
        self.active = Some(pending);
        true
    }

    fn resize(&mut self, parent: HWND) {
        if let Some(active) = self.active.as_ref() {
            if let Err(error) = active.resize(parent, true) {
                crate::diagnostic_log(&format!("Windows 系统预览窗口缩放失败：{error}"));
            }
        }
        if let Some(pending) = self.pending.as_ref() {
            let _ = pending.resize(parent, false);
        }
    }

    fn unload(&mut self, generation: Option<u32>) {
        if self
            .pending
            .as_ref()
            .is_some_and(|host| generation.is_none_or(|id| host.generation == id))
        {
            self.pending = None;
        }
        if self
            .active
            .as_ref()
            .is_some_and(|host| generation.is_none_or(|id| host.generation == id))
        {
            self.active = None;
        }
    }
}

struct PreviewHandlerHost {
    generation: u32,
    handler: IPreviewHandler,
    host_window: HWND,
    // Some preview handlers keep reading lazily after DoPreview returns.
    _stream: Option<IStream>,
}

impl PreviewHandlerHost {
    fn open(parent: HWND, path: &Path, generation: u32) -> windows::core::Result<Option<Self>> {
        if !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("doc"))
        {
            return Ok(None);
        }

        let Some(clsid) = preview_handler_clsid(".doc")? else {
            return Ok(None);
        };
        let instance = unsafe {
            CoCreateInstance::<_, IUnknown>(&clsid, None::<&IUnknown>, CLSCTX_LOCAL_SERVER)
                .or_else(|_| {
                    CoCreateInstance::<_, IUnknown>(&clsid, None::<&IUnknown>, CLSCTX_INPROC_SERVER)
                })?
        };
        let handler: IPreviewHandler = instance.cast()?;
        let mut parent_bounds = RECT::default();
        unsafe { GetClientRect(parent, &mut parent_bounds)? };
        let width = (parent_bounds.right - parent_bounds.left).max(1);
        let height = (parent_bounds.bottom - parent_bounds.top).max(1);
        let host_window = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!(""),
                WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                0,
                0,
                width,
                height,
                Some(parent),
                None,
                None,
                None,
            )?
        };
        let preview_bounds = RECT {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        };
        // Establish ownership before fallible COM calls; both SetWindow and
        // DoPreview failures must Unload and destroy the native child.
        let mut host = Self {
            generation,
            handler,
            host_window,
            _stream: None,
        };
        let (initialized, stream) = initialize_handler(&instance, path);
        host._stream = stream;
        if !initialized {
            return Err(windows::core::Error::new(
                windows::core::HRESULT(0x8000_4005_u32 as i32),
                "预览处理器不支持可用的文件初始化接口",
            ));
        }
        unsafe {
            host.handler.SetWindow(host_window, &preview_bounds)?;
            host.handler.DoPreview()?;
        }
        Ok(Some(host))
    }

    fn show(&self) -> windows::core::Result<()> {
        unsafe {
            let _ = ShowWindow(self.host_window, SW_SHOWNOACTIVATE);
            SetWindowPos(
                self.host_window,
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
            )
        }
    }

    fn resize(&self, parent: HWND, show: bool) -> windows::core::Result<()> {
        let mut bounds = RECT::default();
        unsafe { GetClientRect(parent, &mut bounds)? };
        let width = (bounds.right - bounds.left).max(1);
        let height = (bounds.bottom - bounds.top).max(1);
        let preview_bounds = RECT {
            left: 0,
            top: 0,
            right: width,
            bottom: height,
        };
        unsafe {
            self.handler.SetRect(&preview_bounds)?;
            SetWindowPos(
                self.host_window,
                Some(HWND_TOP),
                0,
                0,
                width,
                height,
                SWP_NOACTIVATE
                    | SWP_NOOWNERZORDER
                    | if show {
                        SWP_SHOWWINDOW
                    } else {
                        Default::default()
                    },
            )
        }
    }
}

impl Drop for PreviewHandlerHost {
    fn drop(&mut self) {
        unsafe {
            let _ = ShowWindow(self.host_window, SW_HIDE);
            let _ = self.handler.Unload();
            let _ = DestroyWindow(self.host_window);
        }
    }
}

fn initialize_handler(instance: &IUnknown, path: &Path) -> (bool, Option<IStream>) {
    let path = HSTRING::from(path.to_string_lossy().as_ref());
    if let Ok(initializer) = instance.cast::<IInitializeWithStream>() {
        let stream =
            unsafe { SHCreateStreamOnFileEx(&path, STGM_READ.0, 0, false, None::<&IStream>) };
        if let Ok(stream) = stream {
            if unsafe { initializer.Initialize(&stream, STGM_READ.0) }.is_ok() {
                return (true, Some(stream));
            }
        }
    }

    if let Ok(initializer) = instance.cast::<IInitializeWithItem>() {
        let item =
            unsafe { SHCreateItemFromParsingName::<_, _, IShellItem>(&path, None::<&IBindCtx>) };
        if let Ok(item) = item {
            if unsafe { initializer.Initialize(&item, STGM_READ.0) }.is_ok() {
                return (true, None);
            }
        }
    }

    if let Ok(initializer) = instance.cast::<IInitializeWithFile>() {
        if unsafe { initializer.Initialize(&path, STGM_READ.0) }.is_ok() {
            return (true, None);
        }
    }

    (false, None)
}

fn preview_handler_clsid(extension: &str) -> windows::core::Result<Option<GUID>> {
    let direct_key = format!(r"{extension}\{PREVIEW_HANDLER_SHELLEX_KEY}");
    let value = read_registry_string(&direct_key).or_else(|| {
        let class_name = read_registry_string(extension)?;
        read_registry_string(&format!(r"{class_name}\{PREVIEW_HANDLER_SHELLEX_KEY}"))
    });
    value
        .map(|value| unsafe { CLSIDFromString(&HSTRING::from(value)) }.map(Some))
        .unwrap_or(Ok(None))
}

fn read_registry_string(subkey: &str) -> Option<String> {
    let subkey = HSTRING::from(subkey);
    let mut byte_count = 0_u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CLASSES_ROOT,
            &subkey,
            PCWSTR::null(),
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut byte_count),
        )
    };
    if status != ERROR_SUCCESS || byte_count < 2 {
        return None;
    }

    let mut buffer = vec![0_u16; (byte_count as usize).div_ceil(2)];
    let status = unsafe {
        RegGetValueW(
            HKEY_CLASSES_ROOT,
            &subkey,
            PCWSTR::null(),
            RRF_RT_REG_SZ,
            None,
            Some(buffer.as_mut_ptr().cast::<c_void>()),
            Some(&mut byte_count),
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let end = buffer
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(buffer.len());
    let value = String::from_utf16_lossy(&buffer[..end]).trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::preview_handler_clsid;

    #[test]
    fn querying_an_unknown_extension_is_a_clean_miss() {
        assert!(preview_handler_clsid(".quickpeek-no-handler")
            .expect("registry query should not fail")
            .is_none());
    }

    // Opt-in integration check: uses an installed handler and a supplied public
    // fixture, but never shows or focuses the test window.
    #[test]
    #[ignore = "requires QUICKPEEK_DOC_FIXTURE and an installed DOC preview handler"]
    fn native_doc_lifecycle_preserves_parent_bounds() {
        use super::*;
        use windows::Win32::UI::{
            HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            WindowsAndMessaging::{FindWindowExW, IsWindow, PM_REMOVE, WS_OVERLAPPEDWINDOW},
        };
        fn pump_until<T>(receiver: mpsc::Receiver<T>) -> T {
            let deadline = Instant::now() + Duration::from_secs(40);
            loop {
                if let Ok(value) = receiver.try_recv() {
                    return value;
                }
                assert!(
                    Instant::now() < deadline,
                    "native preview operation timed out"
                );
                unsafe {
                    let mut message = MSG::default();
                    while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        fn operation(action: impl FnOnce() -> Result<bool, String> + Send + 'static) -> bool {
            let (sender, receiver) = mpsc::channel();
            std::thread::spawn(move || {
                let _ = sender.send(action());
            });
            pump_until(receiver).expect("native operation failed")
        }
        let path = PathBuf::from(std::env::var("QUICKPEEK_DOC_FIXTURE").expect("set fixture path"));
        assert!(path.is_file());
        assert!(preview_handler_clsid(".doc").unwrap().is_some());
        unsafe {
            let previous_dpi =
                SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let parent = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("QuickPeek hidden DOC test"),
                WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
                100,
                100,
                850,
                745,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let mut before = RECT::default();
            GetClientRect(parent, &mut before).unwrap();
            start(parent);
            let generation = crate::PREVIEW_GENERATION.load(Ordering::SeqCst);
            assert!(
                operation(move || prepare(path, generation)),
                "handler failed to prepare fixture"
            );
            assert!(operation(move || activate(generation)));
            let mut after = RECT::default();
            GetClientRect(parent, &mut after).unwrap();
            assert_eq!((before.right, before.bottom), (after.right, after.bottom));
            // A stale renderer's disposal must not unload the current host.
            let host = FindWindowExW(Some(parent), None, w!("STATIC"), PCWSTR::null()).unwrap();
            unload(Some(generation.wrapping_add(1))).unwrap();
            assert!(!operation(move || activate(generation.wrapping_add(1))));
            assert!(IsWindow(Some(host)).as_bool());
            unload(Some(generation)).unwrap();
            // FIFO barrier also checks that activation cannot resurrect an unloaded preview.
            assert!(!operation(move || activate(generation)));
            assert!(!IsWindow(Some(host)).as_bool());
            let missing = std::env::temp_dir().join("quickpeek-no-such-doc-fixture.doc");
            assert!(!missing.exists());
            assert!(!operation(move || prepare(missing, generation)));
            assert!(FindWindowExW(Some(parent), None, w!("STATIC"), PCWSTR::null()).is_err());
            DestroyWindow(parent).unwrap();
            let _ = SetThreadDpiAwarenessContext(previous_dpi);
        }
    }
}
