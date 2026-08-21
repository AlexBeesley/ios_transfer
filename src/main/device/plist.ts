/**
 * Minimal property-list codec.
 *
 * usbmuxd and lockdownd both speak XML plists; pair records and some service
 * replies come back as binary plists, so both readers live here. Written by
 * hand rather than pulled from npm because the subset in play is small and the
 * protocol layer is worth keeping dependency-free.
 */

export type PlistValue =
  | string
  | number
  | boolean
  | Buffer
  | Date
  | PlistValue[]
  | { [key: string]: PlistValue };

export type PlistDict = { [key: string]: PlistValue };

/* --------------------------------------------------------------- XML reader */

function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    switch (e) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return m;
    }
  });
}

interface Tag {
  name: string;
  close: boolean;
  selfClose: boolean;
}

class XmlPlistReader {
  private pos = 0;

  constructor(private readonly src: string) {}

  parse(): PlistValue {
    const start = this.src.indexOf('<plist');
    this.pos = start >= 0 ? this.src.indexOf('>', start) + 1 : 0;
    return this.value();
  }

  private peek(): Tag | null {
    for (;;) {
      while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
      if (this.src.startsWith('<!--', this.pos)) {
        const end = this.src.indexOf('-->', this.pos);
        if (end === -1) return null;
        this.pos = end + 3;
        continue;
      }
      if (this.src.startsWith('<?', this.pos) || this.src.startsWith('<!', this.pos)) {
        const end = this.src.indexOf('>', this.pos);
        if (end === -1) return null;
        this.pos = end + 1;
        continue;
      }
      break;
    }
    if (this.pos >= this.src.length || this.src[this.pos] !== '<') return null;
    const end = this.src.indexOf('>', this.pos);
    if (end === -1) return null;
    let raw = this.src.slice(this.pos + 1, end);
    const close = raw[0] === '/';
    if (close) raw = raw.slice(1);
    const selfClose = raw.endsWith('/');
    if (selfClose) raw = raw.slice(0, -1);
    return { name: raw.split(/[\s/]/)[0], close, selfClose };
  }

  private consume(): void {
    this.pos = this.src.indexOf('>', this.pos) + 1;
  }

  private textUntil(name: string): string {
    const marker = '</' + name + '>';
    const idx = this.src.indexOf(marker, this.pos);
    if (idx === -1) throw new Error('plist: unterminated <' + name + '>');
    const text = this.src.slice(this.pos, idx);
    this.pos = idx + marker.length;
    return text;
  }

  private value(): PlistValue {
    const tag = this.peek();
    if (!tag) throw new Error('plist: unexpected end of document');
    if (tag.close) throw new Error('plist: unexpected closing tag ' + tag.name);
    this.consume();

    switch (tag.name) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'dict': {
        const out: PlistDict = {};
        if (tag.selfClose) return out;
        for (;;) {
          const next = this.peek();
          if (!next) throw new Error('plist: unterminated dict');
          if (next.close && next.name === 'dict') {
            this.consume();
            return out;
          }
          if (next.name !== 'key') throw new Error('plist: expected key, saw ' + next.name);
          this.consume();
          const key = next.selfClose ? '' : decodeEntities(this.textUntil('key'));
          out[key] = this.value();
        }
      }
      case 'array': {
        const out: PlistValue[] = [];
        if (tag.selfClose) return out;
        for (;;) {
          const next = this.peek();
          if (!next) throw new Error('plist: unterminated array');
          if (next.close && next.name === 'array') {
            this.consume();
            return out;
          }
          out.push(this.value());
        }
      }
      case 'string':
        return tag.selfClose ? '' : decodeEntities(this.textUntil('string'));
      case 'integer':
        return tag.selfClose ? 0 : parseInt(this.textUntil('integer').trim(), 10);
      case 'real':
        return tag.selfClose ? 0 : parseFloat(this.textUntil('real').trim());
      case 'data':
        return tag.selfClose
          ? Buffer.alloc(0)
          : Buffer.from(this.textUntil('data').replace(/\s+/g, ''), 'base64');
      case 'date':
        return tag.selfClose ? new Date(0) : new Date(this.textUntil('date').trim());
      default:
        if (!tag.selfClose) this.textUntil(tag.name);
        return '';
    }
  }
}

/* ------------------------------------------------------------ binary reader */

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

class BinaryPlistReader {
  private offsetSize = 1;
  private refSize = 1;
  private offsets: number[] = [];

  constructor(private readonly buf: Buffer) {}

