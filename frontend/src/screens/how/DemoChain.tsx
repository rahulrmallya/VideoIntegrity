import { BadgeCheck, OctagonX, RotateCcw, Skull } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { demoSigner, sha256Hex, type DemoSigner } from '../../lib/demoCrypto'

// The whole idea in one widget: 8 blocks, real SHA-256 links, a real signature on block 8.
//   hash[i] = SHA-256(hash[i-1] + "|" + text[i])      (hash[-1] = 64 zeros)
// "stored" = the fingerprints written in the recording (what the camera signed / what an attacker rewrote).

const N = 8
const GENESIS = '0'.repeat(64)
const initialTexts = () => Array.from({ length: N }, (_, i) => `frame ${i + 1}`)

async function chainOf(texts: string[]): Promise<string[]> {
  const out: string[] = []
  let prev = GENESIS
  for (const t of texts) {
    prev = await sha256Hex(`${prev}|${t}`)
    out.push(prev)
  }
  return out
}

const short = (h: string | undefined) => (h ? `${h.slice(0, 8)}…` : '········')

type Mode = 'sealed' | 'edited' | 'forged'

export function DemoChain() {
  const signer = useRef<DemoSigner | null>(null)
  const [texts, setTexts] = useState<string[]>(initialTexts)
  const [hashes, setHashes] = useState<string[]>([])
  const [stored, setStored] = useState<string[]>([])
  /** What the camera originally recorded and signed. */
  const [original, setOriginal] = useState<string[]>([])
  const [signature, setSignature] = useState<ArrayBuffer | null>(null)
  const [sigOk, setSigOk] = useState<boolean | null>(null)
  const [mode, setMode] = useState<Mode>('sealed')
  const [ed25519, setEd25519] = useState(true)

  // camera: hash the honest texts and sign block 8
  const seal = useCallback(async () => {
    const s = (signer.current ??= await demoSigner())
    setEd25519(s.ed25519)
    const t = initialTexts()
    const h = await chainOf(t)
    setTexts(t)
    setHashes(h)
    setStored(h)
    setOriginal(h)
    setSignature(await s.sign(h[N - 1]))
    setMode('sealed')
  }, [])

  useEffect(() => {
    void seal()
  }, [seal])

  // recompute live hashes whenever a text changes
  useEffect(() => {
    let alive = true
    void chainOf(texts).then((h) => alive && setHashes(h))
    return () => {
      alive = false
    }
  }, [texts])

  // verify the camera's signature against the chain as it is now (real verify, every time)
  useEffect(() => {
    let alive = true
    const s = signer.current
    if (!s || !signature || hashes.length < N) return
    void s.verify(hashes[N - 1], signature).then((ok) => alive && setSigOk(ok))
    return () => {
      alive = false
    }
  }, [hashes, signature])

  const firstBroken = hashes.findIndex((h, i) => stored[i] !== undefined && h !== stored[i])
  const broken = firstBroken >= 0

  const attackerRecompute = () => {
    // the attacker can redo every hash (SHA-256 is public)… but has no private key to re-sign
    setStored(hashes)
    setMode('forged')
  }

  let status: { tone: string; text: string }
  if (broken)
    status = {
      tone: 'text-tampered',
      text: `Chain broken at frame ${firstBroken + 1} — its fingerprint and every link after it no longer match.`,
    }
  else if (sigOk === false)
    status = {
      tone: 'text-tampered',
      text: "Every hash is green again… but the signature fails: the attacker cannot sign without the camera's private key.",
    }
  else status = { tone: 'text-sealed', text: 'All 8 links match and the camera’s signature verifies. Now edit any block ↓' }

  return (
    <section className="rounded-2xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-semibold text-text">Try it: break the chain</h2>
        <p className={`min-w-0 flex-1 text-[13px] font-medium ${status.tone}`}>{status.text}</p>
        <button
          type="button"
          onClick={attackerRecompute}
          disabled={!broken}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-tampered/60 bg-tampered/10 px-3 text-[12.5px] font-semibold text-tampered hover:bg-tampered/20 disabled:cursor-not-allowed disabled:opacity-40"
          title="Rewrite every stored fingerprint to match the edited frames"
        >
          <Skull className="size-4" /> Recompute like an attacker
        </button>
        <button
          type="button"
          onClick={() => void seal()}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-raised px-3 text-[12.5px] text-text hover:border-pending/60"
        >
          <RotateCcw className="size-4" /> Reset
        </button>
      </div>

      <div className="mt-3 flex items-stretch">
        {texts.map((t, i) => {
          const ok = hashes[i] !== undefined && hashes[i] === stored[i]
          const linkOk = i === 0 || (hashes[i - 1] !== undefined && hashes[i - 1] === stored[i - 1])
          return (
            <div key={i} className="flex min-w-0 flex-1 items-stretch">
              {i > 0 && (
                <div className="flex w-5 shrink-0 items-center justify-center" title={linkOk ? 'link matches' : 'link broken'}>
                  <span className={`w-full border-t-2 ${linkOk ? 'border-pending/60' : 'border-dashed border-tampered'}`} />
                </div>
              )}
              <div
                className={`min-w-0 flex-1 rounded-lg border-2 px-2 py-1.5 transition-colors ${
                  ok ? 'border-sealed/50 bg-sealed/[0.05]' : 'border-tampered bg-tampered/[0.08]'
                }`}
              >
                <div className="flex items-center justify-between text-[10px] text-muted">
                  <span>Block {i + 1}</span>
                  {mode === 'forged' && stored[i] !== original[i] && <span className="text-tampered/80">rewritten</span>}
                </div>
                <input
                  value={t}
                  onChange={(e) => {
                    const v = e.target.value
                    setTexts((prev) => prev.map((x, j) => (j === i ? v : x)))
                    if (mode === 'sealed') setMode('edited')
                  }}
                  aria-label={`Block ${i + 1} content`}
                  className="mt-0.5 w-full rounded border border-border bg-bg/60 px-1.5 py-0.5 font-mono text-[12px] text-text outline-none focus:border-pending"
                />
                <div className="mt-1 font-mono text-[10px] leading-tight text-muted" title={i === 0 ? GENESIS : hashes[i - 1]}>
                  prev <span className={linkOk ? '' : 'text-tampered'}>{i === 0 ? '00000000…' : short(stored[i - 1])}</span>
                </div>
                <div className="font-mono text-[10px] leading-tight" title={hashes[i]}>
                  <span className="text-muted">hash </span>
                  <span className={ok ? 'text-sealed' : 'font-semibold text-tampered'}>{short(hashes[i])}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-2 flex justify-end">
        {sigOk === null ? null : sigOk ? (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-sealed/60 bg-sealed/10 px-2.5 py-1 text-[12px] font-semibold text-sealed">
            <BadgeCheck className="size-4" /> Block 8 · Signature ✓ — signed by the camera's private key
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-tampered bg-tampered/10 px-2.5 py-1 text-[12px] font-semibold text-tampered">
            <OctagonX className="size-4" /> Block 8 · Signature ✗ —{' '}
            {mode === 'forged' ? "the attacker cannot sign without the camera's private key" : 'the signed chain no longer matches'}
          </span>
        )}
      </div>
      <p className="mt-1 text-right text-[10.5px] text-muted/70">
        Real SHA-256 in your browser · {ed25519 ? 'real Ed25519 signature' : 'HMAC stand-in (this browser lacks Ed25519)'}
      </p>
    </section>
  )
}
