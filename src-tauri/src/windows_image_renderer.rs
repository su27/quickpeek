use std::path::Path;

use windows::{
    core::HSTRING,
    Graphics::Imaging::{
        BitmapAlphaMode, BitmapDecoder, BitmapEncoder, BitmapPixelFormat, BitmapTransform,
        ColorManagementMode, ExifOrientationMode,
    },
    Storage::{
        FileAccessMode, StorageFile,
        Streams::{DataReader, InMemoryRandomAccessStream},
    },
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
};

struct RuntimeApartment;

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

pub fn decode_to_png(path: &Path, max_dimension: u32) -> Result<Vec<u8>, String> {
    let _apartment = RuntimeApartment::initialize()?;
    let path_text = canonical_path_text(path)?;
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path_text.as_str()))
        .and_then(|operation| operation.get())
        .map_err(|error| format!("无法打开 HEIC 文件 ({path_text})：{error}"))?;
    let input = file
        .OpenAsync(FileAccessMode::Read)
        .and_then(|operation| operation.get())
        .map_err(|error| format!("无法读取 HEIC 文件：{error}"))?;
    let decoder_id = BitmapDecoder::HeifDecoderId()
        .map_err(|error| format!("系统没有可用的 HEIF 解码器：{error}"))?;
    let decoder = BitmapDecoder::CreateWithIdAsync(decoder_id, &input)
        .and_then(|operation| operation.get())
        .map_err(|error| format!("Windows 无法解码此 HEIC/HEIF 图像：{error}"))?;

    let width = decoder
        .OrientedPixelWidth()
        .map_err(|error| format!("无法读取 HEIC 图像宽度：{error}"))?;
    let height = decoder
        .OrientedPixelHeight()
        .map_err(|error| format!("无法读取 HEIC 图像高度：{error}"))?;
    if width == 0 || height == 0 {
        return Err("HEIC 图像尺寸无效".to_string());
    }

    let limit = max_dimension.clamp(512, 8192);
    let scale = (limit as f64 / width.max(height) as f64).min(1.0);
    let output_width = ((width as f64 * scale).round() as u32).max(1);
    let output_height = ((height as f64 * scale).round() as u32).max(1);
    let transform =
        BitmapTransform::new().map_err(|error| format!("无法创建 HEIC 缩放参数：{error}"))?;
    transform
        .SetScaledWidth(output_width)
        .and_then(|_| transform.SetScaledHeight(output_height))
        .map_err(|error| format!("无法设置 HEIC 缩放参数：{error}"))?;
    let bitmap = decoder
        .GetSoftwareBitmapTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Premultiplied,
            &transform,
            ExifOrientationMode::RespectExifOrientation,
            ColorManagementMode::ColorManageToSRgb,
        )
        .and_then(|operation| operation.get())
        .map_err(|error| format!("无法转换 HEIC 像素：{error}"))?;

    let output = InMemoryRandomAccessStream::new()
        .map_err(|error| format!("无法创建 PNG 输出缓冲区：{error}"))?;
    let encoder_id =
        BitmapEncoder::PngEncoderId().map_err(|error| format!("无法获取 PNG 编码器：{error}"))?;
    let encoder = BitmapEncoder::CreateAsync(encoder_id, &output)
        .and_then(|operation| operation.get())
        .map_err(|error| format!("无法创建 PNG 编码器：{error}"))?;
    encoder
        .SetSoftwareBitmap(&bitmap)
        .and_then(|_| encoder.FlushAsync())
        .and_then(|operation| operation.get())
        .map_err(|error| format!("无法编码 HEIC 预览图：{error}"))?;

    let bytes = read_stream(&output)?;
    let _ = bitmap.Close();
    let _ = input.Close();
    let _ = output.Close();
    Ok(bytes)
}
