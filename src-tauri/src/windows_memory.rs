//! Release acknowledgement -> suspend; resume before dispatching the next file.
//! Never suspend by a wall-clock guess while the frontend still owns a document.
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use tauri::{AppHandle, Manager};
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment8, ICoreWebView2_3},
    TrySuspendCompletedHandler,
};
use windows::core::{Interface, BOOL};
use windows::Win32::{
    Foundation::CloseHandle,
    System::Threading::{
        GetCurrentProcess, OpenProcess, SetProcessWorkingSetSize,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
    },
};

static EPOCH: AtomicU32 = AtomicU32::new(0);
static IDLE_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn begin_cleanup() {
    IDLE_REQUESTED.store(true, Ordering::SeqCst);
}

pub fn resume(app: &AppHandle) {
    IDLE_REQUESTED.store(false, Ordering::SeqCst);
    EPOCH.fetch_add(1, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.with_webview(|webview| {
            let result = (|| -> windows::core::Result<()> {
                let controller = webview.controller();
                let core: ICoreWebView2_3 = unsafe { controller.CoreWebView2()? }.cast()?;
                unsafe {
                    core.Resume()?;
                    controller.SetIsVisible(true)?;
                }
                // This callback runs on the WebView's UI thread. Restore the
                // native sibling only after WebView visibility work has finished.
                crate::windows_preview_handler::resize();
                Ok(())
            })();
            if let Err(error) = result {
                crate::diagnostic_log(&format!("WebView resume failed: {error}"));
            }
        });
    }
}

fn still_idle(generation: u32, epoch: u32) -> bool {
    IDLE_REQUESTED.load(Ordering::SeqCst)
        && crate::preview_generation_is_current(generation)
        && EPOCH.load(Ordering::SeqCst) == epoch
}

// A one-shot working-set trim, not a timer and not a claim to free GPU/JS heaps.
// Only this WebView environment's processes are touched; never enumerate/trim all
// msedgewebview2.exe processes (other applications use them too).
fn release_idle_working_sets(
    environment: &ICoreWebView2Environment8,
    generation: u32,
    epoch: u32,
) -> windows::core::Result<()> {
    unsafe {
        let processes = environment.GetProcessInfos()?;
        let mut count = 0;
        processes.Count(&mut count)?;
        for index in 0..count {
            if !still_idle(generation, epoch) {
                return Ok(());
            }
            let mut pid = 0;
            processes.GetValueAtIndex(index)?.ProcessId(&mut pid)?;
            if pid <= 0 {
                continue;
            }
            if let Ok(handle) = OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_QUERY_LIMITED_INFORMATION,
                false,
                pid as u32,
            ) {
                let _ = SetProcessWorkingSetSize(handle, usize::MAX, usize::MAX);
                let _ = CloseHandle(handle);
            }
        }
        if still_idle(generation, epoch) {
            let _ = SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX);
        }
    }
    Ok(())
}

pub fn suspend_after_cleanup(app: &AppHandle, generation: u32) {
    let epoch = EPOCH.load(Ordering::SeqCst);
    if !still_idle(generation, epoch) {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(true) {
        return;
    }
    let check_window = window.clone();
    let _ = window.with_webview(move |webview| {
        if !still_idle(generation, epoch) || check_window.is_visible().unwrap_or(true) { return; }
        let result = (|| -> windows::core::Result<()> {
            let controller = webview.controller();
            let environment: ICoreWebView2Environment8 = webview.environment().cast()?;
            let core: ICoreWebView2_3 = unsafe { controller.CoreWebView2()? }.cast()?;
            // A native ShowWindow(SW_HIDE) does not necessarily update the
            // WebView controller's visibility; TrySuspend requires it explicitly.
            unsafe { controller.SetIsVisible(false)?; }
            let completed_core = core.clone();
            let completed = TrySuspendCompletedHandler::create(Box::new(move |result, success| {
                if !still_idle(generation, epoch) {
                    // A late completion must not freeze a newly opened preview.
                    if !IDLE_REQUESTED.load(Ordering::SeqCst) {
                        unsafe { completed_core.Resume()?; }
                    }
                    return Ok(());
                }
                let mut suspended = BOOL::default();
                unsafe { completed_core.IsSuspended(&mut suspended)?; }
                crate::diagnostic_log(&format!("WebView cleanup acknowledged; suspend success={success}, suspended={}, result={result:?}", suspended.as_bool()));
                if result.is_ok() && success && suspended.as_bool() {
                    // Release resident pages only after successful suspension,
                    // when media/staging resources have already been disposed.
                    release_idle_working_sets(&environment, generation, epoch)?;
                }
                Ok(())
            }));
            unsafe { core.TrySuspend(&completed)?; }
            Ok(())
        })();
        if let Err(error) = result { crate::diagnostic_log(&format!("WebView suspend failed: {error}")); }
    });
}
