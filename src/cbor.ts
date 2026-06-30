// Minimal CBOR writer/reader, owned so taker-fill bytes are exactly reproducible.
// Scope: the subset Cardano uses — major types 0-6, indefinite arrays/byte-strings,
// bignum tags (2/3), and the Plutus constructor tags. No floats.

const POW64 = 1n << 64n;

function bigToMinimalBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array([0]);
  const out: number[] = [];
  let v = n;
  while (v > 0n) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return new Uint8Array(out);
}

export class CborWriter {
  private chunks: number[] = [];

  bytesOut(): Uint8Array {
    return new Uint8Array(this.chunks);
  }

  pushByte(b: number): this {
    this.chunks.push(b & 0xff);
    return this;
  }

  pushBytes(b: Uint8Array): this {
    for (const x of b) this.chunks.push(x);
    return this;
  }

  // header = (major << 5) | argument, with minimal-length argument encoding.
  writeHead(major: number, arg: bigint): this {
    const m = major << 5;
    if (arg < 24n) {
      this.pushByte(m | Number(arg));
    } else if (arg < 0x100n) {
      this.pushByte(m | 24).pushByte(Number(arg));
    } else if (arg < 0x10000n) {
      this.pushByte(m | 25);
      this.pushByte(Number((arg >> 8n) & 0xffn)).pushByte(Number(arg & 0xffn));
    } else if (arg < 0x100000000n) {
      this.pushByte(m | 26);
      for (let s = 24n; s >= 0n; s -= 8n) this.pushByte(Number((arg >> s) & 0xffn));
    } else if (arg < POW64) {
      this.pushByte(m | 27);
      for (let s = 56n; s >= 0n; s -= 8n) this.pushByte(Number((arg >> s) & 0xffn));
    } else {
      throw new Error("argument exceeds uint64; use a bignum tag");
    }
    return this;
  }

  writeUint(n: bigint): this {
    if (n < 0n) throw new Error("writeUint negative");
    if (n < POW64) return this.writeHead(0, n);
    // positive bignum: tag 2 + byte-string
    return this.writeTag(2n).writeByteString(bigToMinimalBytes(n));
  }

  writeInt(n: bigint): this {
    if (n >= 0n) return this.writeUint(n);
    const m = -1n - n;
    if (m < POW64) return this.writeHead(1, m);
    // negative bignum: tag 3 + byte-string of (-1-n)
    return this.writeTag(3n).writeByteString(bigToMinimalBytes(m));
  }

  // Byte strings >64 bytes are chunked as an indefinite-length byte string of
  // <=64-byte definite chunks (the Plutus on-chain convention). <=64 = single chunk.
  writeByteString(b: Uint8Array): this {
    if (b.length <= 64) {
      this.writeHead(2, BigInt(b.length)).pushBytes(b);
      return this;
    }
    this.pushByte(0x5f); // indefinite byte string
    for (let i = 0; i < b.length; i += 64) {
      const chunk = b.subarray(i, Math.min(i + 64, b.length));
      this.writeHead(2, BigInt(chunk.length)).pushBytes(chunk);
    }
    this.pushByte(0xff);
    return this;
  }

  beginArrayIndef(): this {
    return this.pushByte(0x9f);
  }
  endIndef(): this {
    return this.pushByte(0xff);
  }
  writeArrayDef(len: number): this {
    return this.writeHead(4, BigInt(len));
  }
  writeMapDef(len: number): this {
    return this.writeHead(5, BigInt(len));
  }
  writeTag(t: bigint): this {
    return this.writeHead(6, t);
  }
}

export type CborValue =
  | { t: "uint"; v: bigint }
  | { t: "nint"; v: bigint }
  | { t: "bytes"; v: Uint8Array }
  | { t: "text"; v: string }
  | { t: "array"; v: CborValue[] }
  | { t: "map"; v: [CborValue, CborValue][] }
  | { t: "tag"; tag: bigint; v: CborValue }
  | { t: "simple"; v: number } // bool/null/undefined/simple (major 7)
  | { t: "float"; v: number };

export class CborReader {
  private pos = 0;
  constructor(private buf: Uint8Array) {}

  get offset(): number {
    return this.pos;
  }
  atEnd(): boolean {
    return this.pos >= this.buf.length;
  }

  private u8(): number {
    if (this.pos >= this.buf.length) throw new Error("CBOR: unexpected end");
    return this.buf[this.pos++]!;
  }

