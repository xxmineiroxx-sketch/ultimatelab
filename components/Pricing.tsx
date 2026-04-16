'use client'

import { motion } from 'framer-motion'
import { Check } from 'lucide-react'

const PLANS = [
  {
    name: 'Starter',
    price: { monthly: 29, annual: 24 },
    description: 'Perfect for single-location churches getting started.',
    highlight: false,
    features: [
      'Up to 25 team members',
      'Unlimited service plans',
      'AI stem separation (10/mo)',
      'Mobile apps (iOS & Android)',
      'Team availability calendar',
      'Basic analytics',
    ],
    cta: 'Start Free Trial',
    ctaStyle: 'border border-white/10 hover:border-white/20 text-white hover:bg-white/5',
  },
  {
    name: 'Growth',
    price: { monthly: 79, annual: 65 },
    description: 'For growing churches with active music departments.',
    highlight: true,
    features: [
      'Up to 100 team members',
      'Unlimited AI stem separation',
      'Live Sunday mode & cue sync',
      'Planning Center integration',
      'Webhooks & notifications',
      'Advanced analytics',
      'Priority support',
    ],
    cta: 'Start Free Trial',
    ctaStyle: 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30',
  },
  {
    name: 'Network',
    price: { monthly: 199, annual: 165 },
    description: 'Multi-campus organizations with multiple locations.',
    highlight: false,
    features: [
      'Unlimited team members',
      'Multi-campus admin hub',
      'Cross-campus library sync',
      'Campus-level analytics',
      'Custom org branding',
      'SSO / SAML (coming soon)',
      'Dedicated account manager',
    ],
    cta: 'Contact Sales',
    ctaStyle: 'border border-white/10 hover:border-white/20 text-white hover:bg-white/5',
  },
]

export default function Pricing() {
  return (
    <section id="pricing" className="py-24 px-4 sm:px-6 lg:px-8 bg-[#0A0F1E]">
      <div className="max-w-6xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-16"
        >
          <span className="inline-block px-3 py-1 mb-4 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-sm font-medium">
            Simple Pricing
          </span>
          <h2 className="text-4xl md:text-5xl font-black text-white mb-4">
            Plans for every{' '}
            <span className="bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
              size church
            </span>
          </h2>
          <p className="text-lg text-slate-400 max-w-xl mx-auto">
            Start free, no credit card required. Upgrade when your team is ready.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-6 items-start">
          {PLANS.map((plan, i) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className={`relative rounded-2xl p-8 ${
                plan.highlight
                  ? 'bg-indigo-600/10 border-2 border-indigo-500/50'
                  : 'bg-[#0F172A] border border-white/5'
              }`}
            >
              {plan.highlight && (
                <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                  <span className="px-3 py-1 bg-indigo-600 text-white text-xs font-bold rounded-full uppercase tracking-wide">
                    Most Popular
                  </span>
                </div>
              )}

              <div className="mb-6">
                <h3 className="text-lg font-bold text-white mb-1">{plan.name}</h3>
                <p className="text-sm text-slate-400 mb-4">{plan.description}</p>
                <div className="flex items-end gap-1">
                  <span className="text-4xl font-black text-white">${plan.price.monthly}</span>
                  <span className="text-slate-400 mb-1.5">/month</span>
                </div>
                <p className="text-xs text-slate-500 mt-1">per organization · billed monthly</p>
              </div>

              <ul className="space-y-3 mb-8">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-3 text-sm">
                    <Check className="w-4 h-4 text-indigo-400 mt-0.5 flex-shrink-0" />
                    <span className="text-slate-300">{f}</span>
                  </li>
                ))}
              </ul>

              <button className={`w-full py-3 px-6 rounded-xl font-semibold text-sm transition-all ${plan.ctaStyle}`}>
                {plan.cta}
              </button>
            </motion.div>
          ))}
        </div>

        <p className="text-center text-slate-500 text-sm mt-8">
          All plans include a 14-day free trial. No credit card required.
        </p>
      </div>
    </section>
  )
}
