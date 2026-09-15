use serde::Serialize;
use std::{
    ffi::OsString,
    fs::OpenOptions,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU32, Ordering},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

mod archive_directory;
mod audio_metadata;
mod pdf_metadata;
#[cfg(target_os = "windows")]
mod windows_image_renderer;
#[cfg(target_os = "windows")]
mod windows_loading;
#[cfg(target_os = "windows")]
mod windows_memory;
#[cfg(target_os = "windows")]
mod windows_pdf_renderer;
#[cfg(target_os = "windows")]
mod windows_preview;
#[cfg(target_os = "windows")]
mod windows_preview_handler;
#[cfg(target_os = "windows")]
mod windows_rtf;
#[cfg(target_os = "windows")]
mod windows_shell_icon;
#[cfg(target_os = "windows")]
mod windows_startup;

const MAX_TEXT_PREVIEW_BYTES: u64 = 20 * 1024 * 1024;
const BINARY_EXTENSIONS: &[&str] = &[
    "csv", "docm", "docx", "dotm", "dotx", "ods", "potm", "potx", "ppsm", "ppsx", "pptm", "pptx",
    "tsv", "xls", "xlsb", "xlsm", "xlsx", "xltm", "xltx", "zip", "epub",
];

const STREAM_EXTENSIONS: &[&str] = &[
    "aac", "apng", "avif", "bmp", "flac", "gif", "heic", "heif", "ico", "jfif", "jpeg", "jpg",
    "m4a", "m4v", "mov", "mp3", "mp4", "ogg", "ogv", "opus", "pdf", "png", "svg", "wav", "webm",
    "webp", "ttf", "otf", "woff", "woff2", "tif", "tiff",
];

const TEXT_EXTENSIONS: &[&str] = &[
    "adoc",
    "ahk",
    "asm",
    "asciidoc",
    "ass",
    "astro",
    "awk",
    "bash",
    "bat",
    "bib",
    "c",
    "cc",
    "cfg",
    "cjs",
    "clj",
    "cljs",
    "cmake",
    "cmd",
    "coffee",
    "conf",
    "cpp",
    "cs",
    "css",
    "dart",
    "diff",
    "dockerfile",
    "dockerignore",
    "editorconfig",
    "elm",
    "eml",
    "env",
    "erl",
    "ex",
    "exs",
    "fish",
    "fs",
    "fsx",
    "gitattributes",
    "gitignore",
    "gitmodules",
    "go",
    "gql",
    "gradle",
    "graphql",
    "groovy",
    "h",
    "handlebars",
    "hbs",
    "hpp",
    "hrl",
    "hs",
    "htm",
    "html",
    "http",
    "ics",
    "ini",
    "java",
    "jl",
    "js",
    "json",
    "jsonc",
    "jsonl",
    "jsx",
    "kt",
    "kts",
    "less",
    "lhs",
    "lock",
    "log",
    "lrc",
    "lua",
    "m",
    "makefile",
    "manifest",
    "markdown",
    "md",
    "mdx",
    "mjs",
    "mm",
    "nim",
    "njk",
    "npmrc",
    "nu",
    "pas",
    "patch",
    "pem",
    "php",
    "pl",
    "pp",
    "properties",
    "prop",
    "proto",
    "ps1",
    "py",
    "pyw",
    "r",
    "rb",
    "reg",
    "rs",
    "rst",
    "s",
    "scala",
    "scss",
    "sh",
    "sol",
    "sql",
    "srt",
    "ssa",
    "svelte",
    "swift",
    "tex",
    "tf",
    "tfvars",
    "toml",
    "ts",
    "tsx",
    "txt",
    "vb",
    "vbs",
    "vcf",
    "vtt",
    "vue",
    "xml",
    "yaml",
    "yml",
    "zig",
    "zsh",
];

const TEXT_FILENAMES: &[&str] = &[
    "dockerignore",
    "dockerfile",
    "editorconfig",
    "env",
    "gemfile",
    "gitattributes",
    "gitignore",
    "gitmodules",
    "license",
    "makefile",
    "npmrc",
    "procfile",
    "rakefile",
    "readme",
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewRequest {
    generation: u32,
    is_directory: bool,
    modified_at: Option<u64>,
    path: String,
    size: u64,
}

static PREVIEW_GENERATION: AtomicU32 = AtomicU32::new(0);

pub(crate) fn preview_generation_is_current(generation: u32) -> bool {
    PREVIEW_GENERATION.load(Ordering::SeqCst) == generation
}

#[derive(Clone, Serialize)]
struct PreviewDimensions {
    height: f64,
    width: f64,
}

#[derive(Clone, Serialize)]
struct PdfDocumentInfo {
    pages: Vec<PreviewDimensions>,
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
    is_text_path(path)
        || path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                BINARY_EXTENSIONS
                    .iter()
                    .chain(STREAM_EXTENSIONS)
                    .any(|supported| extension.eq_ignore_ascii_case(supported))
            })
}

