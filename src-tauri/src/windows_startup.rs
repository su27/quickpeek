use std::os::windows::ffi::OsStrExt;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
use windows::Win32::System::Registry::*;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "QuickPeek";

pub fn enabled() -> Result<bool, String> {
    enabled_at(RUN_KEY)
}

fn enabled_at(subkey: &str) -> Result<bool, String> {
    let mut size = 0;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &HSTRING::from(subkey),
            &HSTRING::from(VALUE_NAME),
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut size),
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(false);
    }
    status.ok().map_err(|e| e.to_string())?;
    Ok(size > 2)
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    set_at(RUN_KEY, enabled, &executable)
}

struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

fn set_at(subkey: &str, enabled: bool, executable: &std::path::Path) -> Result<(), String> {
    let mut key = HKEY::default();
    let status = unsafe {
        if enabled {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                &HSTRING::from(subkey),
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                None,
                &mut key,
                None,
            )
        } else {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                &HSTRING::from(subkey),
                None,
                KEY_SET_VALUE,
                &mut key,
            )
        }
    };
    if !enabled && status == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    status.ok().map_err(|e| e.to_string())?;
    let key = Key(key);
    let status = if enabled {
        // Quote the executable so paths containing spaces are a single command.
        let command: Vec<u8> = std::iter::once(34u16)
            .chain(executable.as_os_str().encode_wide())
            .chain([34, 0])
            .flat_map(u16::to_le_bytes)
            .collect();
        unsafe {
            RegSetValueExW(
                key.0,
                &HSTRING::from(VALUE_NAME),
                None,
                REG_SZ,
                Some(&command),
            )
        }
    } else {
        unsafe { RegDeleteValueW(key.0, &HSTRING::from(VALUE_NAME)) }
    };
    if status == ERROR_SUCCESS || (!enabled && status == ERROR_FILE_NOT_FOUND) {
        Ok(())
    } else {
        status.ok().map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_toggle_round_trip() {
        let subkey = format!(r"Software\QuickPeekTests\Startup-{}", std::process::id());
        let path = std::path::Path::new(r"C:\Test folder\中文\quickpeek.exe");
        assert!(!enabled_at(&subkey).unwrap());
        set_at(&subkey, false, path).unwrap();
        set_at(&subkey, true, path).unwrap();
        assert!(enabled_at(&subkey).unwrap());
        let mut buffer = [0u16; 256];
        let mut size = std::mem::size_of_val(&buffer) as u32;
        unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(&subkey),
                &HSTRING::from(VALUE_NAME),
                RRF_RT_REG_SZ,
                None,
                Some(buffer.as_mut_ptr().cast()),
                Some(&mut size),
            )
            .ok()
            .unwrap();
        }
        assert_eq!(
            String::from_utf16(&buffer[..size as usize / 2 - 1]).unwrap(),
            format!("\"{}\"", path.display())
        );
        set_at(&subkey, false, path).unwrap();
        assert!(!enabled_at(&subkey).unwrap());
        set_at(&subkey, false, path).unwrap();
        unsafe {
            RegDeleteKeyW(HKEY_CURRENT_USER, &HSTRING::from(subkey))
                .ok()
                .unwrap();
        }
    }
}
