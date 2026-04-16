'use client'

import { motion } from 'framer-motion'
import { Smartphone, Tablet, ArrowRight } from 'lucide-react'

const APPS = [
  {
    id: 'musician',
    badge: 'Worship Leader & Admin',
    name: 'Ultimate Musician',
    tagline: 'Plan. Coordinate. Lead.',
    description:
      'The command center for worship directors. Build service plans, manage your team calendar, push assignments, and run multi-campus operations — all from your iPad or Mac.',
    highlights: [
      'Drag-and-drop service planning',
      'Smart team availability view',
      'One-tap publish to all members',
      'Multi-campus central admin hub',
    ],
    platform: 'iPad · iPhone · Mac',
    status: 'Available',
    statusColor: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
    icon: Tablet,
    gradient: 'from-indigo-600 to-blue-600',
    glowColor: 'bg-indigo-600/15',
  },
  {
    id: 'playback',
    badge: 'Musicians & Vocalists',
    name: 'Ultimate Playback',
    tagline: 'Practice. Perform. Flow.',
    description:
      'Every team member\'s personal rehearsal companion. See your part, hear your stem track, follow live section cues from the worship leader, and show lyrics to the congregation.',
    highlights: [
      'Personal stem track practice',
      'Live section cue display',
      'Chord charts with key transposition',
      'Congregation lyric display mode',
    ],
    platform: 'iPhone · iPad · Android',
    status: 'Available',
    statusColor: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
    icon: Smartphone,
    gradient: 'from-purple-600 to-pink-600',
    glowColor: 'bg-purple-600/15',
  },
]

export default function AppShowcase() {
  return (
    <section id="apps" className="py-24 px-4 sm:px-6 lg:px-8 bg-[#020617]">
      <div className="max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <span className="inline-block px-3 py-1 mb-4 rounded-full bg-purple-500/10 border border-purple-500/20 text-purple-400 text-sm font-medium">
            Two Apps, One Platform
          </span>
          <h2 className="text-4xl md:text-5xl font-black text-white mb-4">
            The right tool for{' '}
            <span className="bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
              every role
            </span>
          </h2>
          <p className="text-lg text-slate-400 max-w-2xl mx-auto">
            Leaders plan from Ultimate Musician. Musicians and vocalists rehearse and perform from Ultimate Playback. Built to work together seamlessly.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 gap-8">
          {APPS.map((app, i) => {
            const Icon = app.icon
            return (
              <motion.div
                key={app.id}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, delay: i * 0.15 }}
                className="relative group"
              >
                {/* Glow */}
                <div className={`absolute inset-0 ${app.glowColor} rounded-3xl blur-2xl opacity-60 group-hover:opacity-80 transition-opacity`} />

                <div className="relative bg-[#0F172A] border border-white/8 rounded-3xl p-8 overflow-hidden hover:border-white/12 transition-colors">
                  {/* Top row */}
                  <div className="flex items-start justify-between mb-6">
                    <div>
                      <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{app.badge}</span>
                      <h3 className="text-2xl font-black text-white mt-1">{app.name}</h3>
                      <p className="text-base font-medium text-slate-400 mt-0.5">{app.tagline}</p>
                    </div>
                    <div className={`p-3 bg-gradient-to-br ${app.gradient} rounded-2xl`}>
                      <Icon className="w-6 h-6 text-white" />
                    </div>
                  </div>

                  <p className="text-slate-400 mb-6 leading-relaxed">{app.description}</p>

                  {/* Highlights */}
                  <ul className="space-y-2.5 mb-8">
                    {app.highlights.map((h) => (
                      <li key={h} className="flex items-center gap-3 text-sm text-slate-300">
                        <div className={`w-1.5 h-1.5 rounded-full bg-gradient-to-r ${app.gradient} flex-shrink-0`} />
                        {h}
                      </li>
                    ))}
                  </ul>

                  {/* Footer row */}
                  <div className="flex items-center justify-between pt-4 border-t border-white/5">
                    <div>
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${app.statusColor}`}>
                        <span className="w-1.5 h-1.5 rounded-full bg-current" />
                        {app.status}
                      </span>
                      <p className="text-xs text-slate-600 mt-1.5">{app.platform}</p>
                    </div>
                    <button className={`inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r ${app.gradient} text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity`}>
                      Learn More <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
