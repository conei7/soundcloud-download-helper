(() => {
  'use strict';
  const encoder = new TextEncoder();
  const V22 = {TIT2: 'TT2', TPE1: 'TP1', TALB: 'TAL', TCON: 'TCO', TYER: 'TYE', TBPM: 'TBP', WOAS: 'WAS', APIC: 'PIC'};
  const bytes = value => value instanceof Uint8Array ? value : new Uint8Array(value);
  const ascii = (value, start = 0, length = value.length - start) => String.fromCharCode(...value.subarray(start, start + length));
  const join = parts => {
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    parts.forEach(part => { output.set(part, offset); offset += part.length; });
    return output;
  };
  const number = (value, little = false) => {
    const output = new Uint8Array(4);
    new DataView(output.buffer).setUint32(0, value, little);
    return output;
  };
  const readNumber = (value, offset, little = false) => new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(offset, little);
  const sync = value => new Uint8Array([(value >>> 21) & 127, (value >>> 14) & 127, (value >>> 7) & 127, value & 127]);
  const readSync = (value, offset) => {
    const group = value.subarray(offset, offset + 4);
    if (group.length !== 4 || group.some(item => item > 127)) throw Error('Invalid ID3 length');
    return group.reduce((sum, item) => sum * 128 + item, 0);
  };
  const range = (value, start, length) => {
    if (start < 0 || length < 0 || start + length > value.length) throw Error('Truncated audio metadata');
    return value.subarray(start, start + length);
  };
  function format(value, mime = '') {
    value = bytes(value);
    if (ascii(value, 0, 4) === 'RIFF' && ascii(value, 8, 4) === 'WAVE') return 'wav';
    if (ascii(value, 0, 4) === 'fLaC') return 'flac';
    if (ascii(value, 0, 3) === 'ID3') return 'mp3';
    // MPEG audio requires valid layer/version bits; do not mistake an AAC ADTS header for MP3.
    if (value.length >= 2 && value[0] === 255 && (value[1] & 224) === 224 && (value[1] & 6) === 2 && (value[1] & 24) !== 8) return 'mp3';
    return 'other';
  }
  function id3(value) {
    if (ascii(value, 0, 3) !== 'ID3') return {version: 3, frames: [], end: 0};
    range(value, 0, 10);
    const version = value[3], flags = value[5];
    // Preserve unsupported tags intact by falling back to the original file, rather than guessing.
    if (![2, 3, 4].includes(version) || flags !== 0) throw Error('Unsupported ID3 version/flags');
    const end = 10 + readSync(value, 6);
    range(value, 0, end);
    const frames = [];
    let offset = 10;
    const headerSize = version === 2 ? 6 : 10;
    while (offset + headerSize <= end && value[offset]) {
      const frameName = ascii(value, offset, version === 2 ? 3 : 4);
      if (!(version === 2 ? /^[A-Z0-9]{3}$/ : /^[A-Z0-9]{4}$/).test(frameName)) throw Error('Invalid ID3 frame');
      const length = version === 2 ? value[offset + 3] * 65536 + value[offset + 4] * 256 + value[offset + 5] :
        version === 4 ? readSync(value, offset + 4) : readNumber(value, offset + 4);
      if (offset + headerSize + length > end) throw Error('Invalid ID3 frame length');
      const name = version === 2 ? Object.keys(V22).find(key => V22[key] === frameName) || frameName : frameName;
      const raw = range(value, offset, headerSize + length);
      frames.push({name, raw, data: raw.subarray(headerSize)});
      offset += headerSize + length;
    }
    return {version, frames, end};
  }
  function textFrame(name, text, version) {
    // ID3v2.3 uses UTF-16 with BOM; v2.4 also supports UTF-8.
    let payload;
    if (version === 4) payload = join([new Uint8Array([3]), encoder.encode(text), new Uint8Array([0])]);
    else {
      const utf16 = new Uint8Array(text.length * 2);
      const view = new DataView(utf16.buffer);
      for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
      payload = join([new Uint8Array([1, 255, 254]), utf16, new Uint8Array(2)]);
    }
    return frame(name, payload, version);
  }
  function frame(name, payload, version) {
    if (version === 2) {
      if (!V22[name] || payload.length >= 16777216) throw Error('Invalid ID3v2.2 frame');
      return join([encoder.encode(V22[name]), new Uint8Array([payload.length >>> 16, payload.length >>> 8 & 255, payload.length & 255]), payload]);
    }
    return join([encoder.encode(name), version === 4 ? sync(payload.length) : number(payload.length), new Uint8Array(2), payload]);
  }
  function buildId3(value, fields, artwork) {
    const existing = id3(value), frames = existing.frames.filter(item => item.name !== 'TIT2').map(item => item.raw);
    const add = (name, text) => {
      const old = existing.frames.find(item => item.name === name);
      if (text && (!old || !old.data.subarray(1).some(item => item !== 0 && item !== 255 && item !== 254))) {
        if (old) {
          const index = frames.indexOf(old.raw);
          if (index >= 0) frames.splice(index, 1);
        }
        frames.push(textFrame(name, String(text), existing.version));
      }
    };
    if (fields.title) frames.push(textFrame('TIT2', fields.title, existing.version));
    add('TPE1', fields.artist); add('TALB', fields.album); add('TCON', fields.genre);
    add(existing.version === 4 ? 'TDRC' : 'TYER', fields.year); add('TBPM', fields.bpm);
    if (fields.url && !existing.frames.some(item => item.name === 'WOAS')) frames.push(frame('WOAS', encoder.encode(fields.url), existing.version));
    if (artwork && !existing.frames.some(item => item.name === 'APIC')) {
      const picture = existing.version === 2 ? join([new Uint8Array([0]), encoder.encode(artwork.mime === 'image/png' ? 'PNG' : 'JPG'), new Uint8Array([3, 0]), bytes(artwork.data)]) :
        join([new Uint8Array([0]), encoder.encode(artwork.mime), new Uint8Array([0, 3, 0]), bytes(artwork.data)]);
      frames.push(frame('APIC', picture, existing.version));
    }
    const body = join([...frames, new Uint8Array(256)]);
    if (body.length >= 268435456) throw Error('ID3 tag too large');
    return {tag: join([encoder.encode('ID3'), new Uint8Array([existing.version, 0, 0]), sync(body.length), body]), end: existing.end};
  }
  function riffChunks(value, start = 12, end = value.length) {
    const chunks = [];
    let offset = start;
    while (offset + 8 <= end) {
      const length = readNumber(value, offset + 4, true);
      const raw = range(value, offset, 8 + length + (length % 2));
      if (offset + raw.length > end) throw Error('Invalid RIFF chunk');
      chunks.push({name: ascii(raw, 0, 4), raw, data: raw.subarray(8, 8 + length)});
      offset += raw.length;
    }
    if (offset !== end) throw Error('Invalid RIFF boundary');
    return chunks;
  }
  const riffChunk = (name, data) => join([encoder.encode(name), number(data.length, true), data, new Uint8Array(data.length % 2)]);
  function wav(value, fields, artwork) {
    const end = readNumber(value, 4, true) + 8;
    if (end !== value.length) throw Error('Unsupported WAV size');
    const chunks = riffChunks(value, 12, end);
    if (!chunks.some(item => item.name === 'data')) throw Error('Missing WAV audio');
    const info = chunks.find(item => item.name === 'LIST' && ascii(item.data, 0, 4) === 'INFO');
    const entries = info ? riffChunks(info.data, 4) : [];
    const nextInfo = entries.filter(item => item.name !== 'INAM').map(item => item.raw);
    if (fields.title) nextInfo.push(riffChunk('INAM', encoder.encode(fields.title + '\0')));
    for (const [name, text] of [['IART', fields.artist], ['IPRD', fields.album], ['IGNR', fields.genre], ['ICRD', fields.year]]) {
      const old = entries.find(item => item.name === name);
      if (text && (!old || !old.data.some(item => item !== 0))) {
        if (old) nextInfo.splice(nextInfo.indexOf(old.raw), 1);
        nextInfo.push(riffChunk(name, encoder.encode(String(text) + '\0')));
      }
    }
    const oldId3 = chunks.find(item => item.name.toLowerCase() === 'id3 ');
    const infoText = name => {
      const item = entries.find(entry => entry.name === name);
      return item ? new TextDecoder().decode(item.data).replace(/\0+$/, '') : '';
    };
    const resolved = {...fields, artist: infoText('IART') || fields.artist, album: infoText('IPRD') || fields.album,
      genre: infoText('IGNR') || fields.genre, year: infoText('ICRD') || fields.year};
    const tag = buildId3(oldId3?.data || new Uint8Array(), resolved, artwork).tag;
    const inserted = [riffChunk('LIST', join([encoder.encode('INFO'), ...nextInfo])), riffChunk('id3 ', tag)];
    const kept = chunks.filter(item => item !== info && item !== oldId3);
    const output = [];
    kept.forEach(item => { if (item.name === 'data') output.push(...inserted); output.push(item.raw); });
    const body = join([encoder.encode('WAVE'), ...output]);
    if (body.length > 4294967295) throw Error('WAV too large');
    return join([encoder.encode('RIFF'), number(body.length, true), body]);
  }
  function flacBlocks(value) {
    let offset = 4, last = false;
    const blocks = [];
    while (!last) {
      const header = range(value, offset, 4);
      const length = header[1] * 65536 + header[2] * 256 + header[3];
      const raw = range(value, offset, 4 + length);
      blocks.push({type: header[0] & 127, raw, data: raw.subarray(4)});
      last = !!(header[0] & 128); offset += raw.length;
    }
    if (blocks[0]?.type !== 0 || blocks[0].data.length !== 34) throw Error('Invalid FLAC STREAMINFO');
    return {blocks, end: offset};
  }
  const flacBlock = (type, data) => {
    if (data.length >= 16777216) throw Error('FLAC block too large');
    return join([new Uint8Array([type, data.length >>> 16, (data.length >>> 8) & 255, data.length & 255]), data]);
  };
  function comments(data) {
    const vendorLength = readNumber(data, 0, true), vendor = range(data, 4, vendorLength);
    let offset = 4 + vendorLength;
    const count = readNumber(data, offset, true), values = []; offset += 4;
    if (count > 100000) throw Error('Invalid FLAC comment count');
    for (let i = 0; i < count; i++) {
      const length = readNumber(data, offset, true); offset += 4;
      values.push(new TextDecoder().decode(range(data, offset, length))); offset += length;
    }
    return {vendor, values};
  }
  function flac(value, fields, artwork) {
    const {blocks, end} = flacBlocks(value);
    const old = blocks.find(item => item.type === 4);
    const existing = old ? comments(old.data) : {vendor: encoder.encode('SoundCloudHighlight'), values: []};
    const values = existing.values.filter(text => !/^TITLE=/i.test(text));
    if (fields.title) values.push('TITLE=' + fields.title);
    for (const [name, text] of [['ARTIST', fields.artist], ['ALBUM', fields.album], ['GENRE', fields.genre], ['DATE', fields.year], ['BPM', fields.bpm], ['SOURCE', fields.url]]) {
      if (text && !values.some(item => item.slice(0, name.length + 1).toUpperCase() === name + '=' && item.slice(name.length + 1).trim())) {
        values.push(name + '=' + text);
      }
    }
    const parts = [number(existing.vendor.length, true), existing.vendor, number(values.length, true)];
    values.forEach(text => { const encoded = encoder.encode(text); parts.push(number(encoded.length, true), encoded); });
    const commentBlock = flacBlock(4, join(parts));
    const output = [blocks[0].raw.slice(), commentBlock, ...blocks.slice(1).filter(item => item.type !== 4).map(item => item.raw.slice())];
    if (artwork && !blocks.some(item => item.type === 6)) {
      const mime = encoder.encode(artwork.mime), picture = bytes(artwork.data);
      output.push(flacBlock(6, join([number(3), number(mime.length), mime, number(0), number(artwork.width || 0), number(artwork.height || 0), number(24), number(0), number(picture.length), picture])));
    }
    output.forEach((item, i) => { item[0] = (item[0] & 127) | (i === output.length - 1 ? 128 : 0); });
    return join([encoder.encode('fLaC'), ...output, value.subarray(end)]);
  }
  function hasArtwork(value, type) {
    value = bytes(value);
    if (type === 'mp3') return id3(value).frames.some(item => item.name === 'APIC');
    if (type === 'flac') return flacBlocks(value).blocks.some(item => item.type === 6);
    if (type === 'wav') {
      const tag = riffChunks(value).find(item => item.name.toLowerCase() === 'id3 ');
      return !!tag && id3(tag.data).frames.some(item => item.name === 'APIC');
    }
    return false;
  }
  function write(value, fields, artwork, type = format(value)) {
    value = bytes(value);
    if (type === 'mp3') { const result = buildId3(value, fields, artwork); return join([result.tag, value.subarray(result.end)]).buffer; }
    if (type === 'wav') return wav(value, fields, artwork).buffer;
    if (type === 'flac') return flac(value, fields, artwork).buffer;
    throw Error('Unsupported audio format');
  }
  function filename(title, extension) {
    let stem = String(title || 'track').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '');
    let shortened = '';
    for (const character of stem) { if (shortened.length + character.length > 160) break; shortened += character; }
    stem = shortened;
    if (!stem || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(stem)) stem = '_' + (stem || 'track');
    return stem + '.' + (/^[a-z0-9]{1,8}$/i.test(extension) ? extension : 'bin');
  }
  globalThis.SCHAudioTags = Object.freeze({format, write, hasArtwork, filename});
})();
