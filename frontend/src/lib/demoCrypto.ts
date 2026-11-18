// Real crypto for the "How it works" teaching widgets (runs entirely in the browser, offline).

const enc = new TextEncoder()

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

export type DemoSigner = {
  /** true = genuine Ed25519 via WebCrypto; false = HMAC-SHA-256 stand-in (older browsers). */
  ed25519: boolean
  sign(text: string): Promise<ArrayBuffer>
  verify(text: string, sig: ArrayBuffer): Promise<boolean>
}

let signer: Promise<DemoSigner> | null = null

/** One "camera" key pair per page load. */
export function demoSigner(): Promise<DemoSigner> {
  signer ??= (async (): Promise<DemoSigner> => {
    try {
      const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair
      return {
        ed25519: true,
        sign: (t) => crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, enc.encode(t)),
        verify: (t, sig) => crypto.subtle.verify({ name: 'Ed25519' }, pair.publicKey, sig, enc.encode(t)),
      }
    } catch {
      // HONEST STAND-IN: this browser has no Ed25519 in WebCrypto, so we use HMAC-SHA-256.
      // HMAC uses one shared secret (not a private/public pair), so it only *illustrates* the idea that
      // you can't produce a valid tag without the key; it is not a public-key signature.
      const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
      return {
        ed25519: false,
        sign: (t) => crypto.subtle.sign('HMAC', key, enc.encode(t)),
        verify: (t, sig) => crypto.subtle.verify('HMAC', key, sig, enc.encode(t)),
      }
    }
  })()
  return signer
}
