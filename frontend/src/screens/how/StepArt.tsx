import { motion } from 'motion/react'
import { BadgeCheck, Camera, FileArchive, KeyRound, Monitor, WifiOff } from 'lucide-react'

// Five small looping SVG animations, one per step. viewBox 320×160 everywhere.

const C = {
  border: '#1F2A40',
  raised: '#141C2E',
  text: '#E6EDF7',
  muted: '#8A97AD',
  green: '#22C55E',
  cyan: '#22D3EE',
  red: '#EF4444',
  amber: '#F59E0B',
}

const svgProps = { viewBox: '0 0 320 160', className: 'h-full w-full' } as const

export function CaptureArt() {
  return (
    <svg {...svgProps}>
      <rect x={14} y={52} width={78} height={56} rx={10} fill={C.raised} stroke={C.border} strokeWidth={2} />
      <Camera x={33} y={60} width={40} height={40} color={C.cyan} strokeWidth={1.6} />
      <motion.circle cx={84} cy={60} r={3.5} fill={C.red} animate={{ opacity: [1, 0.2, 1] }} transition={{ duration: 1, repeat: Infinity }} />
      {[0, 1, 2].map((i) => (
        <motion.g
          key={i}
          initial={{ x: 0, opacity: 0 }}
          animate={{ x: [0, 200], opacity: [0, 1, 1, 0] }}
          transition={{ duration: 3, repeat: Infinity, delay: i, ease: 'linear', times: [0, 0.1, 0.85, 1] }}
        >
          <rect x={102} y={58} width={50} height={44} rx={5} fill="#0B1220" stroke={C.cyan} strokeWidth={1.5} />
          <path d="M106 96 L120 80 L130 90 L138 82 L148 96 Z" fill={C.border} />
          <circle cx={140} cy={68} r={4} fill={C.amber} opacity={0.8} />
          <text x={127} y={118} textAnchor="middle" fontSize={10} fontFamily="JetBrains Mono" fill={C.muted}>
            frame
          </text>
        </motion.g>
      ))}
      <text x={53} y={130} textAnchor="middle" fontSize={10} fill={C.muted}>
        15 frames / second
      </text>
    </svg>
  )
}

export function FingerprintArt({ hash }: { hash: string }) {
  const lines = [hash.slice(0, 32), hash.slice(32, 64)]
  return (
    <svg {...svgProps}>
      <rect x={10} y={46} width={70} height={56} rx={5} fill="#0B1220" stroke={C.cyan} strokeWidth={1.5} />
      <path d="M14 96 L32 74 L46 88 L56 78 L76 96 Z" fill={C.border} />
      <circle cx={64} cy={58} r={5} fill={C.amber} opacity={0.8} />
      <motion.path
        d="M88 74 H118"
        stroke={C.muted}
        strokeWidth={2}
        markerEnd="url(#arrowhead)"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: [0, 1, 1] }}
        transition={{ duration: 3.2, repeat: Infinity, times: [0, 0.25, 1] }}
      />
      <defs>
        <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0 0 L8 4 L0 8 Z" fill={C.muted} />
        </marker>
      </defs>
      <rect x={124} y={60} width={58} height={28} rx={6} fill={C.raised} stroke={C.green} strokeWidth={1.5} />
      <text x={153} y={78} textAnchor="middle" fontSize={11} fontWeight={700} fill={C.green}>
        SHA-256
      </text>
      <motion.path
        d="M188 74 H206"
        stroke={C.muted}
        strokeWidth={2}
        markerEnd="url(#arrowhead)"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: [0, 0, 1, 1] }}
        transition={{ duration: 3.2, repeat: Infinity, times: [0, 0.3, 0.45, 1] }}
      />
      {lines.map((l, i) => (
        <motion.text
          key={i}
          x={212}
          y={68 + i * 14}
          fontSize={7.4}
          fontFamily="JetBrains Mono"
          fill={C.green}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0, 1, 1, 0] }}
          transition={{ duration: 3.2, repeat: Infinity, times: [0, 0.45 + i * 0.08, 0.55 + i * 0.08, 0.92, 1] }}
        >
          {l.slice(0, 16)}
          <tspan x={212} dy={7}>
            {l.slice(16)}
          </tspan>
        </motion.text>
      ))}
      <text x={160} y={138} textAnchor="middle" fontSize={10} fill={C.muted}>
        64 hex characters — unique to this exact frame
      </text>
    </svg>
  )
}

