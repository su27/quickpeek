use std::path::Path;

use windows::{
    core::HSTRING,
    Data::Pdf::{PdfDocument, PdfPageRenderOptions},
    Storage::{
        StorageFile,
        Streams::{DataReader, InMemoryRandomAccessStream},
    },
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
};

struct RuntimeApartment;

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

fn open_document(path: &Path) -> Result<PdfDocument, String> {
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
    let file = operation
        .get()
        .map_err(|error| format!("Could not open PDF ({path_text}): {error}"))?;
    PdfDocument::LoadFromFileAsync(&file)
        .and_then(|operation| operation.get())
        .map_err(|error| format!("Windows could not parse PDF: {error}"))
}

pub fn page_sizes(path: &Path) -> Result<Vec<(f64, f64)>, String> {
    let _apartment = RuntimeApartment::initialize()?;
    let document = open_document(path)?;
    let page_count = document
        .PageCount()
        .map_err(|error| format!("Could not read PDF page count: {error}"))?;
    let mut pages = Vec::with_capacity(page_count as usize);
    for index in 0..page_count {
        let page = document
            .GetPage(index)
            .map_err(|error| format!("Could not read PDF page {}: {error}", index + 1))?;
        let size = page.Size().map_err(|error| {
            format!(
                "Could not read dimensions of PDF page {}: {error}",
                index + 1
            )
        })?;
        pages.push((f64::from(size.Width), f64::from(size.Height)));
        let _ = page.Close();
    }
    Ok(pages)
}

pub fn render_page(path: &Path, page_index: u32, target_width: u32) -> Result<Vec<u8>, String> {
    let _apartment = RuntimeApartment::initialize()?;
    let document = open_document(path)?;
    let page_count = document
        .PageCount()
        .map_err(|error| format!("Could not read PDF page count: {error}"))?;
    if page_index >= page_count {
        return Err(format!(
            "PDF page index is out of range: {page_index}/{page_count}"
        ));
    }

    let page = document
        .GetPage(page_index)
        .map_err(|error| format!("Could not read PDF page {}: {error}", page_index + 1))?;
    let size = page
        .Size()
        .map_err(|error| format!("Could not read PDF page dimensions: {error}"))?;
    let width = target_width.clamp(64, 8192);
    let height = ((width as f64 * f64::from(size.Height) / f64::from(size.Width)).round() as u32)
        .clamp(64, 16_384);
    let options = PdfPageRenderOptions::new()
        .map_err(|error| format!("Could not create PDF rendering options: {error}"))?;
    options
        .SetDestinationWidth(width)
        .and_then(|_| options.SetDestinationHeight(height))
        .and_then(|_| options.SetIsIgnoringHighContrast(true))
        .map_err(|error| format!("Could not set PDF rendering options: {error}"))?;

    let stream = InMemoryRandomAccessStream::new()
        .map_err(|error| format!("Could not create PDF image buffer: {error}"))?;
    page.RenderWithOptionsToStreamAsync(&stream, &options)
        .and_then(|action| action.get())
        .map_err(|error| format!("Could not render PDF page {}: {error}", page_index + 1))?;
    let _ = page.Close();

    let length = stream
        .Size()
        .map_err(|error| format!("Could not read PDF image size: {error}"))?;
    let length = u32::try_from(length).map_err(|_| "PDF page image is too large".to_string())?;
    let input = stream
        .GetInputStreamAt(0)
        .map_err(|error| format!("Could not read PDF image buffer: {error}"))?;
    let reader = DataReader::CreateDataReader(&input)
        .map_err(|error| format!("Could not create PDF image reader: {error}"))?;
    let loaded = reader
        .LoadAsync(length)
        .and_then(|operation| operation.get())
        .map_err(|error| format!("Could not load PDF image: {error}"))?;
    if loaded != length {
        return Err(format!("Incomplete PDF image: {loaded}/{length}"));
    }
    let mut bytes = vec![0; length as usize];
    reader
        .ReadBytes(&mut bytes)
        .map_err(|error| format!("Could not copy PDF image: {error}"))?;
    let _ = reader.Close();
    let _ = stream.Close();
    Ok(bytes)
}
