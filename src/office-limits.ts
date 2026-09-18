export function validateOfficeDirectory(bytes: ArrayBuffer): void {
  if (bytes.byteLength > 32 * 1024 * 1024) throw new Error("Office file exceeds the 32 MB preview limit");
  const data = new DataView(bytes);
  let end = -1;
  for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 65557); at--) {
    if (data.getUint32(at, true) === 0x06054b50 && at + 22 + data.getUint16(at + 20, true) === bytes.byteLength) { end = at; break; }
  }
  if (end < 0) throw new Error("Incomplete Office archive");
  const count = data.getUint16(end + 10, true), size = data.getUint32(end + 12, true), offset = data.getUint32(end + 16, true);
  if (count > 4096 || data.getUint16(end + 4, true) || data.getUint16(end + 6, true) || offset + size > end) throw new Error("Unsupported Office archive");
  let total = 0, found = 0;
  for (let at = offset; at < offset + size;) {
    if (at + 46 > offset + size || data.getUint32(at, true) !== 0x02014b50 || ++found > 4096) throw new Error("Invalid Office directory");
    const length = data.getUint32(at + 24, true);
    total += length;
    if (length > 32 * 1024 * 1024 || total > 64 * 1024 * 1024) throw new Error("Expanded Office document exceeds the preview limit");
    at += 46 + data.getUint16(at + 28, true) + data.getUint16(at + 30, true) + data.getUint16(at + 32, true);
    if (at > offset + size) throw new Error("Invalid Office directory bounds");
  }
  if (found !== count) throw new Error("Invalid Office entry count");
}
