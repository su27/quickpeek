use serde::Serialize;
use std::{
    ffi::OsString,
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

#[cfg(target_os = "windows")]
mod windows_preview;

const MAX_TEXT_PREVIEW_BYTES: u64 = 20 * 1024 * 1024;
const BINARY_EXTENSIONS: &[&str] = &[
    "docx", "xlsx", "pptx", "avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp",
];

const TEXT_EXTENSIONS: &[&str] = &[
    "bash", "bat", "c", "cc", "cfg", "cjs", "clj", "cljs", "cmd", "conf", "cpp", "cs", "css",
    "csv", "dart", "env", "erl", "ex", "exs", "go", "h", "hpp", "hrl", "htm", "html", "ini",
    "java", "js", "json", "jsonc", "jsx", "kt", "kts", "less", "log", "lua", "md", "markdown",
    "mjs", "php", "pl", "ps1", "py", "pyw", "r", "rb", "rs", "scala", "scss", "sh", "sql",
    "svelte", "swift", "toml", "ts", "tsv", "tsx", "txt", "vue", "xml", "yaml", "yml", "zsh",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewRequest {
    path: String,
    size: u64,
}

fn diagnostic_log(message: &str) {
    eprintln!("[quickeye] {message}");
    if std::env::var_os("QUICKEYE_DIAGNOSTICS").is_none() {
        return;
    }

    let log_path = std::env::temp_dir().join("quickeye-error.log");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "{message}\n");
    }
}

fn find_supported_document_argument<I>(arguments: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = OsString>,
{
    arguments
        .into_iter()
        .map(PathBuf::from)
        .find(|path| is_supported_path(path))
}

fn initial_document_path() -> Option<PathBuf> {
    find_supported_document_argument(std::env::args_os().skip(1)).filter(|path| path.is_file())
}

fn is_supported_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            BINARY_EXTENSIONS
                .iter()
                .chain(TEXT_EXTENSIONS)
                .any(|supported| extension.eq_ignore_ascii_case(supported))
        })
}

fn validated_file_path(raw_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw_path);
    if !path.is_file() {
        return Err("文件不存在或不是普通文件".to_string());
    }
    if !is_supported_path(&path) {
        return Err("暂不支持这种文件格式".to_string());
    }
    Ok(path)
}

fn is_text_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            TEXT_EXTENSIONS
                .iter()
                .any(|text| extension.eq_ignore_ascii_case(text))
        })
}

fn preview_request(path: PathBuf) -> Option<PreviewRequest> {
    let size = std::fs::metadata(&path).ok()?.len();
    Some(PreviewRequest {
        path: path.to_string_lossy().into_owned(),
        size,
    })
}

#[tauri::command]
fn get_initial_preview() -> Option<PreviewRequest> {
    initial_document_path().and_then(preview_request)
}

#[tauri::command]
async fn read_preview_file(path: String) -> Result<tauri::ipc::Response, String> {
    let path = validated_file_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let file = std::fs::File::open(&path)
            .map_err(|error| format!("无法读取 {}：{error}", path.to_string_lossy()))?;
        let limit = if is_text_path(&path) {
            MAX_TEXT_PREVIEW_BYTES
        } else {
            u64::MAX
        };
        let expected_size = file
            .metadata()
            .map(|metadata| metadata.len().min(limit))
            .unwrap_or(0);
        let mut bytes = Vec::with_capacity(usize::try_from(expected_size).unwrap_or(0));
        file.take(limit)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("无法读取 {}：{error}", path.to_string_lossy()))?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|error| format!("读取任务失败：{error}"))?
}

pub(crate) fn hide_preview(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    windows_preview::clear_topmost(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let _ = app.emit_to("main", "preview-hidden", ());
    #[cfg(target_os = "windows")]
    windows_preview::schedule_low_memory(app.clone());
}

pub(crate) fn open_preview_path(app: &AppHandle, path: PathBuf) {
    if !path.is_file() || !is_supported_path(&path) {
        return;
    }

    #[cfg(target_os = "windows")]
    windows_preview::prepare_for_use(app);
    if let Some(preview) = preview_request(path) {
        let _ = app.emit_to("main", "preview-file", preview);
    }
}

#[tauri::command]
fn show_preview_window(app: AppHandle) {
    #[cfg(target_os = "windows")]
    {
        windows_preview::prepare_for_use(&app);
        windows_preview::show_without_activation(&app);
    }
    #[cfg(not(target_os = "windows"))]
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
    }
}

#[tauri::command]
fn hide_preview_window(app: AppHandle) {
    hide_preview(&app);
}

#[tauri::command]
fn log_frontend_error(message: String) {
    diagnostic_log(&format!("frontend: {message}"));
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open", "打开文件…", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出 quickeye", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &quit_item])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("quickeye · 在资源管理器中按空格预览")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                #[cfg(target_os = "windows")]
                windows_preview::prepare_for_use(app);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            diagnostic_log(&format!("single-instance args: {args:?}"));
            let path = find_supported_document_argument(args.into_iter().map(OsString::from))
                .filter(|path| path.is_file());
            if let Some(path) = path {
                open_preview_path(app, path);
            } else if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                windows_preview::prepare_for_use(app);
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            setup_tray(app)?;
            #[cfg(target_os = "windows")]
            windows_preview::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                hide_preview(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_initial_preview,
            read_preview_file,
            show_preview_window,
            hide_preview_window,
            log_frontend_error
        ])
        .run(tauri::generate_context!())
        .expect("error while running quickeye");
}

#[cfg(test)]
mod tests {
    use super::find_supported_document_argument;
    use std::ffi::OsString;

    #[test]
    fn finds_supported_document_arguments_case_insensitively() {
        for path in [
            r"C:\docs\Report.DOCX",
            r"C:\sheets\Budget.XLSX",
            r"C:\slides\Pitch.PPTX",
            r"C:\images\Photo.JPEG",
            r"C:\code\main.RS",
            r"C:\notes\readme.TXT",
        ] {
            let result = find_supported_document_argument([
                OsString::from("--ignored"),
                OsString::from(path),
            ]);

            assert_eq!(result, Some(path.into()));
        }
    }

    #[test]
    fn ignores_unsupported_document_arguments() {
        let result = find_supported_document_argument([
            OsString::from(r"C:\docs\legacy.doc"),
            OsString::from(r"C:\sheets\legacy.xls"),
            OsString::from(r"C:\slides\legacy.ppt"),
            OsString::from(r"C:\images\camera.raw"),
            OsString::from(r"C:\docs\manual.pdf"),
        ]);

        assert_eq!(result, None);
    }
}