  private readArg(info: number): bigint {
    if (info < 24) return BigInt(info);
    if (info === 24) return BigInt(this.u8());
    if (info === 25) {
      let v = 0n;
      for (let i = 0; i < 2; i++) v = (v << 8n) | BigInt(this.u8());
      return v;
    }
    if (info === 26) {
      let v = 0n;
      for (let i = 0; i < 4; i++) v = (v << 8n) | BigInt(this.u8());
      return v;
    }
    if (info === 27) {
      let v = 0n;
      for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(this.u8());
      return v;
    }
    throw new Error(`CBOR: bad additional-info ${info}`);
  }

  private bytesToBig(b: Uint8Array): bigint {
    let v = 0n;
    for (const x of b) v = (v << 8n) | BigInt(x);
    return v;
  }

  /** Read a definite array header, returning its length. Throws if not an array. */
  readArrayHeader(): number {
    const ib = this.u8();
    if (ib >> 5 !== 4 || (ib & 0x1f) === 31) throw new Error("expected definite array header");
    return Number(this.readArg(ib & 0x1f));
  }

  /** Read a definite map header, returning its entry count. Throws if not a map. */
  readMapHeader(): number {
    const ib = this.u8();
    if (ib >> 5 !== 5 || (ib & 0x1f) === 31) throw new Error("expected definite map header");
    return Number(this.readArg(ib & 0x1f));
  }

  /** Decode one item and also return the exact raw bytes it occupied. */
  decodeTracked(): { value: CborValue; raw: Uint8Array } {
    const start = this.pos;
    const value = this.decode();
    return { value, raw: this.buf.subarray(start, this.pos) };
  }

  decode(): CborValue {
    const ib = this.u8();
    const major = ib >> 5;
    const info = ib & 0x1f;

    switch (major) {
      case 0:
        return { t: "uint", v: this.readArg(info) };
      case 1:
        return { t: "nint", v: -1n - this.readArg(info) };
      case 2: {
        if (info === 31) {
          const parts: number[] = [];
          while (true) {
            if (this.buf[this.pos] === 0xff) {
              this.pos++;
              break;
            }
            const inner = this.decode();
            if (inner.t !== "bytes") throw new Error("CBOR: bad indefinite byte chunk");
            for (const x of inner.v) parts.push(x);
          }
          return { t: "bytes", v: new Uint8Array(parts) };
        }
        const len = Number(this.readArg(info));
        const out = this.buf.subarray(this.pos, this.pos + len);
        this.pos += len;
        return { t: "bytes", v: new Uint8Array(out) };
      }
      case 3: {
        const len = Number(this.readArg(info));
        const out = this.buf.subarray(this.pos, this.pos + len);
        this.pos += len;
        return { t: "text", v: new TextDecoder().decode(out) };
      }
      case 4: {
        const items: CborValue[] = [];
        if (info === 31) {
          while (true) {
            if (this.buf[this.pos] === 0xff) {
              this.pos++;
              break;
            }
            items.push(this.decode());
          }
        } else {
          const n = Number(this.readArg(info));
          for (let i = 0; i < n; i++) items.push(this.decode());
        }
        return { t: "array", v: items };
      }
      case 5: {
        const entries: [CborValue, CborValue][] = [];
        if (info === 31) {
          while (true) {
            if (this.buf[this.pos] === 0xff) {
              this.pos++;
              break;
            }
            const k = this.decode();
            const v = this.decode();
            entries.push([k, v]);
          }
        } else {
          const n = Number(this.readArg(info));
          for (let i = 0; i < n; i++) {
            const k = this.decode();
            const v = this.decode();
            entries.push([k, v]);
          }
        }
        return { t: "map", v: entries };
      }
      case 6: {
        const tag = this.readArg(info);
        const inner = this.decode();
        if (tag === 2n && inner.t === "bytes") return { t: "uint", v: this.bytesToBig(inner.v) };
        if (tag === 3n && inner.t === "bytes") return { t: "nint", v: -1n - this.bytesToBig(inner.v) };
        return { t: "tag", tag, v: inner };
      }
      case 7: {
        // simple values + floats. info: 20=false,21=true,22=null,23=undefined,
        // 24=1-byte simple, 25/26/27=float16/32/64.
        if (info < 24) return { t: "simple", v: info };
        if (info === 24) return { t: "simple", v: this.u8() };
        if (info === 25) {
          this.pos += 2;
          return { t: "float", v: NaN };
        }
        if (info === 26) {
          this.pos += 4;
          return { t: "float", v: NaN };
        }
        if (info === 27) {
          this.pos += 8;
          return { t: "float", v: NaN };
        }
        throw new Error(`CBOR: unsupported major-7 info ${info}`);
      }
      default:
        throw new Error(`CBOR: unsupported major type ${major}`);
    }
  }
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
