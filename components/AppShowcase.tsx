'use client'

import { motion } from 'framer-motion'
import { Smartphone, Monitor, Download, ExternalLink } from 'lucide-react'

const apps = [
  {
    id: 'musician',
    name: 'Ultimate Musician',
    description: 'Your all-in-one music companion for practice, performance, and creation.',
    features: [
      'Sheet music library and organization',
      'Practice tracking and metronome',
      'Setlist management for live shows',
      'Integration with Ultimate Playback',
    ],
    platform: 'macOS',
    status: 'available',
    icon: Monitor,
    gradient: 'from-blue-500 to-cyan-600',
  },
  {
    id: 'playback',
    name: 'Ultimate Playback (Cinestage)',
    description: 'AI-powered music production assistant with 14 specialized engines.',
    features: [
      'AI mixing and mastering analysis',
      '14 specialized AI engines',
      'Real-time audio processing',
      'WebSocket connectivity for live collaboration',
    ],
    platform: 'Web/Mobile',
    status: 'beta',
    icon: Smartphone,
    gradient: 'from-purple-500 to-pink-600',
  },
]

export default function AppShowcase() {
  return (
    <section id="apps" className="py-20 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <h2 className="text-4xl md:text-5xl font-bold mb-6">
            Our <span className="gradient-text">Applications</span>
          </h2>
          <p className="text-xl text-gray-400 max-w-3xl mx-auto">
            Two powerful tools designed to work seamlessly together, 
            creating the ultimate music production ecosystem.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 gap-8 lg:gap-12">
          {apps.map((app, index) => {
            const Icon = app.icon
            return (
              <motion.div
                key={app.id}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6, delay: index * 0.2 }}
                className="group relative"
              >
                <div className={`absolute inset-0 bg-gradient-to-r ${app.gradient} rounded-2xl blur-xl opacity-20 group-hover:opacity-30 transition-opacity`} />
                
                <div className="relative bg-gray-900/50 backdrop-blur-sm border border-gray-800 rounded-2xl p-8 hover:border-gray-700 transition-all">
                  <div className="flex items-start space-x-4 mb-6">
                    <div className={`p-3 bg-gradient-to-r ${app.gradient} rounded-xl`}>
                      <Icon className="w-8 h-8 text-white" />
                    </div>
                    <div className="flex-1">
                      <h3 className="text-2xl font-bold mb-2">{app.name}</h3>
                      <span className={`inline-block px-3 py-1 text-xs font-semibold rounded-full ${
                        app.status === 'available' 
                          ? 'bg-green-500/20 text-green-400' 
                          : 'bg-yellow-500/20 text-yellow-400'
                      }`}>
                        {app.status === 'available' ? 'Available Now' : 'In Beta'}
                      </span>
                    </div>
                  </div>

                  <p className="text-gray-300 mb-6 text-lg">
                    {app.description}
                  </p>

                  <ul className="space-y-3 mb-8">
                    {app.features.map((feature, idx) => (
                      <li key={idx} className="flex items-start space-x-3">
                        <div className={`w-2 h-2 rounded-full bg-gradient-to-r ${app.gradient} mt-2 flex-shrink-0`} />
                        <span className="text-gray-400">{feature}</span>
                      </li>
                    ))}
                  </ul>

                  <div className="flex flex-col sm:flex-row gap-4">
                    <button className={`flex-1 px-6 py-3 bg-gradient-to-r ${app.gradient} rounded-lg font-semibold hover:opacity-90 transition-opacity flex items-center justify-center space-x-2`}>
                      <Download className="w-5 h-5" />
                      <span>Download</span>
                    </button>
                    <button className="px-6 py-3 border border-gray-600 rounded-lg font-semibold hover:bg-white/5 transition-all flex items-center justify-center space-x-2">
                      <ExternalLink className="w-5 h-5" />
                      <span>Learn More</span>
                    </button>
                  </div>

                  <p className="text-sm text-gray-500 mt-4">
                    Platform: {app.platform}
                  </p>
                </div>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}