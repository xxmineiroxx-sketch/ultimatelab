'use client'

import { motion } from 'framer-motion'

interface LogoProps {
  size?: number
  showText?: boolean
  animate?: boolean
  className?: string
}

// Animated waveform bars inside a rounded-square "U" mark
export default function Logo({ size = 36, showText = true, animate = true, className = '' }: LogoProps) {
  const bars = [0.45, 0.7, 1.0, 0.7, 0.45]
  const delays = [0, 0.15, 0.3, 0.45, 0.6]

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      {/* Mark */}
      <div
        style={{ width: size, height: size }}
        className="relative flex-shrink-0 rounded-[28%] overflow-hidden"
      >
        {/* Gradient background */}
        <svg width={size} height={size} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="logoGrad" x1="0" y1="0" x2="36" y2="36" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#4F46E5" />
              <stop offset="50%" stopColor="#7C3AED" />
              <stop offset="100%" stopColor="#DB2777" />
            </linearGradient>
            <radialGradient id="logoGlow" cx="50%" cy="30%" r="60%">
              <stop offset="0%" stopColor="#818CF8" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#4F46E5" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Background fill */}
          <rect width="36" height="36" rx="10" fill="url(#logoGrad)" />
          {/* Glow overlay */}
          <rect width="36" height="36" rx="10" fill="url(#logoGlow)" />
        </svg>

        {/* Animated waveform bars — absolutely positioned over the svg */}
        <div
          className="absolute inset-0 flex items-center justify-center gap-[2.5px]"
          style={{ paddingLeft: 6, paddingRight: 6 }}
        >
          {bars.map((h, i) => (
            animate ? (
              <motion.div
                key={i}
                className="rounded-full bg-white"
                style={{ width: size * 0.083, height: size * 0.44, originY: '50%', borderRadius: 99 }}
                animate={{
                  scaleY: [h, h * 0.4, h * 1.15, h * 0.6, h],
                  opacity: [0.9, 0.6, 1, 0.7, 0.9],
                }}
                transition={{
                  duration: 1.6,
                  delay: delays[i],
                  repeat: Infinity,
                  ease: 'easeInOut',
                }}
                initial={{ scaleY: h }}
              />
            ) : (
              <div
                key={i}
                className="rounded-full bg-white"
                style={{
                  width: size * 0.083,
                  height: size * 0.44 * h,
                  borderRadius: 99,
                  opacity: 0.9,
                }}
              />
            )
          ))}
        </div>
      </div>

      {/* Wordmark */}
      {showText && (
        <span
          className="font-bold tracking-tight text-white select-none"
          style={{ fontSize: size * 0.5, lineHeight: 1 }}
        >
          Ultimatelabs
        </span>
      )}
    </div>
  )
}
