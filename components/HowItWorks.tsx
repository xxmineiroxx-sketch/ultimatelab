'use client'

import { motion } from 'framer-motion'

const STEPS = [
  {
    step: '01',
    title: 'Build Your Service Plan',
    description:
      'Create your setlist in minutes. Assign songs with keys, BPM, and notes for each musician. Publish to your whole team instantly — everyone sees the same plan.',
    color: 'from-indigo-500 to-blue-500',
    icon: '📋',
  },
  {
    step: '02',
    title: 'Invite & Assign Your Team',
    description:
      'Add your musicians, vocalists, and tech crew by role. Set part assignments (soprano, tenor, keys, drums) and send invites via link — no app download required to accept.',
    color: 'from-purple-500 to-indigo-500',
    icon: '👥',
  },
  {
    step: '03',
    title: 'Rehearse with AI Stems',
    description:
      'Each team member rehearses their part with AI-separated stem tracks. Vocalists hear isolated harmony guides. Instrumentalists see their chord charts. Practice loops repeat your weak sections.',
    color: 'from-pink-500 to-purple-500',
    icon: '🎵',
  },
  {
    step: '04',
    title: 'Lead Sunday Live',
    description:
      "Tap a section on your tablet and the whole team's display syncs instantly. AI monitors tempo and energy. Your musicians follow the cue — no more hand signals across the stage.",
    color: 'from-amber-500 to-pink-500',
    icon: '🎛️',
  },
  {
    step: '05',
    title: 'Scale Across Campuses',
    description:
      'Push your full song library, service templates, and standards to every campus location. Central admin sees all campuses from one dashboard. Each campus keeps their own schedule.',
    color: 'from-green-500 to-emerald-500',
    icon: '🏛️',
  },
]

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="py-24 px-4 sm:px-6 lg:px-8 bg-[#020617]">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-20"
        >
          <span className="inline-block px-3 py-1 mb-4 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-sm font-medium">
            Step-by-Step
          </span>
          <h2 className="text-4xl md:text-5xl font-black text-white mb-4">
            From Planning to{' '}
            <span className="bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
              Sunday Morning
            </span>
          </h2>
          <p className="text-lg text-slate-400 max-w-2xl mx-auto">
            Everything your worship team needs, in the right order, at the right time.
          </p>
        </motion.div>

        {/* Steps */}
        <div className="relative">
          {/* Vertical connector line */}
          <div className="absolute left-6 md:left-1/2 top-0 bottom-0 w-px bg-gradient-to-b from-indigo-600/50 via-purple-600/30 to-transparent hidden sm:block" />

          <div className="space-y-12 md:space-y-0">
            {STEPS.map((step, i) => {
              const isLeft = i % 2 === 0
              return (
                <motion.div
                  key={step.step}
                  initial={{ opacity: 0, x: isLeft ? -30 : 30 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6, delay: i * 0.1 }}
                  className={`relative flex flex-col md:flex-row md:items-center gap-6 md:gap-16 pb-12 md:pb-16 ${
                    isLeft ? 'md:flex-row' : 'md:flex-row-reverse'
                  }`}
                >
                  {/* Number circle (center on desktop) */}
                  <div className="hidden md:flex absolute left-1/2 -translate-x-1/2 w-12 h-12 rounded-full bg-[#020617] border-2 border-indigo-600/60 items-center justify-center z-10">
                    <span className="text-indigo-400 font-bold text-sm">{step.step}</span>
                  </div>

                  {/* Content card */}
                  <div className={`flex-1 ${isLeft ? 'md:pr-16' : 'md:pl-16'}`}>
                    <div className="bg-[#0F172A] border border-white/5 rounded-2xl p-6 hover:border-white/10 transition-colors group">
                      <div className="flex items-start gap-4">
                        {/* Mobile step number */}
                        <div className="md:hidden flex-shrink-0 w-10 h-10 rounded-full bg-indigo-600/20 border border-indigo-600/40 flex items-center justify-center">
                          <span className="text-indigo-400 font-bold text-xs">{step.step}</span>
                        </div>
                        <div className="text-3xl">{step.icon}</div>
                      </div>
                      <h3 className="text-xl font-bold text-white mt-3 mb-2">{step.title}</h3>
                      <p className="text-slate-400 leading-relaxed">{step.description}</p>
                    </div>
                  </div>

                  {/* Spacer on the other side */}
                  <div className="hidden md:block flex-1" />
                </motion.div>
              )
            })}
          </div>
        </div>
      </div>
    </section>
  )
}
