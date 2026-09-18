use std::{
    path::{Path, PathBuf},
    sync::mpsc,
    sync::Mutex,
    time::{Duration, Instant},
};
use windows_future::{
    AsyncActionCompletedHandler, AsyncOperationCompletedHandler, IAsyncAction, IAsyncOperation,
};

fn wait_completion(
    receiver: mpsc::Receiver<()>,
    generation: Option<u32>,
    cancel: impl FnOnce(),
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        if check_current(generation).is_err() || Instant::now() >= deadline {
            cancel();
            return Err("PDF operation cancelled or timed out".into());
        }
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(()) => return check_current(generation),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => return Err("PDF operation ended without a result".into()),
        }
    }
}

fn wait_operation<T: windows::core::RuntimeType + 'static>(
    operation: IAsyncOperation<T>,
    generation: Option<u32>,
) -> Result<T, String> {
    let (sender, receiver) = mpsc::channel();
    operation
        .SetCompleted(&AsyncOperationCompletedHandler::new(move |_, _| {
            let _ = sender.send(());
            Ok(())
        }))
        .map_err(|e| e.to_string())?;
    wait_completion(receiver, generation, || {
        let _ = operation.Cancel();
    })?;
    operation.GetResults().map_err(|e| e.to_string())
}

fn wait_action(action: IAsyncAction, generation: Option<u32>) -> Result<(), String> {
    let (sender, receiver) = mpsc::channel();
    action
        .SetCompleted(&AsyncActionCompletedHandler::new(move |_, _| {
            let _ = sender.send(());
            Ok(())
        }))
        .map_err(|e| e.to_string())?;
    wait_completion(receiver, generation, || {
        let _ = action.Cancel();
    })?;
    action.GetResults().map_err(|e| e.to_string())
}

use windows::{
    core::{Interface, HSTRING},
    Data::Pdf::{PdfDocument, PdfPageRenderOptions},
    Storage::{
        StorageFile,
        Streams::{DataReader, InMemoryRandomAccessStream},
    },
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
};

struct RuntimeApartment;

struct CloseOnDrop<T: Interface>(T);
impl<T: Interface> std::ops::Deref for CloseOnDrop<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}
impl<T: Interface> Drop for CloseOnDrop<T> {
    fn drop(&mut self) {
        if let Ok(resource) = self.0.cast::<windows::Foundation::IClosable>() {
            let _ = resource.Close();
        }
    }
}

// One bounded native rendering lane and one parsed document per preview.
// Holding this lock also bounds transient page buffers across old/new viewers.
static DOCUMENT: Mutex<Option<(PathBuf, Option<u32>, PdfDocument)>> = Mutex::new(None);

fn check_current(generation: Option<u32>) -> Result<(), String> {
    if generation.is_some_and(|g| !crate::preview_generation_is_current(g)) {
        Err("PDF preview cancelled".into())
    } else {
        Ok(())
    }
}

fn with_document<T>(
    path: &Path,
    generation: Option<u32>,
    action: impl FnOnce(&PdfDocument) -> Result<T, String>,
) -> Result<T, String> {
    check_current(generation)?;
    let _apartment = RuntimeApartment::initialize()?;
    let mut cached = DOCUMENT
        .lock()
        .map_err(|_| "PDF renderer is unavailable".to_string())?;
    check_current(generation)?;
    if cached
        .as_ref()
        .is_none_or(|(p, g, _)| p != path || *g != generation)
    {
        *cached = None;
        *cached = Some((
            path.to_path_buf(),
            generation,
            open_document(path, generation)?,
        ));
    }
    let result = action(&cached.as_ref().unwrap().2);
    if check_current(generation).is_err() {
        *cached = None;
        return Err("PDF preview cancelled".into());
    }
    if result.is_err() {
        *cached = None;
    }
    result
}

pub fn release_idle() {
    if let Ok(mut cached) = DOCUMENT.try_lock() {
        *cached = None;
    }
}

impl RuntimeApartment {
    fn initialize() -> Result<Self, String> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
            .map_err(|error| format!("Could not initialize Windows PDF support: {error}"))?;
        Ok(Self)
    }
}

impl Drop for RuntimeApartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

