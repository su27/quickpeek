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

mod audio_metadata;
mod pdf_metadata;
#[cfg(target_os = "windows")]
mod windows_preview;
#[cfg(target_os = "windows")]
mod windows_shell_icon;

const MAX_TEXT_PREVIEW_BYTES: u64 = 20 * 1024 * 1024;
const BINARY_EXTENSIONS: &[&str] = &[
    "csv", "docm", "docx", "dotm", "dotx", "ods", "potm", "potx", "ppsm", "ppsx", "pptm", "pptx",
    "tsv", "xls", "xlsb", "xlsm", "xlsx", "xltm", "xltx", "zip",
];

const STREAM_EXTENSIONS: &[&str] = &[
    "aac", "apng", "avif", "bmp", "flac", "gif", "ico", "jfif", "jpeg", "jpg", "m4a", "m4v", "mov",
    "mp3", "mp4", "ogg", "ogv", "opus", "pdf", "png", "svg", "wav", "webm", "webp",
];

const TEXT_EXTENSIONS: &[&str] = &[
    "bash", "bat", "c", "cc", "cfg", "cjs", "clj", "cljs", "cmd", "conf", "cpp", "cs", "css",
    "dart", "env", "erl", "ex", "exs", "go", "h", "hpp", "hrl", "htm", "html", "ini", "java", "js",
    "json", "jsonc", "jsx", "kt", "kts", "less", "log", "lua", "md", "markdown", "mjs", "php",
    "pl", "ps1", "py", "pyw", "r", "rb", "rs", "scala", "scss", "sh", "sql", "srt", "svelte",
    "swift", "toml", "ts", "tsx", "txt", "vue", "xml", "yaml", "yml", "zsh",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewRequest {
    is_directory: bool,
    modified_at: Option<u64>,
    path: String,
    size: u64,
}

#[derive(Clone, Serialize)]
struct PreviewDimensions {
    height: f64,
    width: f64,
}

fn diagnostic_log(message: &str) {
    eprintln!("[QuickPeek] {message}");
    if std::env::var_os("QUICKPEEK_DIAGNOSTICS").is_none() {
        return;
    }

    let log_path = std::env::temp_dir().join("quickpeek-error.log");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "{message}\n");
    }
}

fn find_preview_argument<I>(arguments: I) -> Option<PathBuf>
where
    I: IntoIterator<Item = OsString>,
{
    arguments
        .into_iter()
        .map(PathBuf::from)
        .find(|path| path.is_file() || path.is_dir())
}

fn initial_preview_path() -> Option<PathBuf> {
    find_preview_argument(std::env::args_os().skip(1))
}

fn is_supported_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            BINARY_EXTENSIONS
                .iter()
                .chain(STREAM_EXTENSIONS)
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

fn is_stream_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            STREAM_EXTENSIONS
                .iter()
                .any(|stream| extension.eq_ignore_ascii_case(stream))
        })
}

fn preview_request(path: PathBuf) -> Option<PreviewRequest> {
    let metadata = std::fs::metadata(&path).ok()?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok());
    Some(PreviewRequest {
        is_directory: metadata.is_dir(),
        modified_at,
        path: path.to_string_lossy().into_owned(),
        size: if metadata.is_file() {
            metadata.len()
        } else {
            0
        },
    })
}

#[tauri::command]
fn get_initial_preview(app: AppHandle) -> Option<PreviewRequest> {
    let path = initial_preview_path()?;
    #[cfg(target_os = "windows")]
    windows_preview::set_preview_target(&app, &path);
    preview_request(path)
}

#[tauri::command]
async fn read_preview_file(path: String) -> Result<tauri::ipc::Response, String> {
    let path = validated_file_path(&path)?;
    if is_stream_path(&path) {
        return Err("这种格式应通过流式文件地址读取".to_string());
    }
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

#[tauri::command]
async fn read_pdf_dimensions(path: String) -> Result<Option<PreviewDimensions>, String> {
    let path = validated_file_path(&path)?;
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return Err("文件不是 PDF".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        pdf_metadata::read_dimensions(&path)
            .map(|dimensions| dimensions.map(|(width, height)| PreviewDimensions { width, height }))
            .map_err(|error| format!("无法读取 PDF 页面尺寸：{error}"))
    })
    .await
    .map_err(|error| format!("PDF 尺寸读取任务失败：{error}"))?
}

