// Real crypto for the mock (CONTRACT §3): SHA-256 via crypto.subtle, the same byte layouts,
// and Ed25519 via WebCrypto when the browser has it (HMAC fallback otherwise).

export type Bytes = Uint8Array<ArrayBuffer>

const encoder = new TextEncoder()

export function utf8(s: string): Bytes {
  return encoder.encode(s) as Bytes
}

export function concat(...parts: Uint8Array[]): Bytes {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

export function u64(x: bigint | number): Bytes {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setBigUint64(0, BigInt(x), false)
  return b
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

export function toHex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += HEX[b[i]]
  return s
}

export function fromHex(h: string): Bytes {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16)
  return out
}

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

export async function sha256Hex(data: Bytes): Promise<string> {
  return toHex(await sha256(data))
}

export function bytesToBase64(b: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < b.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, b.subarray(i, i + CHUNK) as unknown as number[])
  }
  return btoa(bin)
}

export function base64ToBytes(s: string): Bytes {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function hamming64(a: string, b: string): number {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b)
  let n = 0
  while (x) {
    n += Number(x & 1n)
    x >>= 1n
  }
  return n
}

// --- §3 hash constructions ---------------------------------------------------------------------

const TAG_GENESIS = utf8('FS1-GENESIS')
const TAG_LINK = utf8('FS1-LINK')
const TAG_CKPT = utf8('FS1-CKPT')
const TAG_SEAL = utf8('FS1-SEAL')

/** §3.5 genesis = H("FS1-GENESIS" || utf8(session_id) || pk) */
export function genesisHash(sessionId: string, pk: Uint8Array): Promise<string> {
  return sha256Hex(concat(TAG_GENESIS, utf8(sessionId), pk))
}

/** §3.6 chain_hash = H("FS1-LINK" || prev || frame_hash || dhash(8 raw) || u64(seq) || u64(ts_ns)) */
export function chainHash(prevHex: string, frameHashHex: string, dhashHex: string, seq: number, tsNs: bigint): Promise<string> {
  return sha256Hex(concat(TAG_LINK, fromHex(prevHex), fromHex(frameHashHex), fromHex(dhashHex), u64(seq), u64(tsNs)))
}

/** §3.7 signed message for a checkpoint. */
export function checkpointMessage(sessionId: string, seq: number, chainHashHex: string): Bytes {
  return concat(TAG_CKPT, utf8(sessionId), u64(seq), fromHex(chainHashHex))
}

/** §3.8 signed message for the seal record. */
export function sealMessage(sessionId: string, lastSeq: number, chainHashHex: string, frameCount: number): Bytes {
  return concat(TAG_SEAL, utf8(sessionId), u64(lastSeq), fromHex(chainHashHex), u64(frameCount))
}

// --- Device key ----------------------------------------------------------------------------------

export type Signer = {
  publicKeyRaw: Bytes
  /** true when the browser did real Ed25519; false = HMAC stand-in with the same sizes. */
  realEd25519: boolean
  sign(msg: Bytes): Promise<string>
  verify(msg: Bytes, sigHex: string | null): Promise<boolean>
}

export async function createSigner(): Promise<Signer> {
  try {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    return {
      publicKeyRaw,
      realEd25519: true,
      async sign(msg) {
        return toHex(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, msg)))
      },
      async verify(msg, sigHex) {
        if (!sigHex || sigHex.length !== 128) return false
        return crypto.subtle.verify({ name: 'Ed25519' }, pair.publicKey, fromHex(sigHex), msg)
      },
    }
  } catch {
    // Older browser without Ed25519 in WebCrypto: HMAC-SHA-512 gives a 64-byte (128 hex) tag.
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign', 'verify'])
    const publicKeyRaw = await sha256(concat(utf8('mock-pk'), secret))
    return {
      publicKeyRaw,
      realEd25519: false,
      async sign(msg) {
        return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, msg)))
      },
      async verify(msg, sigHex) {
        if (!sigHex || sigHex.length !== 128) return false
        return crypto.subtle.verify('HMAC', key, fromHex(sigHex), msg)
      },
    }
  }
}
