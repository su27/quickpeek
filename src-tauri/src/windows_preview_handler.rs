use std::{
    collections::VecDeque,
    ffi::c_void,
    io::{BufRead, BufReader, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
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
const WM_HELPER_SHOW: u32 = WM_APP + 0x63;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);

struct HostThread {
    thread_id: AtomicU32,
    actions: OnceLock<Mutex<VecDeque<Action>>>,
    responsive: AtomicBool,
}
impl HostThread {
    const fn new() -> Self {
        Self {
            thread_id: AtomicU32::new(0),
            actions: OnceLock::new(),
            responsive: AtomicBool::new(true),
        }
    }
    fn actions(&self) -> &Mutex<VecDeque<Action>> {
        self.actions.get_or_init(|| Mutex::new(VecDeque::new()))
    }
}
static RTF_HOST: HostThread = HostThread::new();
static COM_HOST: HostThread = HostThread::new();
static RTF_GENERATION: AtomicU32 = AtomicU32::new(u32::MAX);

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

fn post_action(host: &HostThread, action: Action) -> Result<(), String> {
    let thread_id = host.thread_id.load(Ordering::SeqCst);
    if thread_id == 0 {
        return Err("Windows preview host is not ready".to_string());
    }
    host.actions()
        .lock()
        .map_err(|_| "System preview queue is unavailable".to_string())?
        .push_back(action);
    unsafe {
        PostThreadMessageW(
            thread_id,
            WM_QUICKPEEK_PREVIEW_HANDLER_ACTION,
            Default::default(),
            Default::default(),
        )
        .map_err(|error| format!("Could not notify system preview host: {error}"))?;
    }
    Ok(())
}

// The deadline is a failure limit, not a rendering delay. Cancellation is checked
// even while a third-party COM server is busy, so later files can still load.
fn wait_for_reply(
    host: &HostThread,
    receiver: mpsc::Receiver<bool>,
    generation: u32,
) -> Result<bool, String> {
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
                host.responsive.store(false, Ordering::SeqCst);
                let _ = unload(Some(generation));
                return Err("Windows preview handler timed out".to_string());
            }
        }
    }
}

pub fn prepare(path: PathBuf, generation: u32) -> Result<bool, String> {
    if !crate::preview_generation_is_current(generation) {
        return Ok(false);
    }
    let rtf = path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("rtf"));
    let host = if rtf { &RTF_HOST } else { &COM_HOST };
    if !host.responsive.load(Ordering::SeqCst) {
        return Ok(false);
    }
    RTF_GENERATION.store(if rtf { generation } else { u32::MAX }, Ordering::SeqCst);
    let (sender, receiver) = mpsc::channel();
    post_action(
        host,
        Action::Prepare {
            path,
            generation,
            reply: sender,
        },
    )?;
    wait_for_reply(host, receiver, generation)
}

pub fn activate(generation: u32) -> Result<bool, String> {
    let host = if RTF_GENERATION.load(Ordering::SeqCst) == generation {
        &RTF_HOST
    } else {
        &COM_HOST
    };
    let (sender, receiver) = mpsc::channel();
    post_action(
        host,
        Action::Activate {
            generation,
            reply: sender,
        },
    )?;
    wait_for_reply(host, receiver, generation)
}

pub fn unload(generation: Option<u32>) -> Result<(), String> {
    for host in [&RTF_HOST, &COM_HOST] {
        if host.thread_id.load(Ordering::SeqCst) != 0 {
            // Coalesce obsolete work: a stalled extension must not accumulate a
            // request for every selection made while it is unresponsive.
            if let Ok(mut queue) = host.actions().lock() {
                queue.retain(|action| match action {
                    Action::Prepare { generation: g, .. }
                    | Action::Activate { generation: g, .. } => {
                        generation.is_some_and(|id| *g != id)
                    }
                    Action::Unload { .. } => false,
                });
            }
            post_action(host, Action::Unload { generation })?;
        }
    }
    Ok(())
}

