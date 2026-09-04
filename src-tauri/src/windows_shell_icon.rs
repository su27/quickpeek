use std::{ffi::c_void, path::Path};

use windows::{
    core::HSTRING,
    Win32::{
        Foundation::SIZE,
        Graphics::Gdi::{
            CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
            BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
        },
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::Shell::{
            IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK,
            SIIGBF_ICONONLY,
        },
    },
};

const ICON_SIZE: i32 = 128;

pub fn read(path: &Path) -> windows::core::Result<Vec<u8>> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        let result = read_initialized(path);
        CoUninitialize();
        result
    }
}

unsafe fn read_initialized(path: &Path) -> windows::core::Result<Vec<u8>> {
    let path = HSTRING::from(path.to_string_lossy().as_ref());
    let factory: IShellItemImageFactory = unsafe { SHCreateItemFromParsingName(&path, None) }?;
    let bitmap = unsafe {
        factory.GetImage(
            SIZE {
                cx: ICON_SIZE,
                cy: ICON_SIZE,
            },
            SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK,
        )
    }?;

    let result = unsafe { bitmap_rgba(bitmap) };
    unsafe {
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
    }
    result
}

unsafe fn bitmap_rgba(
    bitmap: windows::Win32::Graphics::Gdi::HBITMAP,
) -> windows::core::Result<Vec<u8>> {
    let mut bitmap_data = BITMAP::default();
    let object_size = i32::try_from(std::mem::size_of::<BITMAP>()).unwrap_or(i32::MAX);
    if unsafe {
        GetObjectW(
            HGDIOBJ(bitmap.0),
            object_size,
            Some((&mut bitmap_data as *mut BITMAP).cast::<c_void>()),
        )
    } == 0
    {
        return Err(windows::core::Error::from_win32());
    }

    let width = bitmap_data.bmWidth.unsigned_abs();
    let height = bitmap_data.bmHeight.unsigned_abs();
    if width == 0 || height == 0 || width > 512 || height > 512 {
        return Err(windows::core::Error::new(
            windows::core::HRESULT(0x8000_4005_u32 as i32),
            "Windows Shell 返回了无效的图标尺寸",
        ));
    }

    let pixel_count = usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|count| count.checked_mul(4))
        .ok_or_else(|| {
            windows::core::Error::new(
                windows::core::HRESULT(0x8007_000E_u32 as i32),
                "Windows Shell 图标过大",
            )
        })?;
    let mut bgra = vec![0_u8; pixel_count];
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let device_context = unsafe { CreateCompatibleDC(None) };
    if device_context.is_invalid() {
        return Err(windows::core::Error::from_win32());
    }
    let rows = unsafe {
        GetDIBits(
            device_context,
            bitmap,
            0,
            height,
            Some(bgra.as_mut_ptr().cast::<c_void>()),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        let _ = DeleteDC(device_context);
    }
    if rows == 0 {
        return Err(windows::core::Error::from_win32());
    }

    let mut payload = Vec::with_capacity(8 + bgra.len());
    payload.extend_from_slice(&width.to_le_bytes());
    payload.extend_from_slice(&height.to_le_bytes());
    for pixel in bgra.chunks_exact(4) {
        let [blue, green, red, alpha] = [pixel[0], pixel[1], pixel[2], pixel[3]];
        if alpha > 0 && alpha < 255 {
            let unpremultiply =
                |component: u8| ((u16::from(component) * 255) / u16::from(alpha)).min(255) as u8;
            payload.extend_from_slice(&[
                unpremultiply(red),
                unpremultiply(green),
                unpremultiply(blue),
                alpha,
            ]);
        } else {
            payload.extend_from_slice(&[red, green, blue, alpha]);
        }
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::read;

    #[test]
    fn reads_shell_icons_for_files_and_folders() {
        for path in [
            std::env::temp_dir(),
            std::env::current_exe().expect("test executable path"),
        ] {
            let payload = read(&path).expect("Windows Shell icon");
            assert!(payload.len() >= 8);
            let width = u32::from_le_bytes(payload[0..4].try_into().expect("width header"));
            let height = u32::from_le_bytes(payload[4..8].try_into().expect("height header"));
            assert!(width > 0 && height > 0);
            assert_eq!(payload.len(), 8 + (width * height * 4) as usize);
            assert!(payload[8..].chunks_exact(4).any(|pixel| pixel[3] > 0));
        }
    }
}