fn validated_file_path(raw_path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw_path);
    if !path.is_file() {
        return Err("File does not exist or is not a regular file".to_string());
    }
    if !is_supported_path(&path) {
        return Err("This file format is not supported".to_string());
    }
    Ok(path)
}

fn is_text_path(path: &Path) -> bool {
    let known_extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            TEXT_EXTENSIONS
                .iter()
                .any(|text| extension.eq_ignore_ascii_case(text))
        });
    known_extension
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                let normalized = name.trim_start_matches('.').to_ascii_lowercase();
                TEXT_FILENAMES
                    .iter()
                    .any(|text| normalized.eq_ignore_ascii_case(text))
                    || normalized.starts_with("env.")
                    || normalized.starts_with("dockerfile.")
                    || normalized.starts_with("makefile.")
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
        generation: PREVIEW_GENERATION.fetch_add(1, Ordering::SeqCst) + 1,
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
    let preview = preview_request(path)?;
    #[cfg(target_os = "windows")]
    windows_loading::begin(&app, preview.generation, preview_name(&preview.path));
    Some(preview)
}

fn preview_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

#[tauri::command]
async fn read_preview_file(path: String) -> Result<tauri::ipc::Response, String> {
    let path = validated_file_path(&path)?;
    if is_stream_path(&path) {
        return Err("This format requires a streaming file URL".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let file = std::fs::File::open(&path)
            .map_err(|error| format!("Could not read {}: {error}", path.to_string_lossy()))?;
        let is_epub = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("epub"));
        const MAX_EPUB_BYTES: u64 = 64 * 1024 * 1024;
        if is_epub && file.metadata().map_err(|e| e.to_string())?.len() > MAX_EPUB_BYTES {
            return Err("EPUB exceeds the 64 MB preview limit".into());
        }
        let limit = if is_text_path(&path) {
            MAX_TEXT_PREVIEW_BYTES
        } else if is_epub {
            MAX_EPUB_BYTES + 1
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
            .map_err(|error| format!("Could not read {}: {error}", path.to_string_lossy()))?;
        if is_epub && bytes.len() as u64 > MAX_EPUB_BYTES {
            return Err("EPUB exceeds the preview limit".into());
        }
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|error| format!("Read operation failed: {error}"))?
}

#[tauri::command]
async fn read_pdf_dimensions(path: String) -> Result<Option<PreviewDimensions>, String> {
    let path = validated_file_path(&path)?;
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return Err("File is not a PDF".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        pdf_metadata::read_dimensions(&path)
            .map(|dimensions| dimensions.map(|(width, height)| PreviewDimensions { width, height }))
            .map_err(|error| format!("Could not read PDF page dimensions: {error}"))
    })
    .await
    .map_err(|error| format!("Could not read PDF dimensions: {error}"))?
}

#[tauri::command]
async fn read_pdf_info(path: String) -> Result<PdfDocumentInfo, String> {
    let path = validated_file_path(&path)?;
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return Err("File is not a PDF".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            windows_pdf_renderer::page_sizes(&path).map(|pages| PdfDocumentInfo {
                pages: pages
                    .into_iter()
                    .map(|(width, height)| PreviewDimensions { width, height })
                    .collect(),
            })
        })
        .await
        .map_err(|error| format!("Could not read PDF information: {error}"))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("PDF preview is not supported on this system".to_string())
    }
}

#[tauri::command]
async fn render_pdf_page(
    path: String,
    page_index: u32,
    target_width: u32,
) -> Result<tauri::ipc::Response, String> {
    let path = validated_file_path(&path)?;
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return Err("File is not a PDF".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            windows_pdf_renderer::render_page(&path, page_index, target_width)
                .map(tauri::ipc::Response::new)
        })
        .await
        .map_err(|error| format!("PDF page rendering failed: {error}"))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (path, page_index, target_width);
        Err("PDF preview is not supported on this system".to_string())
    }
}