export function ChainArt() {
  const xs = [8, 86, 164, 242]
  return (
    <svg {...svgProps}>
      {xs.map((x, i) => (
        <g key={x}>
          <rect x={x} y={44} width={70} height={72} rx={7} fill={C.raised} stroke={C.green} strokeWidth={1.5} />
          <text x={x + 35} y={60} textAnchor="middle" fontSize={10} fontWeight={700} fill={C.text}>
            #{i + 1}
          </text>
          <rect x={x + 8} y={68} width={54} height={14} rx={3} fill="#0B1220" />
          <text x={x + 12} y={78} fontSize={7.5} fontFamily="JetBrains Mono" fill={C.muted}>
            prev {['0000', '9f3a', '1c7e', 'b502'][i]}
          </text>
          <rect x={x + 8} y={88} width={54} height={14} rx={3} fill="#0B1220" />
          <text x={x + 12} y={98} fontSize={7.5} fontFamily="JetBrains Mono" fill={C.green}>
            hash {['9f3a', '1c7e', 'b502', 'e41d'][i]}
          </text>
        </g>
      ))}
      {xs.slice(0, 3).map((x, i) => (
        <motion.path
          key={x}
          d={`M${x + 62} 95 C ${x + 80} 95, ${x + 76} 75, ${x + 94} 75`}
          fill="none"
          stroke={C.cyan}
          strokeWidth={2}
          initial={{ pathLength: 0 }}
          animate={{ pathLength: [0, 1, 1, 0] }}
          transition={{ duration: 3, repeat: Infinity, delay: i * 0.4, times: [0, 0.25, 0.85, 1] }}
        />
      ))}
      <text x={160} y={138} textAnchor="middle" fontSize={10} fill={C.muted}>
        each block carries the previous block's hash
      </text>
    </svg>
  )
}

export function SealArt() {
  return (
    <svg {...svgProps}>
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={10 + i * 46} y={62} width={38} height={36} rx={5} fill={C.raised} stroke={C.green} strokeWidth={1.2} />
      ))}
      {[0, 1, 2].map((i) => (
        <path key={i} d={`M${48 + i * 46} 80 H${56 + i * 46}`} stroke={C.cyan} strokeWidth={2} />
      ))}
      <rect x={194} y={54} width={52} height={52} rx={7} fill={C.raised} stroke={C.cyan} strokeWidth={2} />
      <text x={220} y={84} textAnchor="middle" fontSize={9} fontWeight={700} fill={C.text}>
        head
      </text>
      <KeyRound x={262} y={30} width={30} height={30} color={C.amber} strokeWidth={2} />
      <text x={277} y={74} textAnchor="middle" fontSize={8.5} fill={C.amber}>
        private key
      </text>
      <motion.g
        style={{ originX: '238px', originY: '108px' }}
        initial={{ scale: 0, opacity: 0, rotate: -20 }}
        animate={{ scale: [0, 1.25, 1, 1, 0], opacity: [0, 1, 1, 1, 0], rotate: [-20, -8, -8, -8, -8] }}
        transition={{ duration: 1.8, repeat: Infinity, times: [0, 0.18, 0.3, 0.85, 1] }}
      >
        <rect x={204} y={98} width={86} height={22} rx={4} fill="none" stroke={C.green} strokeWidth={2} />
        <text x={247} y={113} textAnchor="middle" fontSize={9.5} fontWeight={800} fill={C.green}>
          SIGNED · Ed25519
        </text>
      </motion.g>
      <text x={160} y={146} textAnchor="middle" fontSize={10} fill={C.muted}>
        every second · only the camera holds this key
      </text>
    </svg>
  )
}

export function VerifyArt() {
  return (
    <svg {...svgProps}>
      <FileArchive x={18} y={46} width={50} height={50} color={C.cyan} strokeWidth={1.5} />
      <text x={43} y={112} textAnchor="middle" fontSize={9} fill={C.muted}>
        evidence.zip
      </text>
      <motion.path
        d="M80 70 H150"
        stroke={C.muted}
        strokeWidth={2}
        strokeDasharray="5 4"
        animate={{ strokeDashoffset: [18, 0] }}
        transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
      />
      <Monitor x={156} y={38} width={66} height={66} color={C.text} strokeWidth={1.3} />
      <KeyRound x={236} y={42} width={26} height={26} color={C.green} strokeWidth={2} />
      <text x={249} y={82} textAnchor="middle" fontSize={8.5} fill={C.green}>
        public key
      </text>
      <motion.g
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: [0, 1.2, 1, 1], opacity: [0, 1, 1, 0] }}
        transition={{ duration: 2.6, repeat: Infinity, times: [0, 0.25, 0.35, 1] }}
        style={{ originX: '189px', originY: '66px' }}
      >
        <BadgeCheck x={174} y={50} width={30} height={30} color={C.green} strokeWidth={2.2} />
      </motion.g>
      <WifiOff x={278} y={104} width={18} height={18} color={C.muted} strokeWidth={1.8} />
      <text x={160} y={136} textAnchor="middle" fontSize={10} fill={C.muted}>
        no private key, no internet, no blockchain needed
      </text>
    </svg>
  )
}
