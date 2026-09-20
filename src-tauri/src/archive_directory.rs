//! Bounded metadata-only archive inspection. Never extracts archive members.
use serde::Serialize;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
    time::{Duration, Instant},
};
const MAX_ENTRIES: usize = 5000;
const MAX_NAMES: usize = 2 * 1024 * 1024;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub dir: bool,
    pub uncompressed_size: Option<u64>,
    pub compressed_size: Option<u64>,
    pub date_parts: Option<[u16; 6]>,
}
#[derive(Serialize)]
pub struct Directory {
    pub entries: Vec<Entry>,
    pub truncated: bool,
}
fn u16le(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}
fn u32le(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes(b[i..i + 4].try_into().unwrap())
}

pub fn supported(path: &Path) -> bool {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    [
        "zip", "jar", "war", "apk", "vsix", "nupkg", "tar", "tgz", "tbz2", "txz", "7z", "rar",
        "tar.gz", "tar.bz2", "tar.xz", "tar.zst",
    ]
    .iter()
    .any(|ext| name.ends_with(&format!(".{ext}")))
}

fn zip_directory<R: Read + Seek>(
    file: &mut R,
    mut current: impl FnMut() -> bool,
) -> Result<Directory, String> {
    let len = file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
    let tail_len = len.min(65557) as usize;
    file.seek(SeekFrom::End(-(tail_len as i64)))
        .map_err(|e| e.to_string())?;
    let mut tail = vec![0; tail_len];
    file.read_exact(&mut tail).map_err(|e| e.to_string())?;
    let eocd = (0..tail.len().saturating_sub(21))
        .rev()
        .find(|&i| {
            tail[i..].starts_with(b"PK\x05\x06")
                && i + 22 + u16le(&tail, i + 20) as usize == tail.len()
        })
        .ok_or("ZIP central directory not found")?;
    if u16le(&tail, eocd + 4) != 0 || u16le(&tail, eocd + 6) != 0 {
        return Err("Split ZIP archives are not supported".into());
    }
    let count = u16le(&tail, eocd + 10) as usize;
    let size = u32le(&tail, eocd + 12) as u64;
    let offset = u32le(&tail, eocd + 16) as u64;
    if count == 65535 || size == u32::MAX as u64 || offset == u32::MAX as u64 {
        return Err("ZIP64 requires the system archive reader".into());
    }
    let end = offset
        .checked_add(size)
        .filter(|end| *end <= len)
        .ok_or("Invalid ZIP directory bounds")?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    let mut names = 0;
    for _ in 0..count.min(MAX_ENTRIES) {
        if !current() {
            return Err("Preview cancelled".into());
        }
        let pos = file.stream_position().map_err(|e| e.to_string())?;
        if pos + 46 > end {
            return Err("Incomplete ZIP directory".into());
        }
        let mut header = [0; 46];
        file.read_exact(&mut header).map_err(|e| e.to_string())?;
        if !header.starts_with(b"PK\x01\x02") {
            return Err("Invalid ZIP directory entry".into());
        }
        let name_len = u16le(&header, 28) as usize;
        let extra_len = u16le(&header, 30) as usize;
        let comment_len = u16le(&header, 32) as u64;
        if pos + 46 + name_len as u64 + extra_len as u64 + comment_len > end {
            return Err("ZIP directory is out of bounds".into());
        }
        names += name_len;
        if names > MAX_NAMES {
            return Ok(Directory {
                entries,
                truncated: true,
            });
        }
        let mut name = vec![0; name_len];
        file.read_exact(&mut name).map_err(|e| e.to_string())?;
        let mut extra = vec![0; extra_len];
        file.read_exact(&mut extra).map_err(|e| e.to_string())?;
        let name = decode_zip_name(&name, u16le(&header, 8) & 0x800 != 0, &extra);
        names += name.len().saturating_sub(name_len);
        if names > MAX_NAMES {
            return Ok(Directory {
                entries,
                truncated: true,
            });
        }
        let original = u32le(&header, 24);
        let compressed = u32le(&header, 20);
        let date = u16le(&header, 14);
        let time = u16le(&header, 12);
        entries.push(Entry {
            dir: name.ends_with(['/', '\\']) || header[38] & 0x10 != 0,
            name,
            date_parts: (date != 0).then_some([
                1980 + (date >> 9),
                (date >> 5) & 15,
                date & 31,
                time >> 11,
                (time >> 5) & 63,
                (time & 31) * 2,
            ]),
            uncompressed_size: (original != u32::MAX).then_some(original as u64),
            compressed_size: (compressed != u32::MAX).then_some(compressed as u64),
        });
        file.seek(SeekFrom::Current(comment_len as i64))
            .map_err(|e| e.to_string())?;
    }
    Ok(Directory {
        truncated: count > entries.len(),
        entries,
    })
}

