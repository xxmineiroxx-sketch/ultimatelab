'use client'

import { motion } from 'framer-motion'
import { CalendarDays, Users, Music2, Radio, Building2, BarChart3 } from 'lucide-react'

const FEATURES = [
  {
    icon: CalendarDays,
    title: 'Service Planning',
    description: 'Build setlists, assign keys and roles to each song, lock the plan when ready, and publish to the entire team in one tap.',
    accent: '#6366F1',
  },
  {
    icon: Music2,
    title: 'AI Stem Separation',
    description: 'Upload any song and get 6 separated stem tracks in minutes — vocals, harmonies, keys, guitar, bass, drums — perfect for individual practice.',
    accent: '#8B5CF6',
  },
  {
    icon: Users,
    title: 'Team Coordination',
    description: 'Assign roles, send availability requests, track blockouts, and get real-time coverage forecasts before each service.',
    accent: '#EC4899',
  },
  {
    icon: Radio,
    title: 'Live Sunday Mode',
    description: 'Lead your band in real time — tap a section and every musician\'s screen syncs instantly. Section cues, tempo, and transitions all coordinated.',
    accent: '#F59E0B',
  },
  {
    icon: Building2,
    title: 'Multi-Campus Management',
    description: 'Manage all campus locations from a central dashboard. Push your song library and standards to every campus. Each location stays autonomous.',
    accent: '#10B981',
  },
  {
    icon: BarChart3,
    title: 'Analytics & Insights',
    description: 'See which songs you use most, track team attendance trends, and measure role coverage across your organization over time.',
    accent: '#0EA5E9',
  },
]

export default function Features() {
  return (
    <section id="features" className="py-24 px-4 sm:px-6 lg:px-8 bg-[#0A0F1E]">
      <div className="max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <span className="inline-block px-3 py-1 mb-4 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-sm font-medium">
            Everything You Need
          </span>
          <h2 className="text-4xl md:text-5xl font-black text-white mb-4">
            Built for how{' '}
            <span className="bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
              worship teams actually work
            </span>
          </h2>
          <p className="text-lg text-slate-400 max-w-2xl mx-auto">
            Not a generic project management tool. Purpose-built for church music departments, worship directors, and multi-campus organizations.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {FEATURES.map((f, i) => {
            const Icon = f.icon
            return (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.08 }}
                className="group relative bg-[#0F172A] border border-white/5 rounded-2xl p-6 hover:border-white/10 transition-all hover:-translate-y-0.5"
              >
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
                  style={{ backgroundColor: `${f.accent}20` }}
                >
                  <Icon className="w-5 h-5" style={{ color: f.accent }} />
                </div>
                <h3 className="text-lg font-bold text-white mb-2">{f.title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed">{f.description}</p>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
