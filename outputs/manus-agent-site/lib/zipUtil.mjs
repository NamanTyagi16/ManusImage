import zlib from "node:zlib";

/**
 * Creates a standard ZIP archive buffer from an array of files.
 * @param {Array<{ name: string, data: Buffer }>} files
 * @returns {Buffer}
 */
export function createZipArchive(files) {
  const fileEntries = [];
  let offset = 0;
  const parts = [];

  const now = new Date();
  // DOS date and time formatting
  const dosTime =
    ((now.getHours() & 0x1f) << 11) |
    ((now.getMinutes() & 0x3f) << 5) |
    ((Math.floor(now.getSeconds() / 2)) & 0x1f);
  const dosDate =
    (((now.getFullYear() - 1980) & 0x7f) << 9) |
    (((now.getMonth() + 1) & 0x0f) << 5) |
    (now.getDate() & 0x1f);

  for (const file of files) {
    const nameBuf = Buffer.from(file.name.replace(/\\/g, "/"), "utf8");
    const dataBuf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || "");
    const crc = zlib.crc32(dataBuf);
    const size = dataBuf.length;

    // Local file header (30 bytes + name length)
    const header = Buffer.alloc(30 + nameBuf.length);
    header.writeUInt32LE(0x04034b50, 0); // signature
    header.writeUInt16LE(20, 4);         // version needed (2.0)
    header.writeUInt16LE(0x0800, 6);      // flags (bit 11 = UTF-8)
    header.writeUInt16LE(0, 8);           // compression method (0 = store)
    header.writeUInt16LE(dosTime, 10);    // time
    header.writeUInt16LE(dosDate, 12);    // date
    header.writeUInt32LE(crc, 14);        // crc-32
    header.writeUInt32LE(size, 18);       // compressed size
    header.writeUInt32LE(size, 22);       // uncompressed size
    header.writeUInt16LE(nameBuf.length, 26); // file name length
    header.writeUInt16LE(0, 28);          // extra field length
    nameBuf.copy(header, 30);

    parts.push(header);
    parts.push(dataBuf);

    fileEntries.push({
      nameBuf,
      crc,
      size,
      offset,
      dosTime,
      dosDate
    });

    offset += header.length + dataBuf.length;
  }

  const centralDirStart = offset;
  let centralDirSize = 0;

  for (const entry of fileEntries) {
    // Central directory header (46 bytes + name length)
    const cdHeader = Buffer.alloc(46 + entry.nameBuf.length);
    cdHeader.writeUInt32LE(0x02014b50, 0); // signature
    cdHeader.writeUInt16LE(20, 4);          // version made by
    cdHeader.writeUInt16LE(20, 6);          // version needed
    cdHeader.writeUInt16LE(0x0800, 8);       // flags (bit 11 = UTF-8)
    cdHeader.writeUInt16LE(0, 10);           // compression method
    cdHeader.writeUInt16LE(entry.dosTime, 12); // time
    cdHeader.writeUInt16LE(entry.dosDate, 14); // date
    cdHeader.writeUInt32LE(entry.crc, 16);     // crc-32
    cdHeader.writeUInt32LE(entry.size, 20);    // compressed size
    cdHeader.writeUInt32LE(entry.size, 24);    // uncompressed size
    cdHeader.writeUInt16LE(entry.nameBuf.length, 28); // file name length
    cdHeader.writeUInt16LE(0, 30);           // extra field length
    cdHeader.writeUInt16LE(0, 32);           // comment length
    cdHeader.writeUInt16LE(0, 34);           // disk number start
    cdHeader.writeUInt16LE(0, 36);           // internal file attributes
    cdHeader.writeUInt32LE(0x81a40000, 38);  // external file attributes (regular file rw-r--r--)
    cdHeader.writeUInt32LE(entry.offset, 42); // relative offset of local header
    entry.nameBuf.copy(cdHeader, 46);

    parts.push(cdHeader);
    centralDirSize += cdHeader.length;
  }

  // End of central directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4);          // disk number
  eocd.writeUInt16LE(0, 6);          // disk with start of central directory
  eocd.writeUInt16LE(fileEntries.length, 8);  // total entries on this disk
  eocd.writeUInt16LE(fileEntries.length, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12);     // size of central directory
  eocd.writeUInt32LE(centralDirStart, 16);    // offset of start of central directory
  eocd.writeUInt16LE(0, 20);                  // zip file comment length

  parts.push(eocd);
  return Buffer.concat(parts);
}
