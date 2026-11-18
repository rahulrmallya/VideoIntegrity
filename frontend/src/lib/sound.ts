// Optional alarm tone (WebAudio, no files — works offline). Off by default; the toggle lives in the top bar.

let ctx: AudioContext | null = null

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

/** Call from the toggle's click so the browser allows audio later. */
export function unlockAudio() {
  audio()
}

function tone(ac: AudioContext, freq: number, start: number, dur: number, gain = 0.12) {
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = 'square'
  osc.frequency.value = freq
  g.gain.setValueAtTime(0, start)
  g.gain.linearRampToValueAtTime(gain, start + 0.01)
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(g).connect(ac.destination)
  osc.start(start)
  osc.stop(start + dur + 0.02)
}

/** Two-tone alert: critical = urgent high/low, warning = single soft tone. */
export function playAlarm(severity: 'critical' | 'warning') {
  const ac = audio()
  if (!ac) return
  const t = ac.currentTime + 0.01
  if (severity === 'critical') {
    tone(ac, 880, t, 0.14)
    tone(ac, 660, t + 0.16, 0.14)
    tone(ac, 880, t + 0.32, 0.14)
    tone(ac, 660, t + 0.48, 0.2)
  } else {
    tone(ac, 520, t, 0.25, 0.08)
  }
}

const KEY = 'frameseal.sound'

export function loadSoundPref(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function saveSoundPref(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    // private mode etc.
  }
}
