'use client'

import { motion } from 'framer-motion'
import { Zap, Shield, Code, Cloud, Cpu, Users } from 'lucide-react'

const features = [
  {
    icon: Cpu,
    title: 'AI-Powered',
    description: '14 specialized AI engines for music analysis, mixing, and production assistance.',
    color: 'text-purple-400',
  },
  {
    icon: Zap,
    title: 'Real-Time Processing',
    description: 'WebSocket connectivity for live collaboration and real-time audio analysis.',
    color: 'text-yellow-400',
  },
  {
    icon: Shield,
    title: 'Secure & Reliable',
    description: 'Enterprise-grade security with JWT authentication and role-based access control.',
    color: 'text-green-400',
  },
  {
    icon: Cloud,
    title: 'Cloud Native',
    description: 'Built for scale with Docker, Kubernetes, and Helm deployments.',
    color: 'text-blue-400',
  },
  {
    icon: Users,
    title: 'Collaborative',
    description: 'Real-time collaboration features for teams and remote production.',
    color: 'text-pink-400',
  },
  {
    icon: Code,
    title: 'Developer Friendly',
    description: 'RESTful APIs, WebSocket endpoints, and comprehensive documentation.',
    color: 'text-cyan-400',
  },
]

export default function Features() {
  return (
    <section id="features" className="py-20 px-4 sm:px-6 lg:px-8 bg-gradient-to-b from-gray-900/50 to-black">
      <div className="max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-4xl md:text-5xl font-bold mb-6">
            Why Choose <span className="gradient-text">Ultimatelabs</span>?
          </h2>
          <p className="text-xl text-gray-400 max-w-3xl mx-auto">
            Built by musicians for musicians, our ecosystem combines cutting-edge AI 
            with intuitive design to supercharge your creative process.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature, index) => {
            const Icon = feature.icon
            return (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, delay: index * 0.1 }}
                className="text-center group"
              >
                <div className="inline-block p-4 bg-gray-800/50 rounded-2xl mb-6 group-hover:bg-gray-800/70 transition-all">
                  <Icon className={`w-8 h-8 ${feature.color}`} />
                </div>
                <h3 className="text-xl font-bold mb-4">{feature.title}</h3>
                <p className="text-gray-400">{feature.description}</p>
              </motion.div>
            )
          })}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8, delay: 0.3 }}
          className="mt-20 text-center"
        >
          <div className="bg-gradient-to-r from-purple-900/20 to-blue-900/20 rounded-2xl p-8 border border-purple-500/20">
            <h3 className="text-2xl font-bold mb-4">Ready to Transform Your Music Production?</h3>
            <p className="text-gray-300 mb-8 max-w-2xl mx-auto">
              Join thousands of musicians, producers, and audio engineers who are already 
              using Ultimatelabs to create amazing music.
            </p>
            <button className="px-8 py-4 bg-gradient-to-r from-purple-600 to-blue-600 rounded-lg font-semibold text-lg hover:from-purple-700 hover:to-blue-700 transition-all transform hover:scale-105">
              Get Started Today
            </button>
          </div>
        </motion.div>
      </div>
    </section>
  )
}