use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};

const PREFIX_LIMIT: u64 = 8 * 1024 * 1024;
const SUFFIX_LIMIT: u64 = 2 * 1024 * 1024;

pub fn read_dimensions(path: &Path) -> io::Result<Option<(f64, f64)>> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let mut prefix = Vec::with_capacity(length.min(PREFIX_LIMIT) as usize);
    file.by_ref().take(PREFIX_LIMIT).read_to_end(&mut prefix)?;
    if let Some(dimensions) = parse_dimensions(&prefix) {
        return Ok(Some(dimensions));
    }

    if length <= PREFIX_LIMIT {
        return Ok(None);
    }

    let suffix_length = length.min(SUFFIX_LIMIT);
    file.seek(SeekFrom::End(-(suffix_length as i64)))?;
    let mut suffix = Vec::with_capacity(suffix_length as usize);
    file.take(SUFFIX_LIMIT).read_to_end(&mut suffix)?;
    Ok(parse_dimensions(&suffix))
}

fn parse_dimensions(bytes: &[u8]) -> Option<(f64, f64)> {
    let (mut width, mut height) =
        parse_box(bytes, b"/CropBox").or_else(|| parse_box(bytes, b"/MediaBox"))?;
    let rotation = parse_number_after_name(bytes, b"/Rotate").unwrap_or(0.0) as i32;
    if rotation.rem_euclid(180) == 90 {
        std::mem::swap(&mut width, &mut height);
    }
    Some((width, height))
}

fn parse_box(bytes: &[u8], name: &[u8]) -> Option<(f64, f64)> {
    let mut search_from = 0;
    while let Some(relative) = find_bytes(&bytes[search_from..], name) {
        let name_start = search_from + relative;
        let mut cursor = name_start + name.len();
        skip_pdf_whitespace(bytes, &mut cursor);
        if bytes.get(cursor) != Some(&b'[') {
            search_from = name_start + name.len();
            continue;
        }
        cursor += 1;

        let x1 = parse_number(bytes, &mut cursor)?;
        let y1 = parse_number(bytes, &mut cursor)?;
        let x2 = parse_number(bytes, &mut cursor)?;
        let y2 = parse_number(bytes, &mut cursor)?;
        let width = (x2 - x1).abs();
        let height = (y2 - y1).abs();
        if width.is_finite()
            && height.is_finite()
            && (1.0..=200_000.0).contains(&width)
            && (1.0..=200_000.0).contains(&height)
        {
            return Some((width, height));
        }
        search_from = name_start + name.len();
    }
    None
}

fn parse_number_after_name(bytes: &[u8], name: &[u8]) -> Option<f64> {
    let start = find_bytes(bytes, name)? + name.len();
    let mut cursor = start;
    parse_number(bytes, &mut cursor)
}

fn parse_number(bytes: &[u8], cursor: &mut usize) -> Option<f64> {
    skip_pdf_whitespace(bytes, cursor);
    let start = *cursor;
    while let Some(byte) = bytes.get(*cursor) {
        if byte.is_ascii_digit() || matches!(byte, b'+' | b'-' | b'.') {
            *cursor += 1;
        } else {
            break;
        }
    }
    if *cursor == start {
        return None;
    }
    std::str::from_utf8(&bytes[start..*cursor])
        .ok()?
        .parse()
        .ok()
}

fn skip_pdf_whitespace(bytes: &[u8], cursor: &mut usize) {
    loop {
        while bytes
            .get(*cursor)
            .is_some_and(|byte| matches!(byte, b'\0' | b'\t' | b'\n' | b'\x0C' | b'\r' | b' '))
        {
            *cursor += 1;
        }
        if bytes.get(*cursor) != Some(&b'%') {
            return;
        }
        while bytes
            .get(*cursor)
            .is_some_and(|byte| !matches!(byte, b'\n' | b'\r'))
        {
            *cursor += 1;
        }
    }
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::parse_dimensions;

    #[test]
    fn reads_crop_box_before_media_box() {
        let pdf = b"/MediaBox [0 0 612 792] /CropBox [10 20 595.2756 396.8504]";
        let dimensions = parse_dimensions(pdf).expect("page dimensions");
        assert!((dimensions.0 - 585.2756).abs() < 0.001);
        assert!((dimensions.1 - 376.8504).abs() < 0.001);
    }

    #[test]
    fn applies_quarter_turn_rotation() {
        let pdf = b"/Type /Page /MediaBox [0 0 300 600] /Rotate 270";
        assert_eq!(parse_dimensions(pdf), Some((600.0, 300.0)));
    }

    #[test]
    fn ignores_indirect_or_invalid_boxes() {
        assert_eq!(parse_dimensions(b"/MediaBox 12 0 R"), None);
        assert_eq!(parse_dimensions(b"/MediaBox [0 0 0 200]"), None);
    }
}
