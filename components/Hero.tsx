'use client'

import { motion } from 'framer-motion'
import { Music, Zap, Headphones } from 'lucide-react'

export default function Hero() {
  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-purple-900/20 via-blue-900/20 to-black" />
      
      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8 }}
          className="space-y-8"
        >
          <div className="flex justify-center space-x-4 mb-8">
            <Music className="w-12 h-12 text-purple-400 animate-pulse" />
            <Zap className="w-12 h-12 text-blue-400 animate-pulse" />
            <Headphones className="w-12 h-12 text-green-400 animate-pulse" />
          </div>

          <h1 className="text-5xl md:text-7xl font-bold">
            <span className="gradient-text">Ultimatelabs</span>
          </h1>

          <p className="text-xl md:text-2xl text-gray-300 max-w-3xl mx-auto">
            The ultimate ecosystem for modern music creators. 
            Professional AI-powered tools that transform your creative workflow.
          </p>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.5, duration: 0.8 }}
            className="pt-8"
          >
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <a
                href="#apps"
                className="px-8 py-4 bg-gradient-to-r from-purple-600 to-blue-600 rounded-lg font-semibold text-lg hover:from-purple-700 hover:to-blue-700 transition-all transform hover:scale-105"
              >
                Explore Apps
              </a>
              <a
                href="#features"
                className="px-8 py-4 border-2 border-purple-500 rounded-lg font-semibold text-lg hover:bg-purple-500/10 transition-all"
              >
                Learn More
              </a>
            </div>
          </motion.div>

          <p className="text-gray-400 text-sm pt-4">
            Built for musicians, producers, and audio engineers
          </p>
        </motion.div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-black to-transparent" />
    </section>
  )
}