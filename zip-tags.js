(() => {
  'use strict';
  const MAX = 256 * 1024 * 1024, decoder = new TextDecoder('utf-8', {fatal: true});
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let n = i; for (let j = 0; j < 8; j++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; table[i] = n >>> 0; }
  function crc(bytes) { let n = 0xffffffff; for (const byte of bytes) n = table[(n ^ byte) & 255] ^ n >>> 8; return (n ^ 0xffffffff) >>> 0; }
  const isZip = value => { const b = new Uint8Array(value); return b.length >= 4 && b[0] === 80 && b[1] === 75 && b[2] === 3 && b[3] === 4; };
  function edition(name) {
    const stem = name.split('/').at(-1).replace(/\.(mp3|wav|flac)$/i,'').normalize('NFKC').trim();
    const match = stem.match(/^(.*?)[\s_-]+[([]?\s*(Extended(?:[\s_-]+(?:Mix|Edit|Version))?|Original[\s_-]+(?:Mix|Edit|Version))\s*[)\]]?$/i);
    return match && match[1].trim() ? {stem:match[1].trim().toLowerCase(), version:match[2].replace(/[_-]+/g,' ').replace(/\s+/g,' ')} : {stem:stem.toLowerCase(),version:''};
  }
  function inspect(value) {
    const bytes = new Uint8Array(value), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fail = () => { throw Error('ZIPの構造が未対応または破損しているため、元のZIPを保持しました。'); };
    if (!isZip(bytes)) fail();
    let end = -1;
    for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) if (view.getUint32(p, true) === 0x06054b50 && p + 22 + view.getUint16(p + 20, true) === bytes.length) { end = p; break; }
    if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) fail();
    const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true);
    if (!count || count > 1000 || count !== view.getUint16(end + 8, true) || offset + size !== end) fail();
    const entries = []; let p = offset, total = 0; const ranges = [];
    for (let i = 0; i < count; i++) {
      if (p + 46 > end || view.getUint32(p, true) !== 0x02014b50) fail();
      const flags = view.getUint16(p + 8, true), method = view.getUint16(p + 10, true), compressed = view.getUint32(p + 20, true), unpacked = view.getUint32(p + 24, true);
      const nameSize = view.getUint16(p + 28, true), extraSize = view.getUint16(p + 30, true), commentSize = view.getUint16(p + 32, true), local = view.getUint32(p + 42, true);
      if (flags & 0x2041 || ![0, 8].includes(method) || [compressed, unpacked, local].includes(0xffffffff) || view.getUint16(p + 34, true) || p + 46 + nameSize + extraSize + commentSize > end) fail();
      total += unpacked; if (total > MAX) throw Error('ZIPの展開後サイズが256MBを超えるため、元のZIPを保持しました。');
      const nameBytes = bytes.subarray(p + 46, p + 46 + nameSize);
      let name;
      try { name = decoder.decode(nameBytes); } catch { throw Error('ZIP内のファイル名の文字コードが未対応のため、元のZIPを保持しました。'); }
      if (!name || name.includes('\\') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(part => part === '..' || part === '.') || /[\x00-\x1f]/.test(name)) fail();
      if (local + 30 > offset || view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method) fail();
      const localName = view.getUint16(local + 26, true), data = local + 30 + localName + view.getUint16(local + 28, true);
      if (localName !== nameSize || data + compressed > offset || !nameBytes.every((byte, j) => byte === bytes[local + 30 + j])) fail();
      ranges.push([local, data + compressed]);
      const audio = !name.startsWith('__MACOSX/') && !name.split('/').at(-1).startsWith('._') && name.match(/\.(mp3|wav|flac)$/i)?.[1].toLowerCase();
      entries.push({name, nameBytes, audio, flags, method, compressed, unpacked, crc: view.getUint32(p + 16, true), data,
        central: bytes.slice(p, p + 46 + nameSize + extraSize + commentSize), local: bytes.slice(local, data), content: bytes.subarray(data, data + compressed)});
      p += 46 + nameSize + extraSize + commentSize;
    }
    ranges.sort((a, b) => a[0] - b[0]);
    if (p !== end || ranges[0][0] !== 0 || ranges.some((range, i) => i && range[0] < ranges[i - 1][1])) fail();
    const audio = entries.filter(entry => entry.audio);
    for (const entry of audio) entry.edition = edition(entry.name);
    const stems = new Set(audio.map(entry => entry.edition.stem));
    if (!audio.length) throw Error('ZIP内にMP3・WAV・FLACがないため、元のZIPを保持しました。');
    if (stems.size !== 1) throw Error('ZIP内に複数の曲名があるため、自動タグ付けせず元のZIPを保持しました。');
    return {entries, audio, footer: bytes.slice(end)};
  }
  async function inflate(entry) {
    let bytes;
    if (entry.method === 0) bytes = entry.content;
    else {
      const reader = new Blob([entry.content]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader(), chunks = []; let size = 0;
      try {
        while (true) { const {value, done} = await reader.read(); if (done) break; size += value.length;
          if (size > entry.unpacked || size > MAX) throw Error('ZIPの展開サイズが一致しません。'); chunks.push(value); }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      bytes = new Uint8Array(size); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    }
    if (bytes.length !== entry.unpacked || crc(bytes) !== entry.crc) throw Error('ZIP内の音声の整合性を確認できないため、元のZIPを保持しました。');
    return bytes;
  }
  function join(parts) { const size = parts.reduce((sum, part) => sum + part.length, 0), output = new Uint8Array(size); let at = 0; for (const part of parts) { output.set(part, at); at += part.length; } return output; }
  async function write(value, fields, getArtwork) {
    const plan = inspect(value), locals = [], centrals = [], names = new Set(plan.entries.filter(entry => !entry.audio).map(entry => entry.name.toLowerCase())); let offset = 0;
    for (const entry of plan.entries) {
      let local = entry.local, content = entry.content, central = entry.central;
      if (entry.audio) {
        const original = await inflate(entry), type = SCHAudioTags.format(original);
        if (type !== entry.audio) throw Error('ZIP内の拡張子と音声形式が一致しないため、元のZIPを保持しました。');
        const cover = getArtwork && !SCHAudioTags.hasArtwork(original, type) ? await getArtwork() : null;
        const version = entry.edition.version, title = version && !fields.title.toLowerCase().includes(version.toLowerCase()) ? fields.title+' ('+version+')' : fields.title;
        content = new Uint8Array(SCHAudioTags.write(original, {...fields,title}, cover, type));
        const folder = entry.name.slice(0, entry.name.lastIndexOf('/') + 1), base = SCHAudioTags.filename(title, type); let name = folder + base, suffix = 1;
        while (names.has(name.toLowerCase())) name = folder + base.slice(0, -type.length - 1).slice(0, 140) + ' (' + ++suffix + ').' + type;
        names.add(name.toLowerCase()); const encoded = new TextEncoder().encode(name);
        // Store rewritten audio without compression. Other entries keep their original compressed bytes.
        local = new Uint8Array(30 + encoded.length); const header = new DataView(local.buffer), originalHeader = new DataView(entry.local.buffer);
        header.setUint32(0, 0x04034b50, true); header.setUint16(4, 20, true); header.setUint16(6, 0x800, true);
        header.setUint16(10, originalHeader.getUint16(10, true), true); header.setUint16(12, originalHeader.getUint16(12, true), true);
        const checksum = crc(content); header.setUint32(14, checksum, true); header.setUint32(18, content.length, true); header.setUint32(22, content.length, true); header.setUint16(26, encoded.length, true); local.set(encoded, 30);
        // Retain timestamps, attributes and comments; name-dependent extras are not copied to renamed audio.
        const old = new DataView(entry.central.buffer), commentSize = old.getUint16(32, true);
        central = new Uint8Array(46 + encoded.length + commentSize); central.set(entry.central.subarray(0, 46)); central.set(encoded, 46); central.set(entry.central.subarray(entry.central.length - commentSize), 46 + encoded.length);
        const header2 = new DataView(central.buffer); header2.setUint16(6, 20, true); header2.setUint16(8, 0x800, true); header2.setUint16(10, 0, true);
        header2.setUint32(16, checksum, true); header2.setUint32(20, content.length, true); header2.setUint32(24, content.length, true); header2.setUint16(28, encoded.length, true); header2.setUint16(30, 0, true);
      } else if (entry.flags & 8) {
        // Convert descriptor-based entries to ordinary known-size local headers too.
        local = local.slice(); const header = new DataView(local.buffer); header.setUint16(6, entry.flags & ~8, true); header.setUint32(14, entry.crc, true); header.setUint32(18, entry.compressed, true); header.setUint32(22, entry.unpacked, true);
        new DataView(central.buffer).setUint16(8, entry.flags & ~8, true);
      }
      new DataView(central.buffer).setUint32(42, offset, true); locals.push(local, content); centrals.push(central); offset += local.length + content.length;
    }
    const footer = plan.footer.slice(), header = new DataView(footer.buffer); header.setUint32(12, centrals.reduce((sum, part) => sum + part.length, 0), true); header.setUint32(16, offset, true);
    return {output: join([...locals, ...centrals, footer]), count: plan.audio.length};
  }
  globalThis.SCHZipTags = Object.freeze({isZip, inspect, write});
})();