pub fn resize() {
    for host in [&RTF_HOST, &COM_HOST] {
        let thread_id = host.thread_id.load(Ordering::SeqCst);
        if thread_id == 0 {
            continue;
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
}

pub fn start(parent: HWND) {
    start_host(parent, &RTF_HOST);
    start_host(parent, &COM_HOST);
}

fn start_host(parent: HWND, host: &'static HostThread) {
    if host.thread_id.load(Ordering::SeqCst) != 0 {
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
        host.thread_id.store(
            windows::Win32::System::Threading::GetCurrentThreadId(),
            Ordering::SeqCst,
        );
        let _ = ready_sender.send(true);

        let mut controller = PreviewHandlerController::default();
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).0 > 0 {
            if message.message == WM_QUICKPEEK_PREVIEW_HANDLER_ACTION {
                loop {
                    let action = host
                        .actions()
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
                    host.responsive.store(true, Ordering::SeqCst);
                }
            } else if message.message == WM_QUICKPEEK_PREVIEW_HANDLER_RESIZE {
                controller.resize(parent);
            } else {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }

        controller.unload(None);
        host.thread_id.store(0, Ordering::SeqCst);
        CoUninitialize();
    });

    if !ready_receiver
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or(false)
    {
        crate::diagnostic_log("Windows preview host failed to start");
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
                crate::diagnostic_log("No preview handler is registered for this file type");
                false
            }
            Err(error) => {
                crate::diagnostic_log(&format!(
                    "Windows preview handler could not open file: {error}"
                ));
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
            crate::diagnostic_log(&format!("Could not show Windows preview window: {error}"));
            return false;
        }

        // The new host is already above the WebView before the old one is released,
        // so switching between legacy Word files does not expose a white frame.
        self.active = Some(pending);
        true
    }

    fn resize(&mut self, parent: HWND) {
        if let Some(active) = self.active.as_ref() {
            if let Err(error) = active.resize(
                parent,
                crate::preview_generation_is_current(active.generation),
            ) {
                crate::diagnostic_log(&format!("Could not resize Windows preview window: {error}"));
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
    handler: Option<IPreviewHandler>,
    host_window: HWND,
    // Some preview handlers keep reading lazily after DoPreview returns.
    _stream: Option<IStream>,
    _rtf: Option<crate::windows_rtf::RtfLibrary>,
    helper: Option<Child>,
    helper_thread: u32,
}

impl PreviewHandlerHost {
    fn open(parent: HWND, path: &Path, generation: u32) -> windows::core::Result<Option<Self>> {
        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if extension == "rtf" {
            let (host_window, library) = crate::windows_rtf::open(parent, path, generation)?;
            return Ok(Some(Self {
                generation,
                handler: None,
                host_window,
                _stream: None,
                _rtf: Some(library),
                helper: None,
                helper_thread: 0,
            }));
        }
        if !["doc", "ppt", "pps", "pot"].contains(&extension.as_str()) {
            return Ok(None);
        }

        Self::open_helper(parent, path, generation)
            .map(Some)
            .map_err(|error| {
                windows::core::Error::new(windows::core::HRESULT(0x80004005u32 as i32), error)
            })
    }

    fn open_com(parent: HWND, path: &Path) -> windows::core::Result<Option<Self>> {
        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        let Some(clsid) = preview_handler_clsid(&format!(".{extension}"))? else {
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
            generation: 0,
            handler: Some(handler),
            host_window,
            _stream: None,
            _rtf: None,
            helper: None,
            helper_thread: 0,
        };
        let (initialized, stream) = initialize_handler(&instance, path);
        host._stream = stream;
        if !initialized {
            return Err(windows::core::Error::new(
                windows::core::HRESULT(0x8000_4005_u32 as i32),
                "Preview handler has no supported file initialization interface",
            ));
        }
        unsafe {
            let handler = host.handler.as_ref().unwrap();
            handler.SetWindow(host_window, &preview_bounds)?;
            handler.DoPreview()?;
        }
        Ok(Some(host))
    }

    fn show(&self) -> windows::core::Result<()> {
        if self.helper.is_some() {
            return unsafe {
                PostThreadMessageW(
                    self.helper_thread,
                    WM_HELPER_SHOW,
                    Default::default(),
                    Default::default(),
                )
            };
        }
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
        if self.helper.is_some() {
            return unsafe {
                PostThreadMessageW(
                    self.helper_thread,
                    WM_QUICKPEEK_PREVIEW_HANDLER_RESIZE,
                    windows::Win32::Foundation::WPARAM(usize::from(show)),
                    Default::default(),
                )
            };
        }
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
            if let Some(handler) = &self.handler {
                handler.SetRect(&preview_bounds)?;
            }
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
            )?;
            if self._rtf.is_some() {
                crate::windows_rtf::update_reading_rect(self.host_window)?;
            }
            Ok(())
        }
    }
}

impl Drop for PreviewHandlerHost {
    fn drop(&mut self) {
        if let Some(mut child) = self.helper.take() {
            // The helper owns COM and its windows. A hung Unload must never hold
            // the main application's STA or retain third-party DLLs indefinitely.
            let _ = child.kill();
            let _ = child.wait();
            return;
        }
        unsafe {
            let _ = ShowWindow(self.host_window, SW_HIDE);
            if let Some(handler) = &self.handler {
                let _ = handler.Unload();
            }
            let _ = DestroyWindow(self.host_window);
        }
    }
}

impl PreviewHandlerHost {
    fn open_helper(parent: HWND, path: &Path, generation: u32) -> Result<Self, String> {
        #[cfg(not(test))]
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        #[cfg(test)]
        let executable = PathBuf::from(
            std::env::var_os("QUICKPEEK_HELPER_EXE")
                .ok_or("Set QUICKPEEK_HELPER_EXE to the built application")?,
        );
        let mut child = Command::new(executable)
            .arg("--quickpeek-preview-helper")
            .arg((parent.0 as usize).to_string())
            .arg(path)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Could not start isolated preview: {e}"))?;
        let stdout = child.stdout.take().ok_or("Missing preview pipe")?;
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
            let _ = sender.send(result);
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        let ready = loop {
            if !crate::preview_generation_is_current(generation) || Instant::now() >= deadline {
                break Err("Isolated preview cancelled or timed out".to_string());
            }
            match receiver.recv_timeout(Duration::from_millis(50)) {
                Ok(Ok(line)) => {
                    let values: Vec<_> = line.split_whitespace().collect();
                    let parsed = if values.len() == 3 && values[0] == "READY" {
                        values[1]
                            .parse::<u32>()
                            .ok()
                            .zip(values[2].parse::<usize>().ok())
                    } else {
                        None
                    };
                    break parsed.ok_or_else(|| {
                        "System preview handler could not open this file".to_string()
                    });
                }
                Ok(Err(error)) => break Err(error.to_string()),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    break Err("Preview helper exited".into())
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        };
        match ready {
            Ok((helper_thread, handle)) => Ok(Self {
                generation,
                handler: None,
                host_window: HWND(handle as *mut c_void),
                _stream: None,
                _rtf: None,
                helper: Some(child),
                helper_thread,
            }),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(error)
            }
        }
    }
}

/// Entered before Tauri/single-instance initialization; only this child loads COM extensions.
pub fn run_helper_if_requested() -> bool {
    let args: Vec<_> = std::env::args_os().collect();
    if args
        .get(1)
        .is_none_or(|arg| arg != "--quickpeek-preview-helper")
    {
        return false;
    }
    let Some(parent_value) = args
        .get(2)
        .and_then(|arg| arg.to_str())
        .and_then(|s| s.parse::<usize>().ok())
    else {
        return true;
    };
    let Some(path) = args.get(3) else {
        return true;
    };
    unsafe {
        let parent = HWND(parent_value as *mut c_void);
        if !windows::Win32::UI::WindowsAndMessaging::IsWindow(Some(parent)).as_bool() {
            return true;
        }
        let _ = SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(parent));
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            return true;
        }
        let mut message = MSG::default();
        let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
        // Also exit if the parent disappears while an extension is blocked.
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            if !windows::Win32::UI::WindowsAndMessaging::IsWindow(Some(HWND(
                parent_value as *mut c_void,
            )))
            .as_bool()
            {
                std::process::exit(0);
            }
        });
        if let Ok(Some(host)) = PreviewHandlerHost::open_com(parent, Path::new(path)) {
            println!(
                "READY {} {}",
                windows::Win32::System::Threading::GetCurrentThreadId(),
                host.host_window.0 as usize
            );
            let _ = std::io::stdout().flush();
            while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                if message.message == WM_HELPER_SHOW {
                    let _ = host.show();
                } else if message.message == WM_QUICKPEEK_PREVIEW_HANDLER_RESIZE {
                    let _ = host.resize(parent, message.wParam.0 != 0);
                } else {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        }
        CoUninitialize();
    }
    true
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
    let value = read_registry_string(&direct_key)
        .or_else(|| {
            let class_name = read_registry_string(extension)?;
            read_registry_string(&format!(r"{class_name}\{PREVIEW_HANDLER_SHELLEX_KEY}"))
        })
        .or_else(|| {
            read_registry_string(&format!(
                r"SystemFileAssociations\{extension}\{PREVIEW_HANDLER_SHELLEX_KEY}"
            ))
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
    #[ignore = "hidden RTF host lifecycle test; run with --test-threads=1"]
    fn rtf_activation_resize_and_unload_preserve_native_layer() {
        use super::*;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindow, GetWindowLongW, IsWindow, GWL_STYLE, GW_CHILD,
            WS_OVERLAPPEDWINDOW, WS_VISIBLE,
        };
        let path = std::env::var_os("QUICKPEEK_RTF_FIXTURE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../testfiles/license-zh-cn.rtf")
            });
        assert!(path.is_file(), "set QUICKPEEK_RTF_FIXTURE");
        unsafe {
            let parent = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("hidden RTF host"),
                WS_OVERLAPPEDWINDOW | WS_CLIPCHILDREN,
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
            let foreground = GetForegroundWindow();
            let generation = crate::PREVIEW_GENERATION.load(Ordering::SeqCst);
            let mut controller = PreviewHandlerController::default();
            assert!(controller.prepare(parent, &path, generation));
            assert!(controller.active.is_none());
            let child = controller.pending.as_ref().unwrap().host_window;
            assert_eq!(GetWindowLongW(child, GWL_STYLE) as u32 & WS_VISIBLE.0, 0);
            assert!(controller.activate(generation));
            assert_ne!(GetWindowLongW(child, GWL_STYLE) as u32 & WS_VISIBLE.0, 0);
            // Model WebView's sibling being raised during resume/parent show.
            let competitor = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("browser layer"),
                WS_CHILD | WS_VISIBLE,
                0,
                0,
                800,
                650,
                Some(parent),
                None,
                None,
                None,
            )
            .unwrap();
            SetWindowPos(competitor, Some(HWND_TOP), 0, 0, 800, 650, SWP_NOACTIVATE).unwrap();
            assert_eq!(GetWindow(parent, GW_CHILD).unwrap(), competitor);
            controller.resize(parent);
            assert_eq!(GetWindow(parent, GW_CHILD).unwrap(), child);
            let mut parent_rect = RECT::default();
            let mut child_rect = RECT::default();
            GetClientRect(parent, &mut parent_rect).unwrap();
            // GetWindowRect includes the Rich Edit vertical scrollbar.
            windows::Win32::UI::WindowsAndMessaging::GetWindowRect(child, &mut child_rect).unwrap();
            assert_eq!(child_rect.right - child_rect.left, parent_rect.right);
            assert_eq!(child_rect.bottom - child_rect.top, parent_rect.bottom);
            controller.unload(Some(generation.wrapping_add(1)));
            assert!(IsWindow(Some(child)).as_bool());
            controller.unload(Some(generation));
            assert!(!IsWindow(Some(child)).as_bool());
            assert_eq!(GetForegroundWindow(), foreground, "hidden test stole focus");
            DestroyWindow(parent).unwrap();
        }
    }

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