#[tauri::command]
async fn decode_system_image(
    path: String,
    max_dimension: u32,
) -> Result<tauri::ipc::Response, String> {
    let path = validated_file_path(&path)?;
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("heic") || extension.eq_ignore_ascii_case("heif")
        })
    {
        return Err("File is not a HEIC/HEIF image".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        let generation = PREVIEW_GENERATION.load(Ordering::SeqCst);
        tauri::async_runtime::spawn_blocking(move || {
            windows_image_renderer::decode_photo_preview(&path, max_dimension, || {
                preview_generation_is_current(generation)
            })
            .map(tauri::ipc::Response::new)
        })
        .await
        .map_err(|error| format!("HEIC decoding failed: {error}"))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (path, max_dimension);
        Err("HEIC preview is not supported on this system".to_string())
    }
}

#[tauri::command]
async fn read_mp3_metadata(path: String) -> Result<Option<audio_metadata::AudioMetadata>, String> {
    let path = validated_file_path(&path)?;
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp3"))
    {
        return Err("File is not an MP3".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        audio_metadata::read(&path).map_err(|error| format!("Could not read MP3 tags：{error}"))
    })
    .await
    .map_err(|error| format!("Could not read MP3 tags: {error}"))?
}

#[tauri::command]
async fn read_archive_directory(
    path: String,
    generation: u32,
) -> Result<archive_directory::Directory, String> {
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || archive_directory::read(&path, generation))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(windows)]
fn tiff_path(path: &str) -> Result<PathBuf, String> {
    let path = validated_file_path(path)?;
    let extension = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    if !["tif", "tiff"].contains(&extension.as_str()) {
        return Err("File is not a TIFF image".into());
    }
    Ok(path)
}

#[cfg(windows)]
#[tauri::command]
async fn read_tiff_info(
    path: String,
    generation: u32,
) -> Result<windows_image_renderer::ImageInfo, String> {
    let path = tiff_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _decode = TIFF_WORK.lock().map_err(|_| "Image decoder unavailable")?;
        if !preview_generation_is_current(generation) {
            return Err("Preview cancelled".into());
        }
        windows_image_renderer::image_info(&path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(windows)]
static TIFF_WORK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(windows)]
#[tauri::command]
async fn render_tiff_page(
    path: String,
    page_index: u32,
    generation: u32,
) -> Result<tauri::ipc::Response, String> {
    let path = tiff_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _decode = TIFF_WORK.lock().map_err(|_| "Image decoder unavailable")?;
        if !preview_generation_is_current(generation) {
            return Err("Preview cancelled".to_string());
        }
        let bytes = windows_image_renderer::decode_frame(&path, 4096, page_index)?;
        if !preview_generation_is_current(generation) {
            return Err("Preview cancelled".to_string());
        }
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn allow_preview_asset(path: String, app: AppHandle) -> Result<(), String> {
    let path = validated_file_path(&path)?;
    if !is_stream_path(&path) {
        return Err("This format cannot be read through the asset protocol".to_string());
    }
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|error| format!("Could not grant access to the preview file: {error}"))
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn read_shell_icon(path: String) -> Result<tauri::ipc::Response, String> {
    let path = PathBuf::from(path);
    if !path.is_file() && !path.is_dir() {
        return Err("File or folder does not exist".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        windows_shell_icon::read(&path)
            .map(tauri::ipc::Response::new)
            .map_err(|error| format!("Could not read the Windows file icon: {error}"))
    })
    .await
    .map_err(|error| format!("Could not read file icon: {error}"))?
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn prepare_system_preview(path: String, generation: u32) -> Result<bool, String> {
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err("File does not exist or is not a regular file".to_string());
    }
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["doc", "ppt", "pps", "pot", "rtf"].contains(&extension.to_ascii_lowercase().as_str())
        })
    {
        return Err("This file type is not supported by system preview".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || windows_preview_handler::prepare(path, generation))
        .await
        .map_err(|error| format!("Could not prepare system preview: {error}"))?
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn activate_system_preview(generation: u32) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || windows_preview_handler::activate(generation))
        .await
        .map_err(|error| format!("Could not activate system preview: {error}"))?
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn unload_system_preview(generation: u32) -> Result<(), String> {
    windows_preview_handler::unload(Some(generation))
}

pub(crate) fn hide_preview(app: &AppHandle) {
    let generation = PREVIEW_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    #[cfg(target_os = "windows")]
    windows_memory::begin_cleanup();
    #[cfg(target_os = "windows")]
    windows_loading::cancel(app);
    #[cfg(target_os = "windows")]
    windows_preview::hide_window(app);
    #[cfg(not(target_os = "windows"))]
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let _ = app.emit_to("main", "preview-hidden", generation);
}

#[tauri::command]
fn preview_cleanup_complete(app: AppHandle, generation: u32) {
    #[cfg(target_os = "windows")]
    windows_memory::suspend_after_cleanup(&app, generation);
}