fn open_document(path: &Path, generation: Option<u32>) -> Result<PdfDocument, String> {
    let absolute_path = path
        .canonicalize()
        .map_err(|error| format!("Could not resolve PDF path: {error}"))?;
    let canonical_text = absolute_path.as_os_str().to_string_lossy();
    let path_text = canonical_text
        .strip_prefix(r"\\?\UNC\")
        .map(|path| format!(r"\\{path}"))
        .unwrap_or_else(|| {
            canonical_text
                .strip_prefix(r"\\?\")
                .unwrap_or(&canonical_text)
                .to_string()
        });
    let path = HSTRING::from(path_text.as_str());
    let operation = StorageFile::GetFileFromPathAsync(&path)
        .map_err(|error| format!("Could not start opening PDF ({path_text}): {error}"))?;
    let file = wait_operation(operation, generation)
        .map_err(|error| format!("Could not open PDF ({path_text}): {error}"))?;
    wait_operation(
        PdfDocument::LoadFromFileAsync(&file).map_err(|e| e.to_string())?,
        generation,
    )
    .map_err(|error| format!("Windows could not parse PDF: {error}"))
}

pub fn page_sizes(path: &Path, generation: Option<u32>) -> Result<Vec<(f64, f64)>, String> {
    with_document(path, generation, |document| {
        let page_count = document
            .PageCount()
            .map_err(|error| format!("Could not read PDF page count: {error}"))?;
        if page_count > 10000 {
            return Err("PDF has too many pages to preview".into());
        }
        let mut pages = Vec::with_capacity(page_count as usize);
        for index in 0..page_count {
            check_current(generation)?;
            let page = CloseOnDrop(
                document
                    .GetPage(index)
                    .map_err(|error| format!("Could not read PDF page {}: {error}", index + 1))?,
            );
            let size = page.Size().map_err(|error| {
                format!(
                    "Could not read dimensions of PDF page {}: {error}",
                    index + 1
                )
            })?;
            pages.push((f64::from(size.Width), f64::from(size.Height)));
        }
        Ok(pages)
    })
}

pub fn render_page(
    path: &Path,
    page_index: u32,
    target_width: u32,
    generation: Option<u32>,
) -> Result<Vec<u8>, String> {
    with_document(path, generation, |document| {
        let page_count = document
            .PageCount()
            .map_err(|error| format!("Could not read PDF page count: {error}"))?;
        if page_index >= page_count {
            return Err(format!(
                "PDF page index is out of range: {page_index}/{page_count}"
            ));
        }

        let page = CloseOnDrop(
            document
                .GetPage(page_index)
                .map_err(|error| format!("Could not read PDF page {}: {error}", page_index + 1))?,
        );
        let size = page
            .Size()
            .map_err(|error| format!("Could not read PDF page dimensions: {error}"))?;
        let (width, height) =
            raster_size(f64::from(size.Width), f64::from(size.Height), target_width)?;
        let options = PdfPageRenderOptions::new()
            .map_err(|error| format!("Could not create PDF rendering options: {error}"))?;
        options
            .SetDestinationWidth(width)
            .and_then(|_| options.SetDestinationHeight(height))
            .and_then(|_| options.SetIsIgnoringHighContrast(true))
            .map_err(|error| format!("Could not set PDF rendering options: {error}"))?;

        let stream = CloseOnDrop(
            InMemoryRandomAccessStream::new()
                .map_err(|error| format!("Could not create PDF image buffer: {error}"))?,
        );
        wait_action(
            page.RenderWithOptionsToStreamAsync(&*stream, &options)
                .map_err(|e| e.to_string())?,
            generation,
        )
        .map_err(|error| format!("Could not render PDF page {}: {error}", page_index + 1))?;
        drop(page);

        let length = stream
            .Size()
            .map_err(|error| format!("Could not read PDF image size: {error}"))?;
        let length =
            u32::try_from(length).map_err(|_| "PDF page image is too large".to_string())?;
        if length > 32 * 1024 * 1024 {
            return Err("PDF page image exceeds preview limit".into());
        }
        check_current(generation)?;
        let input = stream
            .GetInputStreamAt(0)
            .map_err(|error| format!("Could not read PDF image buffer: {error}"))?;
        let reader = CloseOnDrop(
            DataReader::CreateDataReader(&input)
                .map_err(|error| format!("Could not create PDF image reader: {error}"))?,
        );
        let loaded = wait_operation(
            reader.LoadAsync(length).map_err(|e| e.to_string())?,
            generation,
        )
        .map_err(|error| format!("Could not load PDF image: {error}"))?;
        if loaded != length {
            return Err(format!("Incomplete PDF image: {loaded}/{length}"));
        }
        let mut bytes = vec![0; length as usize];
        reader
            .ReadBytes(&mut bytes)
            .map_err(|error| format!("Could not copy PDF image: {error}"))?;
        Ok(bytes)
    })
}

fn raster_size(width: f64, height: f64, requested: u32) -> Result<(u32, u32), String> {
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err("Invalid PDF page dimensions".into());
    }
    let desired_width = f64::from(requested.clamp(64, 4096));
    let desired_height = desired_width * height / width;
    let scale = (4_000_000.0 / (desired_width * desired_height))
        .sqrt()
        .min(1.0)
        .min(8192.0 / desired_height);
    Ok((
        (desired_width * scale).floor().max(1.0) as u32,
        (desired_height * scale).floor().max(1.0) as u32,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires QUICKPEEK_PDF_FIXTURE"]
    fn pdf_session_reuses_document_and_releases_it() {
        let path =
            PathBuf::from(std::env::var_os("QUICKPEEK_PDF_FIXTURE").expect("set PDF fixture"));
        let sizes = page_sizes(&path, None).unwrap();
        assert!(!sizes.is_empty());
        let image = render_page(&path, 0, 1200, None).unwrap();
        assert_eq!(&image[..8], b"\x89PNG\r\n\x1a\n");
        assert!(DOCUMENT.lock().unwrap().is_some());
        assert_eq!(page_sizes(&path, None).unwrap(), sizes);
        release_idle();
        assert!(DOCUMENT.lock().unwrap().is_none());
    }
    #[test]
    fn raster_budget_preserves_ratio_and_bounds_memory() {
        for (w, h) in [(600.0, 800.0), (100.0, 100000.0), (100000.0, 100.0)] {
            let (x, y) = raster_size(w, h, 8192).unwrap();
            assert!(u64::from(x) * u64::from(y) <= 4_000_000);
            assert!(x > 0 && y > 0 && y <= 8192);
        }
        assert!(raster_size(0.0, 100.0, 200).is_err());
    }
}
