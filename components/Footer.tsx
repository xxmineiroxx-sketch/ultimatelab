import { Music, Heart } from 'lucide-react'

export default function Footer() {
  return (
    <footer className="bg-black border-t border-gray-800 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="grid md:grid-cols-4 gap-8 mb-8">
          <div className="md:col-span-2">
            <div className="flex items-center space-x-3 mb-4">
              <Music className="w-8 h-8 text-purple-400" />
              <span className="text-2xl font-bold gradient-text">Ultimatelabs</span>
            </div>
            <p className="text-gray-400 max-w-md">
              The ultimate ecosystem for modern music creators. Professional AI-powered tools 
              that transform your creative workflow.
            </p>
          </div>

          <div>
            <h4 className="font-semibold mb-4">Apps</h4>
            <ul className="space-y-2 text-gray-400">
              <li><a href="#" className="hover:text-white transition-colors">Ultimate Musician</a></li>
              <li><a href="#" className="hover:text-white transition-colors">Ultimate Playback</a></li>
              <li><a href="#" className="hover:text-white transition-colors">Documentation</a></li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold mb-4">Connect</h4>
            <ul className="space-y-2 text-gray-400">
              <li><a href="#" className="hover:text-white transition-colors">Twitter</a></li>
              <li><a href="#" className="hover:text-white transition-colors">GitHub</a></li>
              <li><a href="#" className="hover:text-white transition-colors">Contact</a></li>
            </ul>
          </div>
        </div>

        <div className="border-t border-gray-800 pt-8 text-center">
          <p className="text-gray-400 flex items-center justify-center space-x-2">
            <span>Built with</span>
            <Heart className="w-4 h-4 text-red-500" />
            <span>for musicians everywhere</span>
          </p>
          <p className="text-gray-500 text-sm mt-2">
            © 2024 Ultimatelabs. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  )
}