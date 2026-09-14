use std::path::Path;

use windows::{
    core::HSTRING,
    Foundation::{PropertyType, PropertyValue},
    Graphics::Imaging::{
        BitmapAlphaMode, BitmapDecoder, BitmapEncoder, BitmapPixelFormat, BitmapPropertySet,
        BitmapTransform, BitmapTypedValue, ColorManagementMode, ExifOrientationMode,
    },
    Storage::{
        FileAccessMode, StorageFile,
        Streams::{DataReader, InMemoryRandomAccessStream},
    },
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
};

struct RuntimeApartment;
struct CloseOnDrop<F: FnMut()>(F);
impl<F: FnMut()> Drop for CloseOnDrop<F> {
    fn drop(&mut self) {
        (self.0)();
    }
}

impl RuntimeApartment {
    fn initialize() -> Result<Self, String> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }
            .map_err(|error| format!("无法初始化 Windows 图像运行时：{error}"))?;
        Ok(Self)
    }
}

impl Drop for RuntimeApartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

fn canonical_path_text(path: &Path) -> Result<String, String> {
    let absolute_path = path
        .canonicalize()
        .map_err(|error| format!("无法解析图像路径：{error}"))?;
    let canonical_text = absolute_path.as_os_str().to_string_lossy();
    Ok(canonical_text
        .strip_prefix(r"\\?\UNC\")
        .map(|path| format!(r"\\{path}"))
        .unwrap_or_else(|| {
            canonical_text
                .strip_prefix(r"\\?\")
                .unwrap_or(&canonical_text)
                .to_string()
        }))
}

fn read_stream(stream: &InMemoryRandomAccessStream) -> Result<Vec<u8>, String> {
    let length = stream
        .Size()
        .map_err(|error| format!("无法读取转换后图像大小：{error}"))?;
    let length = u32::try_from(length).map_err(|_| "转换后图像过大".to_string())?;
    let input = stream
        .GetInputStreamAt(0)
        .map_err(|error| format!("无法读取转换后图像缓冲区：{error}"))?;
    let reader = DataReader::CreateDataReader(&input)
        .map_err(|error| format!("无法创建图像缓冲区读取器：{error}"))?;
    let loaded = reader
        .LoadAsync(length)
        .and_then(|operation| operation.get())
        .map_err(|error| format!("无法载入转换后图像：{error}"))?;
    if loaded != length {
        return Err(format!("转换后图像读取不完整：{loaded}/{length}"));
    }
    let mut bytes = vec![0; length as usize];
    reader
        .ReadBytes(&mut bytes)
        .map_err(|error| format!("无法复制转换后图像：{error}"))?;
    let _ = reader.Close();
    Ok(bytes)
}

pub fn decode_photo_preview(
    path: &Path,
    max_dimension: u32,
    current: impl Fn() -> bool,
) -> Result<Vec<u8>, String> {
    // Only one native photo decoder owns a pixel buffer at a time. Superseded
    // requests exit before decoding/encoding instead of accumulating images.
    static WORK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _work = WORK.lock().map_err(|_| "图像解码器不可用")?;
    decode_frame_with_options(path, max_dimension.min(4096), 0, true, current)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub width: u32,
    pub height: u32,
    pub page_count: u32,
}

pub fn image_info(path: &Path) -> Result<ImageInfo, String> {
    let _apartment = RuntimeApartment::initialize()?;
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(canonical_path_text(path)?))
        .and_then(|op| op.get())
        .map_err(|e| e.to_string())?;
    let input = file
        .OpenAsync(FileAccessMode::Read)
        .and_then(|op| op.get())
        .map_err(|e| e.to_string())?;
    let result = (|| {
        let decoder = BitmapDecoder::CreateAsync(&input)
            .and_then(|op| op.get())
            .map_err(|e| e.to_string())?;
        Ok(ImageInfo {
            width: decoder.OrientedPixelWidth().map_err(|e| e.to_string())?,
            height: decoder.OrientedPixelHeight().map_err(|e| e.to_string())?,
            page_count: decoder.FrameCount().map_err(|e| e.to_string())?,
        })
    })();
    let _ = input.Close();
    result
}

pub fn decode_frame(path: &Path, max_dimension: u32, page_index: u32) -> Result<Vec<u8>, String> {
    decode_frame_with_options(path, max_dimension, page_index, false, || true)
}

fn decode_frame_with_options(
    path: &Path,
    max_dimension: u32,
    page_index: u32,
    photo: bool,
    current: impl Fn() -> bool,
) -> Result<Vec<u8>, String> {
    let check_current = || {
        if current() {
            Ok(())
        } else {
            Err("预览已取消".to_string())
        }
    };
    check_current()?;
    let _apartment = RuntimeApartment::initialize()?;
    let path_text = canonical_path_text(path)?;
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path_text.as_str()))
        .and_then(|operation| operation.get())
        .map_err(|error| format!("无法打开图像文件 ({path_text})：{error}"))?;
    let input = file
        .OpenAsync(FileAccessMode::Read)
        .and_then(|operation| operation.get())
        .map_err(|error| format!("无法读取图像文件：{error}"))?;
    let _input_close = CloseOnDrop(|| {
        let _ = input.Close();
    });
    let decoder = BitmapDecoder::CreateAsync(&input)
        .and_then(|operation| operation.get())
        .map_err(|error| format!("Windows 无法解码此图像：{error}"))?;
    if page_index >= decoder.FrameCount().map_err(|e| e.to_string())? {
        return Err("图像页码超出范围".into());
    }
    let decoder = decoder
        .GetFrameAsync(page_index)
        .and_then(|op| op.get())
        .map_err(|e| e.to_string())?;

    let width = decoder
        .OrientedPixelWidth()
        .map_err(|error| format!("无法读取图像宽度：{error}"))?;
    let height = decoder
        .OrientedPixelHeight()
        .map_err(|error| format!("无法读取图像高度：{error}"))?;
    if width == 0 || height == 0 {
        return Err("图像尺寸无效".to_string());
    }

    // Panoramas/long images are viewed by scrolling, not by fitting their entire
    // long axis on screen. Keep their existing 4K detail budget in that case.
    let limit = if photo && width.max(height) as u64 > width.min(height) as u64 * 4 {
        4096
    } else {
        max_dimension.clamp(512, 8192)
    };
    let scale = (limit as f64 / width.max(height) as f64).min(1.0);
    // WinRT scales BEFORE applying EXIF rotation. Use raw dimensions here,
    // otherwise rotated portraits can be stretched into landscape coordinates.
    let output_width =
        ((decoder.PixelWidth().map_err(|e| e.to_string())? as f64 * scale).round() as u32).max(1);
    let output_height =
        ((decoder.PixelHeight().map_err(|e| e.to_string())? as f64 * scale).round() as u32).max(1);
    // Never discard actual or potentially meaningful alpha to speed up a photo.
    let jpeg =
        photo && decoder.BitmapAlphaMode().map_err(|e| e.to_string())? == BitmapAlphaMode::Ignore;
    let transform =
        BitmapTransform::new().map_err(|error| format!("无法创建图像缩放参数：{error}"))?;
    transform
        .SetScaledWidth(output_width)
        .and_then(|_| transform.SetScaledHeight(output_height))
        .map_err(|error| format!("无法设置图像缩放参数：{error}"))?;
    check_current()?;
    let bitmap = decoder
        .GetSoftwareBitmapTransformedAsync(
            BitmapPixelFormat::Bgra8,
            if jpeg {
                BitmapAlphaMode::Ignore
            } else {
                BitmapAlphaMode::Premultiplied
            },
            &transform,
            ExifOrientationMode::RespectExifOrientation,
            ColorManagementMode::ColorManageToSRgb,
        )
        .and_then(|operation| operation.get())
        .map_err(|error| format!("无法转换图像像素：{error}"))?;
    let _bitmap_close = CloseOnDrop(|| {
        let _ = bitmap.Close();
    });
    check_current()?;

    let output = InMemoryRandomAccessStream::new()
        .map_err(|error| format!("无法创建图像输出缓冲区：{error}"))?;
    let _output_close = CloseOnDrop(|| {
        let _ = output.Close();
    });
    let encoder = if jpeg {
        let options = BitmapPropertySet::new().map_err(|e| e.to_string())?;
        let quality = PropertyValue::CreateSingle(0.92).map_err(|e| e.to_string())?;
        options
            .Insert(
                &HSTRING::from("ImageQuality"),
                &BitmapTypedValue::Create(&quality, PropertyType::Single)
                    .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        BitmapEncoder::CreateWithEncodingOptionsAsync(
            BitmapEncoder::JpegEncoderId().map_err(|e| e.to_string())?,
            &output,
            &options,
        )
    } else {
        BitmapEncoder::CreateAsync(
            BitmapEncoder::PngEncoderId().map_err(|e| e.to_string())?,
            &output,
        )
    }
    .and_then(|operation| operation.get())
    .map_err(|error| format!("无法创建图像编码器：{error}"))?;
    encoder
        .SetSoftwareBitmap(&bitmap)
        .and_then(|_| encoder.FlushAsync())
        .and_then(|operation| operation.get())
        .map_err(|error| format!("无法编码预览图：{error}"))?;
    check_current()?;
    let bytes = read_stream(&output)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    // Two tiny uncompressed grayscale TIFF pages, generated rather than vendored.
    fn fixture() -> Vec<u8> {
        fixture_with_orientation(1)
    }
    fn fixture_with_orientation(orientation: u32) -> Vec<u8> {
        let mut bytes = b"II\x2a\x00\x08\x00\x00\x00".to_vec();
        let ifd_size = 2 + 10 * 12 + 4;
        let data_start = 8 + 2 * ifd_size;
        for page in 0..2u32 {
            bytes.extend(10u16.to_le_bytes());
            for (tag, kind, value) in [
                (256u16, 4u16, 2u32),
                (257, 4, 1),
                (258, 3, 8),
                (259, 3, 1),
                (262, 3, 1),
                (273, 4, data_start + page * 2),
                (274, 3, orientation),
                (277, 3, 1),
                (278, 4, 1),
                (279, 4, 2),
            ] {
                bytes.extend(tag.to_le_bytes());
                bytes.extend(kind.to_le_bytes());
                bytes.extend(1u32.to_le_bytes());
                bytes.extend(value.to_le_bytes());
            }
            bytes.extend(if page == 0 { 8 + ifd_size } else { 0 }.to_le_bytes());
        }
        bytes.extend([0, 255, 128, 64]);
        bytes
    }
    #[test]
    fn native_photo_orientation_alpha_and_cancellation() {
        let path =
            std::env::temp_dir().join(format!("quickpeek-photo-test-{}.tiff", std::process::id()));
        let result_path = path.with_extension("png");
        std::fs::write(&path, fixture_with_orientation(6)).unwrap();
        let result = decode_photo_preview(&path, 512, || true).unwrap();
        assert!(result.starts_with(b"\xff\xd8"));
        std::fs::write(&result_path, result).unwrap();
        let info = image_info(&result_path).unwrap();
        assert_eq!(
            (info.width, info.height),
            (1, 2),
            "EXIF rotation was applied in the wrong coordinate space"
        );
        assert!(decode_photo_preview(&path, 512, || false).is_err());
        // Generate a transparent PNG in memory, then run it through the same
        // photo policy; loss of alpha must never silently turn it into JPEG.
        {
            let _apartment = RuntimeApartment::initialize().unwrap();
            let output = InMemoryRandomAccessStream::new().unwrap();
            let encoder =
                BitmapEncoder::CreateAsync(BitmapEncoder::PngEncoderId().unwrap(), &output)
                    .unwrap()
                    .get()
                    .unwrap();
            encoder
                .SetPixelData(
                    BitmapPixelFormat::Bgra8,
                    BitmapAlphaMode::Straight,
                    2,
                    1,
                    96.0,
                    96.0,
                    &[0, 0, 0, 0, 0, 0, 255, 255],
                )
                .unwrap();
            encoder.FlushAsync().unwrap().get().unwrap();
            std::fs::write(&result_path, read_stream(&output).unwrap()).unwrap();
            output.Close().unwrap();
        }
        let transparent = decode_photo_preview(&result_path, 512, || true).unwrap();
        assert!(transparent.starts_with(b"\x89PNG"));
        std::fs::remove_file(path).unwrap();
        std::fs::remove_file(result_path).unwrap();
    }
    #[test]
    fn optional_heic_preview_benchmark() {
        let Some(path) = std::env::var_os("QUICKPEEK_HEIC_FIXTURE") else {
            return;
        };
        let path = Path::new(&path);
        let info = image_info(path).unwrap();
        let old_start = std::time::Instant::now();
        let png = decode_frame(path, 4096, 0).unwrap();
        let old_time = old_start.elapsed();
        let png_len = png.len();
        drop(png);
        for limit in [2880, 1920] {
            let start = std::time::Instant::now();
            let result = decode_photo_preview(path, limit, || true).unwrap();
            let time = start.elapsed();
            assert!(
                result.starts_with(b"\xff\xd8"),
                "opaque HEIC did not use JPEG"
            );
            let result_path = std::env::temp_dir()
                .join(format!("quickpeek-heic-test-{}.jpg", std::process::id()));
            std::fs::write(&result_path, &result).unwrap();
            let decoded = image_info(&result_path).unwrap();
            std::fs::remove_file(result_path).unwrap();
            let scale = (limit as f64 / info.width.max(info.height) as f64).min(1.0);
            assert_eq!(
                (decoded.width, decoded.height),
                (
                    (info.width as f64 * scale).round() as u32,
                    (info.height as f64 * scale).round() as u32
                )
            );
            eprintln!(
                "HEIC PNG-4096={}ms/{}bytes; JPEG92-{}={}ms/{}bytes, {}x{}",
                old_time.as_millis(),
                png_len,
                limit,
                time.as_millis(),
                result.len(),
                decoded.width,
                decoded.height
            );
        }
    }
    #[test]
    fn native_tiff_metadata_and_independent_pages() {
        let path =
            std::env::temp_dir().join(format!("quickpeek-tiff-test-{}.tiff", std::process::id()));
        std::fs::write(&path, fixture()).unwrap();
        let info = image_info(&path).unwrap();
        assert_eq!((info.width, info.height, info.page_count), (2, 1, 2));
        let first = decode_frame(&path, 512, 0).unwrap();
        let second = decode_frame(&path, 512, 1).unwrap();
        assert!(first.starts_with(b"\x89PNG"));
        assert_ne!(first, second);
        assert!(decode_frame(&path, 512, 2).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
