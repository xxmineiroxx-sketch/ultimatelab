'use client'

import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'

export default function CTASection() {
  return (
    <section className="py-24 px-4 sm:px-6 lg:px-8 bg-[#0A0F1E]">
      <div className="max-w-4xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="relative rounded-3xl overflow-hidden"
        >
          {/* Background */}
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-600/20 via-purple-600/15 to-pink-600/10" />
          <div className="absolute inset-0 border border-indigo-500/20 rounded-3xl" />
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[200px] bg-indigo-600/15 blur-[80px] rounded-full" />

          <div className="relative px-8 py-16 text-center">
            <h2 className="text-4xl md:text-5xl font-black text-white mb-4 leading-tight">
              Ready to transform your{' '}
              <span className="bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
                worship team?
              </span>
            </h2>
            <p className="text-lg text-slate-400 max-w-xl mx-auto mb-10">
              Join hundreds of churches already using Ultimatelabs to run more prepared,
              more connected Sunday experiences.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <a
                href="#pricing"
                className="group inline-flex items-center justify-center gap-2 px-8 py-4 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-xl transition-all shadow-lg shadow-indigo-600/30 hover:-translate-y-0.5"
              >
                Start Free — No Card Needed
                <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
              </a>
              <a
                href="mailto:hello@ultimatelabs.co"
                className="inline-flex items-center justify-center gap-2 px-8 py-4 border border-white/10 hover:border-white/20 text-white font-semibold rounded-xl transition-all hover:bg-white/5"
              >
                Talk to Sales
              </a>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  )
}
