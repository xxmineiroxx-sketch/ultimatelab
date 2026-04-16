'use client'

import { motion } from 'framer-motion'

const TESTIMONIALS = [
  {
    quote:
      "We went from email chains and spreadsheets to having everything in one place. Our worship team is more prepared than they've ever been. The stem separation alone is worth it.",
    name: 'Marcus T.',
    title: 'Worship Director',
    church: 'Grace Community Church',
    initials: 'MT',
    color: 'from-indigo-500 to-blue-500',
  },
  {
    quote:
      "Running three campuses used to mean three separate emails, three spreadsheets, three headaches. Now I push the service plan from one place and all three locations have it instantly.",
    name: 'Sarah L.',
    title: 'Central Music Director',
    church: 'Harvest Family Church (3 campuses)',
    initials: 'SL',
    color: 'from-purple-500 to-pink-500',
  },
  {
    quote:
      "Our vocalists used to show up to rehearsal barely knowing their parts. Now they practice with their own isolated vocal track all week. The difference in rehearsal quality is night and day.",
    name: 'David R.',
    title: 'Music Pastor',
    church: 'Cornerstone Worship Center',
    initials: 'DR',
    color: 'from-pink-500 to-rose-500',
  },
]

export default function Testimonials() {
  return (
    <section className="py-24 px-4 sm:px-6 lg:px-8 bg-[#020617]">
      <div className="max-w-6xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <span className="inline-block px-3 py-1 mb-4 rounded-full bg-pink-500/10 border border-pink-500/20 text-pink-400 text-sm font-medium">
            What Teams Are Saying
          </span>
          <h2 className="text-4xl md:text-5xl font-black text-white">
            Loved by worship teams
          </h2>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-6">
          {TESTIMONIALS.map((t, i) => (
            <motion.div
              key={t.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="bg-[#0F172A] border border-white/5 rounded-2xl p-6 hover:border-white/10 transition-colors"
            >
              {/* Stars */}
              <div className="flex gap-1 mb-4">
                {[...Array(5)].map((_, s) => (
                  <span key={s} className="text-amber-400 text-sm">★</span>
                ))}
              </div>

              <blockquote className="text-slate-300 text-sm leading-relaxed mb-6">
                "{t.quote}"
              </blockquote>

              <div className="flex items-center gap-3 pt-4 border-t border-white/5">
                <div className={`w-10 h-10 rounded-full bg-gradient-to-br ${t.color} flex items-center justify-center text-white font-bold text-sm flex-shrink-0`}>
                  {t.initials}
                </div>
                <div>
                  <div className="text-white font-semibold text-sm">{t.name}</div>
                  <div className="text-slate-500 text-xs">{t.title} · {t.church}</div>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