  parse(): PlistValue {
    const buf = this.buf;
    if (buf.length < 40) throw new Error('bplist: too short');
    const trailer = buf.length - 32;
    this.offsetSize = buf.readUInt8(trailer + 6);
    this.refSize = buf.readUInt8(trailer + 7);
    const count = Number(buf.readBigUInt64BE(trailer + 8));
    const top = Number(buf.readBigUInt64BE(trailer + 16));
    const tableStart = Number(buf.readBigUInt64BE(trailer + 24));

    this.offsets = new Array(count);
    for (let i = 0; i < count; i++) {
      this.offsets[i] = this.readSized(tableStart + i * this.offsetSize, this.offsetSize);
    }
    return this.object(top);
  }

  private readSized(at: number, size: number): number {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + this.buf.readUInt8(at + i);
    return v;
  }

  /** Object lengths are either packed into the marker nibble or follow as an int. */
  private lengthAt(pos: number, low: number): { length: number; next: number } {
    if (low !== 0x0f) return { length: low, next: pos + 1 };
    const marker = this.buf.readUInt8(pos + 1);
    const bytes = 1 << (marker & 0x0f);
    return { length: this.readSized(pos + 2, bytes), next: pos + 2 + bytes };
  }

  private object(index: number): PlistValue {
    const pos = this.offsets[index];
    const marker = this.buf.readUInt8(pos);
    const high = marker >> 4;
    const low = marker & 0x0f;

    switch (high) {
      case 0x0:
        if (low === 0x08) return false;
        if (low === 0x09) return true;
        return '';
      case 0x1: {
        const bytes = 1 << low;
        if (bytes === 8) return Number(this.buf.readBigInt64BE(pos + 1));
        return this.readSized(pos + 1, bytes);
      }
      case 0x2:
        return (1 << low) === 4 ? this.buf.readFloatBE(pos + 1) : this.buf.readDoubleBE(pos + 1);
      case 0x3:
        return new Date(APPLE_EPOCH_MS + this.buf.readDoubleBE(pos + 1) * 1000);
      case 0x4: {
        const { length, next } = this.lengthAt(pos, low);
        return this.buf.subarray(next, next + length);
      }
      case 0x5: {
        const { length, next } = this.lengthAt(pos, low);
        return this.buf.toString('ascii', next, next + length);
      }
      case 0x6: {
        const { length, next } = this.lengthAt(pos, low);
        return Buffer.from(this.buf.subarray(next, next + length * 2)).swap16().toString('utf16le');
      }
      case 0x8:
        return this.readSized(pos + 1, low + 1);
      case 0xa:
      case 0xc: {
        const { length, next } = this.lengthAt(pos, low);
        const out: PlistValue[] = [];
        for (let i = 0; i < length; i++) {
          out.push(this.object(this.readSized(next + i * this.refSize, this.refSize)));
        }
        return out;
      }
      case 0xd: {
        const { length, next } = this.lengthAt(pos, low);
        const out: PlistDict = {};
        for (let i = 0; i < length; i++) {
          const key = this.object(this.readSized(next + i * this.refSize, this.refSize));
          const val = this.object(this.readSized(next + (length + i) * this.refSize, this.refSize));
          out[String(key)] = val;
        }
        return out;
      }
      default:
        throw new Error('bplist: unsupported marker 0x' + marker.toString(16));
    }
  }
}

/* -------------------------------------------------------------------- public */

export function parsePlist(input: Buffer | string): PlistValue {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  if (buf.length >= 8 && buf.toString('ascii', 0, 8) === 'bplist00') {
    return new BinaryPlistReader(buf).parse();
  }
  return new XmlPlistReader(buf.toString('utf8')).parse();
}

export function parsePlistDict(input: Buffer | string): PlistDict {
  const v = parsePlist(input);
  if (typeof v !== 'object' || v === null || Array.isArray(v) || Buffer.isBuffer(v)) {
    throw new Error('plist: expected a dictionary at the root');
  }
  return v as PlistDict;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

function encodeValue(value: PlistValue, out: string[]): void {
  if (typeof value === 'string') {
    out.push('<string>' + escapeXml(value) + '</string>');
  } else if (typeof value === 'boolean') {
    out.push(value ? '<true/>' : '<false/>');
  } else if (typeof value === 'number') {
    out.push(
      Number.isInteger(value) ? '<integer>' + value + '</integer>' : '<real>' + value + '</real>',
    );
  } else if (Buffer.isBuffer(value)) {
    out.push('<data>' + value.toString('base64') + '</data>');
  } else if (value instanceof Date) {
    out.push('<date>' + value.toISOString().replace(/\.\d+Z$/, 'Z') + '</date>');
  } else if (Array.isArray(value)) {
    out.push('<array>');
    for (const item of value) encodeValue(item, out);
    out.push('</array>');
  } else {
    out.push('<dict>');
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out.push('<key>' + escapeXml(k) + '</key>');
      encodeValue(v, out);
    }
    out.push('</dict>');
  }
}

export function buildPlist(value: PlistValue): Buffer {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
  ];
  encodeValue(value, out);
  out.push('</plist>');
  return Buffer.from(out.join(''), 'utf8');
}
