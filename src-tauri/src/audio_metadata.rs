use serde::Serialize;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

const ID3_HEADER_BYTES: usize = 10;
const MAX_ID3_TAG_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMetadata {
    pub album: Option<String>,
    pub artist: Option<String>,
    pub composer: Option<String>,
    pub genre: Option<String>,
    pub title: Option<String>,
    pub track: Option<String>,
    pub year: Option<String>,
}

impl AudioMetadata {
    fn has_values(&self) -> bool {
        self.album.is_some()
            || self.artist.is_some()
            || self.composer.is_some()
            || self.genre.is_some()
            || self.title.is_some()
            || self.track.is_some()
            || self.year.is_some()
    }

    fn set_frame(&mut self, id: &str, value: String) {
        let slot = match id {
            "TAL" | "TALB" => &mut self.album,
            "TP1" | "TPE1" => &mut self.artist,
            "TCM" | "TCOM" => &mut self.composer,
            "TCO" | "TCON" => &mut self.genre,
            "TT2" | "TIT2" => &mut self.title,
            "TRK" | "TRCK" => &mut self.track,
            "TYE" | "TYER" | "TDRC" => &mut self.year,
            _ => return,
        };
        if slot.is_none() && !value.is_empty() {
            *slot = Some(value);
        }
    }
}

fn synchsafe(bytes: &[u8]) -> Option<usize> {
    if bytes.len() != 4 || bytes.iter().any(|byte| byte & 0x80 != 0) {
        return None;
    }
    Some(
        (usize::from(bytes[0]) << 21)
            | (usize::from(bytes[1]) << 14)
            | (usize::from(bytes[2]) << 7)
            | usize::from(bytes[3]),
    )
}

fn big_endian_24(bytes: &[u8]) -> Option<usize> {
    (bytes.len() == 3).then(|| {
        (usize::from(bytes[0]) << 16) | (usize::from(bytes[1]) << 8) | usize::from(bytes[2])
    })
}

