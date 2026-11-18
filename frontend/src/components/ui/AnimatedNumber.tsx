import { animate, motion, useMotionValue, useTransform } from 'motion/react'
import { useEffect } from 'react'

type Props = { value: number; decimals?: number; className?: string; duration?: number }

/** Tweens to each new value; renders through a MotionValue so React does not re-render per frame. */
export function AnimatedNumber({ value, decimals = 0, className, duration = 0.6 }: Props) {
  const mv = useMotionValue(value)
  const text = useTransform(mv, (v) =>
    v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
  )
  useEffect(() => {
    const controls = animate(mv, value, { duration, ease: [0.22, 1, 0.36, 1] })
    return () => controls.stop()
  }, [mv, value, duration])
  return <motion.span className={`font-mono tabular-nums ${className ?? ''}`}>{text}</motion.span>
}
