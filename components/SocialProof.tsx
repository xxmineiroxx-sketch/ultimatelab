'use client'

import { motion } from 'framer-motion'

const STATS = [
  { value: '2,400+', label: 'Worship Teams' },
  { value: '18,000+', label: 'Songs Processed' },
  { value: '340+', label: 'Churches' },
  { value: '4.9★', label: 'Avg Rating' },
]

export default function SocialProof() {
  return (
    <section className="relative py-16 border-y border-white/5 bg-[#0A0F1E]/60">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center"
        >
          {STATS.map((s) => (
            <div key={s.label}>
              <div className="text-3xl md:text-4xl font-black text-white mb-1">{s.value}</div>
              <div className="text-sm text-slate-500 uppercase tracking-wide">{s.label}</div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  )
}