#[tauri::command]
async fn read_mp3_metadata(path: String) -> Result<Option<audio_metadata::AudioMetadata>, String> {
    let path = validated_file_path(&path)?;
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp3"))
    {
        return Err("文件不是 MP3".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        audio_metadata::read(&path).map_err(|error| format!("无法读取 MP3 标签：{error}"))
    })
    .await
    .map_err(|error| format!("MP3 标签读取任务失败：{error}"))?
}

#[tauri::command]
fn allow_preview_asset(path: String, app: AppHandle) -> Result<(), String> {
    let path = validated_file_path(&path)?;
    if !is_stream_path(&path) {
        return Err("这种格式不允许通过资源协议读取".to_string());
    }
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|error| format!("无法授权预览文件：{error}"))
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn read_shell_icon(path: String) -> Result<tauri::ipc::Response, String> {
    let path = PathBuf::from(path);
    if !path.is_file() && !path.is_dir() {
        return Err("文件或文件夹不存在".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        windows_shell_icon::read(&path)
            .map(tauri::ipc::Response::new)
            .map_err(|error| format!("无法读取 Windows 文件图标：{error}"))
    })
    .await
    .map_err(|error| format!("图标读取任务失败：{error}"))?
}

pub(crate) fn hide_preview(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    windows_preview::hide_window(app);
    #[cfg(not(target_os = "windows"))]
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let _ = app.emit_to("main", "preview-hidden", ());
    #[cfg(target_os = "windows")]
    windows_preview::schedule_low_memory(app.clone());
}

pub(crate) fn open_preview_path(app: &AppHandle, path: PathBuf) {
    if !path.is_file() && !path.is_dir() {
        return;
    }

    #[cfg(target_os = "windows")]
    windows_preview::prepare_for_use(app);
    #[cfg(target_os = "windows")]
    windows_preview::set_preview_target(app, &path);
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
    let quit_item = MenuItem::with_id(app, "quit", "退出 QuickPeek", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit_item])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("QuickPeek · 在资源管理器中按空格预览")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "quit" {
                app.exit(0);
            }
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
            let path = find_preview_argument(args.into_iter().skip(1).map(OsString::from));
            if let Some(path) = path {
                open_preview_path(app, path);
            } else {
                diagnostic_log("ignored duplicate launch without a file argument");
            }
        }))
        .setup(|app| {
            setup_tray(app)?;
            #[cfg(target_os = "windows")]
            windows_preview::start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                hide_preview(window.app_handle());
            }
            #[cfg(target_os = "windows")]
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                windows_preview::position_open_button(window.app_handle());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_initial_preview,
            read_preview_file,
            read_pdf_dimensions,
            read_mp3_metadata,
            allow_preview_asset,
            #[cfg(target_os = "windows")]
            read_shell_icon,
            show_preview_window,
            hide_preview_window,
            log_frontend_error
        ])
        .run(tauri::generate_context!())
        .expect("error while running QuickPeek");
}

#[cfg(test)]
mod tests {
    use super::{find_preview_argument, is_supported_path};
    use std::{ffi::OsString, fs::File};

    #[test]
    fn recognizes_native_renderer_formats_case_insensitively() {
        for path in [
            r"C:\docs\Report.DOCX",
            r"C:\sheets\Budget.XLSX",
            r"C:\slides\Pitch.PPTX",
            r"C:\images\Photo.JPEG",
            r"C:\docs\manual.PDF",
            r"C:\sheets\legacy.XLS",
            r"C:\media\clip.MP4",
            r"C:\archives\files.ZIP",
            r"C:\code\main.RS",
            r"C:\notes\readme.TXT",
            r"C:\subtitles\episode.SRT",
        ] {
            assert!(is_supported_path(path.as_ref()));
        }
    }

    #[test]
    fn routes_any_existing_file_to_preview() {
        let path =
            std::env::temp_dir().join(format!("quickpeek-unsupported-{}.rar", std::process::id()));
        File::create(&path).expect("create preview fixture");
        let result =
            find_preview_argument([OsString::from("--ignored"), path.as_os_str().to_owned()]);
        assert_eq!(result, Some(path.clone()));
        std::fs::remove_file(path).expect("remove preview fixture");
    }

    #[test]
    fn routes_existing_directory_to_preview() {
        let path = std::env::temp_dir();
        let result =
            find_preview_argument([OsString::from("--ignored"), path.as_os_str().to_owned()]);
        assert_eq!(result, Some(path));
    }

    #[test]
    fn keeps_unknown_files_out_of_content_readers() {
        for path in [
            r"C:\docs\legacy.doc",
            r"C:\slides\legacy.ppt",
            r"C:\images\camera.raw",
            r"C:\archives\files.rar",
        ] {
            assert!(!is_supported_path(path.as_ref()));
        }
    }
}
