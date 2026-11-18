// Mock camera: draws frames on an off-screen canvas, plus the attacker's pixel edits, dHash and diff heatmaps.
//
// The canvases are detached <canvas> elements (never added to the page) rather than OffscreenCanvas:
// OffscreenCanvas.convertToBlob() waits for a compositor frame, which takes ~1 s whenever the window
// is hidden or occluded and stalls the whole mock. toDataURL() is synchronous and costs ~3 ms.

import { base64ToBytes, type Bytes } from './crypto'

export type Ctx = CanvasRenderingContext2D
export type Canvas = HTMLCanvasElement

export function makeCanvas(w: number, h: number, willReadFrequently = false): { canvas: Canvas; ctx: Ctx } {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently })
  if (!ctx) throw new Error('2D canvas unavailable')
  return { canvas, ctx }
}

export async function loadSceneFonts(): Promise<void> {
  try {
    await Promise.all([
      document.fonts.load('600 18px "Inter"'),
      document.fonts.load('500 30px "JetBrains Mono"'),
      document.fonts.load('400 14px "JetBrains Mono"'),
    ])
  } catch {
    // fall back to system fonts
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function clock(ms: number): { date: string; time: string } {
  const d = new Date(ms)
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`,
  }
}

export type SceneOptions = {
  /** Attacker's synthetic frame: no moving object, slightly different light, frozen clock. */
  foreign?: boolean
}

/**
 * The "camera" scene: dark room, a desk, a moving glowing object that crosses the centre
 * (so blur / black-box attacks visibly hit it), REC dot, running clock and seq counter.
 */
export function drawScene(ctx: Ctx, w: number, h: number, wallMs: number, seq: number, opts: SceneOptions = {}) {
  const t = wallMs
  // background
  const bg = ctx.createLinearGradient(0, 0, 0, h)
  bg.addColorStop(0, opts.foreign ? '#0c1220' : '#0a0f1c')
  bg.addColorStop(1, opts.foreign ? '#16203a' : '#121b30')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)

  // floor grid (perspective)
  const horizon = h * 0.42
  ctx.strokeStyle = 'rgba(80, 110, 160, 0.16)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = -8; i <= 8; i++) {
    ctx.moveTo(w / 2 + i * 18, horizon)
    ctx.lineTo(w / 2 + i * 140, h)
  }
  for (let j = 1; j <= 8; j++) {
    const y = horizon + (h - horizon) * Math.pow(j / 8, 1.8)
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
  }
  ctx.stroke()

  // static props: a desk and a door frame
  ctx.fillStyle = '#1a2438'
  ctx.fillRect(w * 0.06, h * 0.58, w * 0.22, h * 0.07)
  ctx.fillRect(w * 0.08, h * 0.65, w * 0.02, h * 0.16)
  ctx.fillRect(w * 0.24, h * 0.65, w * 0.02, h * 0.16)
  ctx.strokeStyle = '#24314d'
  ctx.lineWidth = 6
  ctx.strokeRect(w * 0.74, h * 0.2, w * 0.16, h * 0.46)

  // moving object (Lissajous path through the centre)
  if (!opts.foreign) {
    const x = w / 2 + Math.sin(t * 0.0011) * w * 0.3
    const y = h * 0.52 + Math.sin(t * 0.0017) * h * 0.14
    const r = Math.min(w, h) * 0.08
    const glow = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 2.2)
    glow.addColorStop(0, 'rgba(56, 189, 248, 0.35)')
    glow.addColorStop(1, 'rgba(56, 189, 248, 0)')
    ctx.fillStyle = glow
    ctx.fillRect(x - r * 2.5, y - r * 2.5, r * 5, r * 5)
    const body = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r)
    body.addColorStop(0, '#e0f2fe')
    body.addColorStop(0.4, '#38bdf8')
    body.addColorStop(1, '#0369a1')
    ctx.fillStyle = body
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
    // a small orbiting tag so motion reads even when the main object pauses
    const a = t * 0.004
    ctx.fillStyle = '#fbbf24'
    ctx.fillRect(x + Math.cos(a) * r * 1.6 - 6, y + Math.sin(a) * r * 1.6 - 6, 12, 12)
  }

  // overlay text
  const { date, time } = clock(opts.foreign ? Math.floor(wallMs / 60000) * 60000 : wallMs)
  const recOn = Math.floor(wallMs / 500) % 2 === 0
  ctx.fillStyle = recOn ? '#ef4444' : 'rgba(239, 68, 68, 0.25)'
  ctx.beginPath()
  ctx.arc(24, 26, 7, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#e6edf7'
  ctx.font = '600 18px "Inter", system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText('MOCK CAMERA', 40, 27)
  ctx.fillStyle = '#8a97ad'
  ctx.font = '400 13px "JetBrains Mono", monospace'
  ctx.fillText(`CAM-01 · ${w}×${h}`, 40, 48)
  ctx.textAlign = 'right'
  ctx.fillText(date, w - 16, 27)
  ctx.fillText(`#${seq}`, w - 16, h - 22)
  ctx.textAlign = 'left'
  ctx.fillStyle = '#e6edf7'
  ctx.font = '500 30px "JetBrains Mono", monospace'
  ctx.fillText(time, 16, h - 26)
}

/** PIXEL_TAMPER: blur the central 40% × 40% region. */
export function blurCentre(ctx: Ctx, src: CanvasImageSource, w: number, h: number) {
  ctx.drawImage(src, 0, 0, w, h)
  ctx.save()
  ctx.beginPath()
  ctx.rect(w * 0.3, h * 0.3, w * 0.4, h * 0.4)
  ctx.clip()
  ctx.filter = 'blur(18px)'
  ctx.drawImage(src, 0, 0, w, h)
  ctx.filter = 'none'
  // a second pass smears more like an "erased" object
  ctx.globalAlpha = 0.6
  ctx.filter = 'blur(30px)'
  ctx.drawImage(src, 0, 0, w, h)
  ctx.restore()
}

/** CHAIN_FORGE: a black box over the scene centre. */
export function blackBox(ctx: Ctx, src: CanvasImageSource, w: number, h: number) {
  ctx.drawImage(src, 0, 0, w, h)
  ctx.fillStyle = '#000000'
  ctx.fillRect(w * 0.3, h * 0.28, w * 0.4, h * 0.44)
}

export type Encoded = { bytes: Bytes; b64: string }

export function encodeJpeg(canvas: Canvas, quality: number): Encoded {
  const url = canvas.toDataURL('image/jpeg', quality)
  const b64 = url.slice(url.indexOf(',') + 1)
  return { bytes: base64ToBytes(b64), b64 }
}

export function decodeJpeg(bytes: Bytes): Promise<ImageBitmap> {
  return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
}

// --- §3.4 dHash (9 wide × 8 tall grayscale, bit = right > left, row-major, MSB first) -----------

let dh: { canvas: Canvas; ctx: Ctx } | null = null

export function dhashOf(src: CanvasImageSource): string {
  dh ??= makeCanvas(9, 8, true)
  dh.ctx.imageSmoothingQuality = 'high'
  dh.ctx.drawImage(src, 0, 0, 9, 8)
  const px = dh.ctx.getImageData(0, 0, 9, 8).data
  const gray = (r: number, c: number) => {
    const i = (r * 9 + c) * 4
    return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
  }
  let hex = ''
  for (let r = 0; r < 8; r++) {
    let byte = 0
    for (let c = 0; c < 8; c++) byte = (byte << 1) | (gray(r, c + 1) > gray(r, c) ? 1 : 0)
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

// --- diff.png: heatmap of absdiff(original, received) blended over the original ----------------

/** Returns a data: URL (PNG). */
export async function makeDiffPng(original: Bytes, received: Bytes, w: number, h: number): Promise<string> {
  const [a, b] = await Promise.all([decodeJpeg(original), decodeJpeg(received)])
  const A = makeCanvas(w, h, true)
  const B = makeCanvas(w, h, true)
  A.ctx.drawImage(a, 0, 0, w, h)
  B.ctx.drawImage(b, 0, 0, w, h)
  a.close()
  b.close()
  const ia = A.ctx.getImageData(0, 0, w, h)
  const pa = ia.data
  const pb = B.ctx.getImageData(0, 0, w, h).data
  for (let i = 0; i < pa.length; i += 4) {
    const d = (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2])) / 3
    const g = (0.299 * pa[i] + 0.587 * pa[i + 1] + 0.114 * pa[i + 2]) * 0.45
    if (d > 10) {
      // amber (small change) → red (large change), opacity grows with the change
      const k = Math.min(1, d / 60)
      const alpha = 0.45 + 0.55 * k
      pa[i] = g * (1 - alpha) + (245 - 6 * k) * alpha
      pa[i + 1] = g * (1 - alpha) + (158 - 90 * k) * alpha
      pa[i + 2] = g * (1 - alpha) + (11 + 57 * k) * alpha
    } else {
      pa[i] = pa[i + 1] = pa[i + 2] = g
    }
  }
  A.ctx.putImageData(ia, 0, 0)
  return A.canvas.toDataURL('image/png')
}