#[tauri::command]
fn prepare_preview_engine(app: AppHandle) {
    #[cfg(target_os = "windows")]
    windows_preview::prepare_for_use(&app);
}

pub(crate) fn open_preview_path(app: &AppHandle, path: PathBuf) {
    if !path.is_file() && !path.is_dir() {
        return;
    }

    #[cfg(target_os = "windows")]
    windows_preview::prepare_for_use(app);
    if let Some(preview) = preview_request(path) {
        #[cfg(target_os = "windows")]
        windows_loading::begin(app, preview.generation, preview_name(&preview.path));
        #[cfg(target_os = "windows")]
        windows_preview::set_preview_target(app, Path::new(&preview.path));
        let _ = app.emit_to("main", "preview-file", preview);
    }
}

#[tauri::command]
fn show_preview_window(
    app: AppHandle,
    generation: Option<u32>,
    title: Option<String>,
    native_preview: Option<bool>,
) {
    if generation.is_some_and(|generation| !preview_generation_is_current(generation)) {
        return;
    }
    #[cfg(target_os = "windows")]
    {
        let ui_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            if generation.is_some_and(|g| !preview_generation_is_current(g)) {
                return;
            }
            if let (Some(window), Some(title)) = (ui_app.get_webview_window("main"), title) {
                let _ = window.set_title(&title);
            }
            // The engine was resumed before dispatching this preview. Resuming
            // again here queues WebView visibility work after native activation,
            // which can cover the ready Rich Edit / system preview child.
            windows_preview::show_without_activation(&ui_app);
            windows_memory::present(&ui_app, generation, native_preview.unwrap_or(false));
            if let Some(generation) = generation {
                windows_loading::finish(generation);
            }
        });
    }
    #[cfg(not(target_os = "windows"))]
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
    }
}

#[tauri::command]
fn hide_preview_window(app: AppHandle, generation: Option<u32>) {
    if generation.is_some_and(|g| !preview_generation_is_current(g)) {
        return;
    }
    hide_preview(&app);
}

#[tauri::command]
fn log_frontend_error(message: String) {
    diagnostic_log(&format!("frontend: {message}"));
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let quit_item = MenuItem::with_id(app, "quit", "Quit QuickPeek", true, None::<&str>)?;
    #[cfg(target_os = "windows")]
    let startup_item = tauri::menu::CheckMenuItem::with_id(
        app,
        "startup",
        "Run at startup",
        true,
        windows_startup::enabled().unwrap_or(false),
        None::<&str>,
    )?;
    #[cfg(target_os = "windows")]
    let menu = Menu::with_items(app, &[&startup_item, &quit_item])?;
    #[cfg(not(target_os = "windows"))]
    let menu = Menu::with_items(app, &[&quit_item])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("QuickPeek · Press Space in File Explorer to preview")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            #[cfg(target_os = "windows")]
            if event.id().as_ref() == "startup" {
                let result = windows_startup::enabled()
                    .and_then(|enabled| windows_startup::set_enabled(!enabled));
                if let Err(error) = result {
                    diagnostic_log(&format!("Could not change startup setting: {error}"));
                }
                let _ = startup_item.set_checked(windows_startup::enabled().unwrap_or(false));
            }
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
            tauri::WindowEvent::Moved(_) => {
                windows_preview::position_open_button(window.app_handle());
                windows_loading::reposition(window.app_handle());
            }
            #[cfg(target_os = "windows")]
            tauri::WindowEvent::Resized(_) => {
                windows_preview::position_open_button(window.app_handle());
                windows_preview_handler::resize();
                windows_loading::reposition(window.app_handle());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            get_initial_preview,
            read_preview_file,
            read_pdf_dimensions,
            read_pdf_info,
            render_pdf_page,
            decode_system_image,
            read_tiff_info,
            render_tiff_page,
            read_archive_directory,
            read_mp3_metadata,
            allow_preview_asset,
            #[cfg(target_os = "windows")]
            read_shell_icon,
            #[cfg(target_os = "windows")]
            prepare_system_preview,
            #[cfg(target_os = "windows")]
            activate_system_preview,
            #[cfg(target_os = "windows")]
            unload_system_preview,
            show_preview_window,
            hide_preview_window,
            preview_cleanup_complete,
            prepare_preview_engine,
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
            r"C:\books\novel.EPUB",
            r"C:\code\main.RS",
            r"C:\notes\readme.TXT",
            r"C:\subtitles\episode.SRT",
            r"C:\subtitles\episode.VTT",
            r"C:\images\photo.HEIC",
            r"C:\project\Dockerfile",
            r"C:\project\.gitignore",
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
