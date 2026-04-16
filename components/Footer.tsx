import { Mail } from 'lucide-react'

export default function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="bg-[#020617] border-t border-white/5 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="grid md:grid-cols-4 gap-8 mb-10">
          {/* Brand */}
          <div className="md:col-span-2">
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold text-xs">U</div>
              <span className="text-lg font-bold text-white">Ultimatelabs</span>
            </div>
            <p className="text-slate-400 text-sm max-w-xs leading-relaxed">
              The all-in-one platform for worship teams and multi-campus churches. Plan. Rehearse. Lead.
            </p>
            <a href="mailto:hello@ultimatelabs.co" className="inline-flex items-center gap-2 mt-4 text-sm text-slate-500 hover:text-slate-300 transition-colors">
              <Mail className="w-3.5 h-3.5" />
              hello@ultimatelabs.co
            </a>
          </div>

          {/* Platform */}
          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">Platform</h4>
            <ul className="space-y-2.5">
              {['Ultimate Musician', 'Ultimate Playback', 'CineStage AI', 'Pricing'].map((item) => (
                <li key={item}>
                  <a href="#" className="text-sm text-slate-500 hover:text-white transition-colors">{item}</a>
                </li>
              ))}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">Company</h4>
            <ul className="space-y-2.5">
              {[
                { label: 'Sign In', href: '/portal' },
                { label: 'Contact', href: 'mailto:hello@ultimatelabs.co' },
                { label: 'Privacy Policy', href: '#' },
                { label: 'Terms of Service', href: '#' },
              ].map((item) => (
                <li key={item.label}>
                  <a href={item.href} className="text-sm text-slate-500 hover:text-white transition-colors">{item.label}</a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="border-t border-white/5 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-slate-600 text-sm">
            © {year} Ultimatelabs.co · All rights reserved.
          </p>
          <p className="text-slate-700 text-xs">
            Built for churches that take worship seriously.
          </p>
        </div>
      </div>
    </footer>
  )
}