// Info-ZIP Unicode Path fields are authoritative only when their CRC matches
// the original filename. Ignore stale, malformed or unsupported fields.
fn unicode_zip_path<'a>(bytes: &[u8], mut extra: &'a [u8]) -> Option<&'a str> {
    while extra.len() >= 4 {
        let tag = u16le(extra, 0);
        let len = u16le(extra, 2) as usize;
        let field = extra.get(4..4 + len)?;
        if tag == 0x7075 && field.len() > 5 && field[0] == 1 && u32le(field, 1) == name_crc32(bytes)
        {
            if let Ok(name) = std::str::from_utf8(&field[5..]) {
                return Some(name);
            }
        }
        extra = &extra[4 + len..];
    }
    None
}

fn name_crc32(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for byte in bytes {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb88320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

fn decode_zip_name(bytes: &[u8], utf8: bool, extra: &[u8]) -> String {
    if !utf8 {
        if let Some(name) = unicode_zip_path(bytes, extra) {
            return name.into();
        }
    }
    if utf8 || std::str::from_utf8(bytes).is_ok() {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    #[cfg(windows)]
    if let Some(name) =
        decode_legacy_zip_name(bytes, unsafe { windows::Win32::Globalization::GetACP() })
    {
        return name;
    }
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(windows)]
fn decode_legacy_zip_name(bytes: &[u8], local_code_page: u32) -> Option<String> {
    // Older East Asian Windows archivers wrote local multibyte filenames
    // without Unicode metadata. Prefer the local DBCS encoding only when the
    // entire name is valid; otherwise retain ZIP's historical CP437 fallback.
    // Single-byte ANSI pages are deliberately excluded: they accept almost
    // everything and would incorrectly reinterpret ordinary OEM filenames.
    if matches!(local_code_page, 932 | 936 | 949 | 950) {
        if let Some(name) = decode_code_page(bytes, local_code_page) {
            return Some(name);
        }
    }
    decode_code_page(bytes, 437)
}

#[cfg(windows)]
fn decode_code_page(bytes: &[u8], code_page: u32) -> Option<String> {
    {
        use windows::Win32::Globalization::{MultiByteToWideChar, MB_ERR_INVALID_CHARS};
        let mut wide = vec![0; bytes.len()];
        let count =
            unsafe { MultiByteToWideChar(code_page, MB_ERR_INVALID_CHARS, bytes, Some(&mut wide)) };
        if count > 0 {
            return Some(String::from_utf16_lossy(&wide[..count as usize]));
        }
    }
    None
}

#[cfg(windows)]
fn decode_system_listing(bytes: &[u8]) -> String {
    // Windows bsdtar writes redirected names using the active ANSI code page,
    // not the terminal's encoding; LC_ALL does not change that conversion.
    let code_page = unsafe { windows::Win32::Globalization::GetACP() };
    decode_code_page(bytes, code_page)
        .unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
}

fn directory_from_listing(text: &str) -> Directory {
    let mut lines = text.lines().filter(|line| !line.is_empty());
    let mut entries: Vec<Entry> = lines
        .by_ref()
        .take(MAX_ENTRIES)
        .map(|name| Entry {
            name: name.into(),
            dir: name.ends_with(['/', '\\']),
            uncompressed_size: None,
            compressed_size: None,
            date_parts: None,
        })
        .collect();
    // Some RAR directory records lack a trailing slash in bsdtar's output.
    // Recognize explicit parents too, otherwise the tree gets a duplicate file.
    let names: Vec<String> = entries
        .iter()
        .map(|entry| entry.name.replace('\\', "/"))
        .collect();
    let explicit: std::collections::HashSet<&str> = names.iter().map(String::as_str).collect();
    let mut parents = std::collections::HashSet::new();
    for name in &names {
        // Match the UI's depth limit and bound hashing work on hostile paths.
        for (index, _) in name.match_indices('/').take(128) {
            if explicit.contains(&name[..index]) {
                parents.insert(&name[..index]);
            }
        }
    }
    for (entry, name) in entries.iter_mut().zip(&names) {
        entry.dir |= parents.contains(name.as_str());
    }
    Directory {
        entries,
        truncated: lines.next().is_some(),
    }
}

pub fn read(path: &Path, generation: u32) -> Result<Directory, String> {
    static WORK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _work = WORK.lock().map_err(|_| "Archive reader unavailable")?;
    let current = || crate::preview_generation_is_current(generation);
    if !current() {
        return Err("Preview cancelled".into());
    }
    if !supported(path) || !path.is_file() {
        return Err("Unsupported archive format".into());
    }
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut signature = [0; 4];
    if file.read_exact(&mut signature).is_ok() && signature.starts_with(b"PK") {
        if let Ok(directory) = zip_directory(&mut file, current) {
            return Ok(directory);
        }
    }
    system_directory(path, current)
}

#[cfg(windows)]
fn system_directory(path: &Path, current: impl Fn() -> bool) -> Result<Directory, String> {
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
    };
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
    if !current() {
        return Err("Preview cancelled".into());
    }
    let mut directory = [0u16; 32768];
    let count = unsafe { GetSystemDirectoryW(Some(&mut directory)) } as usize;
    if count == 0 || count >= directory.len() {
        return Err("System tar could not be found".into());
    }
    let tar =
        std::path::PathBuf::from(String::from_utf16_lossy(&directory[..count])).join("tar.exe");
    let mut child = Command::new(tar)
        .args(["-t", "-f"])
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|e| format!("System tar unavailable: {e}"))?;
    let stdout = child.stdout.take().unwrap();
    let overflow = Arc::new(AtomicBool::new(false));
    let reader_overflow = overflow.clone();
    let reader = std::thread::spawn(move || {
        let mut output = Vec::new();
        let result = stdout.take(MAX_NAMES as u64 + 1).read_to_end(&mut output);
        reader_overflow.store(output.len() > MAX_NAMES, Ordering::Release);
        (result, output)
    });
    let deadline = Instant::now() + Duration::from_secs(8);
    let status = loop {
        if !current() || Instant::now() >= deadline || overflow.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            break Err(if !current() {
                "Preview cancelled"
            } else {
                "Archive listing timed out or exceeded the size limit"
            }
            .to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                break if status.success() {
                    Ok(())
                } else {
                    Err("This archive is unsupported, damaged, or encrypted".into())
                }
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(error.to_string());
            }
        }
    };
    let (read_result, output) = reader
        .join()
        .map_err(|_| "Could not read archive listing")?;
    status?;
    read_result.map_err(|e| e.to_string())?;
    if output.len() > MAX_NAMES {
        return Err("Archive listing exceeds the size limit".into());
    }
    Ok(directory_from_listing(&decode_system_listing(&output)))
}
#[cfg(not(windows))]
fn system_directory(_: &Path, _: impl Fn() -> bool) -> Result<Directory, String> {
    Err("Windows tar is required".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Vec<u8> {
        named_fixture("目录/a.txt".as_bytes(), 0x800, &[])
    }
    fn named_fixture(name: &[u8], flags: u16, extra: &[u8]) -> Vec<u8> {
        let mut b = vec![0; 46];
        b[..4].copy_from_slice(b"PK\x01\x02");
        b[8..10].copy_from_slice(&flags.to_le_bytes());
        b[20..24].copy_from_slice(&12u32.to_le_bytes());
        b[24..28].copy_from_slice(&40u32.to_le_bytes());
        b[28..30].copy_from_slice(&(name.len() as u16).to_le_bytes());
        b[30..32].copy_from_slice(&(extra.len() as u16).to_le_bytes());
        b.extend(name);
        b.extend(extra);
        let size = b.len() as u32;
        let mut end = [0; 22];
        end[..4].copy_from_slice(b"PK\x05\x06");
        end[8..10].copy_from_slice(&1u16.to_le_bytes());
        end[10..12].copy_from_slice(&1u16.to_le_bytes());
        end[12..16].copy_from_slice(&size.to_le_bytes());
        b.extend(end);
        b
    }
    fn unicode_extra(raw: &[u8], name: &str) -> Vec<u8> {
        let mut extra = vec![0x75, 0x70];
        extra.extend(((5 + name.len()) as u16).to_le_bytes());
        extra.push(1);
        extra.extend(name_crc32(raw).to_le_bytes());
        extra.extend(name.as_bytes());
        extra
    }
    #[test]
    fn zip_unicode_path_validates_crc_and_preserves_utf8_priority() {
        assert_eq!(name_crc32(b"123456789"), 0xcbf43926);
        let raw = b"\xc6\xc0\xb9\xc0\xb2\xc4\xc1\xcf\xd0\xe8\xc7\xf3\xce\xc4\xbc\xfe/";
        assert_eq!(name_crc32(raw), 0x2c5af99b);
        let extra = unicode_extra(raw, "评估材料需求文件/");
        let result = zip_directory(
            &mut std::io::Cursor::new(named_fixture(raw, 0, &extra)),
            || true,
        )
        .unwrap();
        assert_eq!(result.entries[0].name, "评估材料需求文件/");
        assert!(result.entries[0].dir);
        assert_eq!(unicode_zip_path(b"different", &extra), None);
        for len in 0..extra.len() {
            assert_eq!(unicode_zip_path(raw, &extra[..len]), None);
        }
        let mut bad = extra.clone();
        bad[4] = 2;
        assert_eq!(unicode_zip_path(raw, &bad), None);
        let utf8 = "中文.txt".as_bytes();
        assert_eq!(
            decode_zip_name(utf8, true, &unicode_extra(utf8, "wrong")),
            "中文.txt"
        );
        assert_eq!(decode_zip_name(utf8, false, &[]), "中文.txt");
        assert_eq!(decode_zip_name(b"plain.txt", false, &extra), "plain.txt");
    }
    #[test]
    fn system_listing_recognizes_rar_parents_without_trailing_slash() {
        let listing = directory_from_listing(
            "中文目录/文件.txt\r\n中文目录\r\n空目录/\r\n另一目录\\\r\nroot.txt\r\n",
        );
        assert_eq!(listing.entries.len(), 5);
        assert!(!listing.entries[0].dir);
        assert!(listing.entries[1..4].iter().all(|entry| entry.dir));
        assert!(!listing.entries[4].dir);
        assert!(!listing.truncated);
    }
    #[cfg(windows)]
    #[test]
    fn archive_code_pages_do_not_replace_chinese_or_oem_names() {
        assert_eq!(
            decode_code_page(b"\xd6\xd0\xce\xc4.txt", 936).as_deref(),
            Some("中文.txt")
        );
        assert_eq!(
            decode_code_page(b"caf\x82.txt", 437).as_deref(),
            Some("café.txt")
        );
        assert_eq!(
            decode_legacy_zip_name(b"\xd6\xd0\xce\xc4.txt", 936).as_deref(),
            Some("中文.txt")
        );
        assert_eq!(
            decode_legacy_zip_name(b"caf\x82.txt", 936).as_deref(),
            Some("café.txt")
        );
        assert_eq!(
            decode_legacy_zip_name(b"caf\x82.txt", 1252).as_deref(),
            Some("café.txt")
        );
    }
    #[cfg(windows)]
    #[test]
    fn optional_real_archive_encoding_regressions() {
        // Private samples remain outside the repository; opt in when available.
        if let Some(path) = std::env::var_os("QUICKPEEK_TEST_GBK_ZIP") {
            let result = zip_directory(&mut File::open(path).unwrap(), || true).unwrap();
            assert_eq!(result.entries.len(), 2165);
            assert!(!result.truncated);
            assert!(result
                .entries
                .iter()
                .all(|entry| entry.name.starts_with("科幻世界10年精华本/")));
            assert!(result
                .entries
                .iter()
                .any(|entry| entry.name == "科幻世界10年精华本/1991/目录.txt"));
        }
        if let Some(path) = std::env::var_os("QUICKPEEK_TEST_UNICODE_ZIP") {
            let result = zip_directory(&mut File::open(path).unwrap(), || true).unwrap();
            assert_eq!(result.entries.len(), 9);
            assert_eq!(result.entries.iter().filter(|entry| entry.dir).count(), 5);
            assert!(result
                .entries
                .iter()
                .all(|entry| entry.name.starts_with("评估材料需求文件/")));
            assert!(result
                .entries
                .iter()
                .any(|entry| entry.name.ends_with("常规一般-系统层面资料需求v1.1.docx")));
        }
        if let Some(path) = std::env::var_os("QUICKPEEK_TEST_CHINESE_RAR") {
            let result = system_directory(Path::new(&path), || true).unwrap();
            assert_eq!(result.entries.len(), 5);
            assert_eq!(result.entries.iter().filter(|entry| entry.dir).count(), 1);
            assert!(result.entries.iter().all(|entry| entry
                .name
                .starts_with("广西教育出版社_豆瓣机构账号认证材料")));
            assert!(result
                .entries
                .iter()
                .any(|entry| entry.name.ends_with("/营业执照.png")));
        }
    }
    #[test]
    fn zip_metadata_without_payload() {
        let result = zip_directory(&mut std::io::Cursor::new(fixture()), || true).unwrap();
        assert_eq!(result.entries[0].name, "目录/a.txt");
        assert_eq!(result.entries[0].uncompressed_size, Some(40));
        assert_eq!(result.entries[0].compressed_size, Some(12));
    }
    #[test]
    fn cancelled_zip_and_invalid_offsets_fail() {
        assert!(zip_directory(&mut std::io::Cursor::new(fixture()), || false).is_err());
        let mut b = fixture();
        let i = b.len() - 6;
        b[i..i + 4].copy_from_slice(&999999u32.to_le_bytes());
        assert!(zip_directory(&mut std::io::Cursor::new(b), || true).is_err());
    }
    #[test]
    fn compound_suffixes_are_explicit() {
        assert!(supported(Path::new("archive.tar.gz")));
        assert!(!supported(Path::new("random.gz")));
    }
    #[cfg(windows)]
    #[test]
    fn system_tar_lists_real_tar_tgz_and_7z() {
        use std::{os::windows::process::CommandExt, process::Command};
        let dir =
            std::env::temp_dir().join(format!("quickpeek-archive-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let member = "space 中文.txt";
        std::fs::write(dir.join(member), "directory test").unwrap();
        let tar = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/tar.exe");
        for name in ["test.tar", "test.tar.gz", "test.7z"] {
            let path = dir.join(name);
            let status = Command::new(&tar)
                .args(["-a", "-cf"])
                .arg(&path)
                .arg("-C")
                .arg(&dir)
                .arg(member)
                .creation_flags(0x08000000)
                .status()
                .unwrap();
            assert!(status.success(), "failed to generate {name}");
            let listing = system_directory(&path, || true).unwrap();
            assert_eq!(listing.entries.len(), 1);
            assert_eq!(listing.entries[0].name, member);
            assert!(system_directory(&path, || false).is_err());
            std::fs::remove_file(path).unwrap();
        }
        std::fs::remove_file(dir.join(member)).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