fn big_endian_32(bytes: &[u8]) -> Option<usize> {
    let value = u32::from_be_bytes(bytes.try_into().ok()?);
    usize::try_from(value).ok()
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| char::from(*byte)).collect()
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> String {
    let units = bytes.chunks_exact(2).map(|pair| {
        if little_endian {
            u16::from_le_bytes([pair[0], pair[1]])
        } else {
            u16::from_be_bytes([pair[0], pair[1]])
        }
    });
    char::decode_utf16(units)
        .map(|character| character.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

fn decode_text_frame(data: &[u8]) -> Option<String> {
    let (&encoding, value) = data.split_first()?;
    let decoded = match encoding {
        0 => latin1(value),
        1 if value.starts_with(&[0xff, 0xfe]) => decode_utf16(&value[2..], true),
        1 if value.starts_with(&[0xfe, 0xff]) => decode_utf16(&value[2..], false),
        1 | 2 => decode_utf16(value, false),
        3 => String::from_utf8_lossy(value).into_owned(),
        _ => return None,
    };
    let normalized = decoded
        .trim_matches(['\0', '\u{feff}', ' ', '\r', '\n', '\t'])
        .replace('\0', " / ");
    (!normalized.is_empty()).then_some(normalized)
}

fn remove_unsynchronization(data: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(data.len());
    let mut index = 0;
    while index < data.len() {
        output.push(data[index]);
        if data[index] == 0xff && data.get(index + 1) == Some(&0) {
            index += 1;
        }
        index += 1;
    }
    output
}

fn extended_header_offset(version: u8, flags: u8, data: &[u8]) -> usize {
    if flags & 0x40 == 0 || data.len() < 4 {
        return 0;
    }
    let size = if version == 4 {
        synchsafe(&data[..4])
    } else {
        big_endian_32(&data[..4]).and_then(|size| size.checked_add(4))
    };
    size.filter(|size| *size <= data.len()).unwrap_or(0)
}

fn parse_id3v2(header: &[u8], payload: &[u8], metadata: &mut AudioMetadata) {
    let version = header[3];
    if !(2..=4).contains(&version) {
        return;
    }
    let flags = header[5];
    let owned;
    let data = if flags & 0x80 != 0 {
        owned = remove_unsynchronization(payload);
        owned.as_slice()
    } else {
        payload
    };
    let mut offset = extended_header_offset(version, flags, data);

    while offset < data.len() {
        let (header_size, id_length, frame_size) = if version == 2 {
            if data.len() - offset < 6 {
                break;
            }
            (6, 3, big_endian_24(&data[offset + 3..offset + 6]))
        } else {
            if data.len() - offset < 10 {
                break;
            }
            let size = if version == 4 {
                synchsafe(&data[offset + 4..offset + 8])
            } else {
                big_endian_32(&data[offset + 4..offset + 8])
            };
            (10, 4, size)
        };

        let id_bytes = &data[offset..offset + id_length];
        if id_bytes.iter().all(|byte| *byte == 0) {
            break;
        }
        if !id_bytes
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
        {
            break;
        }
        let Some(frame_size) = frame_size else {
            break;
        };
        let Some(frame_start) = offset.checked_add(header_size) else {
            break;
        };
        let Some(frame_end) = frame_start.checked_add(frame_size) else {
            break;
        };
        if frame_end > data.len() {
            break;
        }

        let id = String::from_utf8_lossy(id_bytes);
        if id.starts_with('T') {
            if let Some(value) = decode_text_frame(&data[frame_start..frame_end]) {
                metadata.set_frame(&id, value);
            }
        }
        offset = frame_end;
    }
}

fn id3v1_field(data: &[u8]) -> Option<String> {
    let value = latin1(data)
        .trim_matches(['\0', ' ', '\r', '\n', '\t'])
        .to_string();
    (!value.is_empty()).then_some(value)
}

fn parse_id3v1(data: &[u8], metadata: &mut AudioMetadata) {
    if data.len() != 128 || &data[..3] != b"TAG" {
        return;
    }
    metadata.title = metadata.title.take().or_else(|| id3v1_field(&data[3..33]));
    metadata.artist = metadata
        .artist
        .take()
        .or_else(|| id3v1_field(&data[33..63]));
    metadata.album = metadata.album.take().or_else(|| id3v1_field(&data[63..93]));
    metadata.year = metadata.year.take().or_else(|| id3v1_field(&data[93..97]));
    if metadata.track.is_none() && data[125] == 0 && data[126] > 0 {
        metadata.track = Some(data[126].to_string());
    }
}

pub fn read(path: &Path) -> std::io::Result<Option<AudioMetadata>> {
    let mut file = File::open(path)?;
    let mut metadata = AudioMetadata::default();
    let mut header = [0_u8; ID3_HEADER_BYTES];
    let bytes_read = file.read(&mut header)?;

    if bytes_read == ID3_HEADER_BYTES && &header[..3] == b"ID3" {
        if let Some(tag_size) = synchsafe(&header[6..10]).filter(|size| *size <= MAX_ID3_TAG_BYTES)
        {
            let mut payload = vec![0_u8; tag_size];
            file.read_exact(&mut payload)?;
            parse_id3v2(&header, &payload, &mut metadata);
        }
    }

    if file.metadata()?.len() >= 128 {
        file.seek(SeekFrom::End(-128))?;
        let mut tail = [0_u8; 128];
        file.read_exact(&mut tail)?;
        parse_id3v1(&tail, &mut metadata);
    }

    Ok(metadata.has_values().then_some(metadata))
}

#[cfg(test)]
mod tests {
    use super::{parse_id3v1, parse_id3v2, AudioMetadata};

    fn text_frame(id: &[u8; 4], value: &str) -> Vec<u8> {
        let mut frame = Vec::new();
        frame.extend_from_slice(id);
        frame.extend_from_slice(&(value.len() as u32 + 1).to_be_bytes());
        frame.extend_from_slice(&[0, 0]);
        frame.push(3);
        frame.extend_from_slice(value.as_bytes());
        frame
    }

    #[test]
    fn reads_common_id3v23_text_frames() {
        let mut payload = text_frame(b"TIT2", "A song");
        payload.extend(text_frame(b"TPE1", "An artist"));
        payload.extend(text_frame(b"TALB", "An album"));
        let header = [b'I', b'D', b'3', 3, 0, 0, 0, 0, 0, 0];
        let mut metadata = AudioMetadata::default();
        parse_id3v2(&header, &payload, &mut metadata);
        assert_eq!(metadata.title.as_deref(), Some("A song"));
        assert_eq!(metadata.artist.as_deref(), Some("An artist"));
        assert_eq!(metadata.album.as_deref(), Some("An album"));
    }

    #[test]
    fn falls_back_to_id3v1_fields() {
        let mut tag = [0_u8; 128];
        tag[..3].copy_from_slice(b"TAG");
        tag[3..8].copy_from_slice(b"Title");
        tag[33..39].copy_from_slice(b"Artist");
        tag[125] = 0;
        tag[126] = 4;
        let mut metadata = AudioMetadata::default();
        parse_id3v1(&tag, &mut metadata);
        assert_eq!(metadata.title.as_deref(), Some("Title"));
        assert_eq!(metadata.artist.as_deref(), Some("Artist"));
        assert_eq!(metadata.track.as_deref(), Some("4"));
    }
}
