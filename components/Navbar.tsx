'use client'

import { useState, useEffect } from 'react'
import { Menu, X } from 'lucide-react'
import Logo from './Logo'

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', onScroll)
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const links = [
    { label: 'Features', href: '#features' },
    { label: 'How It Works', href: '#how-it-works' },
    { label: 'Pricing', href: '#pricing' },
  ]

  return (
    <header className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${scrolled ? 'bg-[#020617]/95 backdrop-blur-md border-b border-white/5 shadow-xl' : 'bg-transparent'}`}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <a href="/">
            <Logo size={32} showText={true} animate={true} />
          </a>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-8">
            {links.map(l => (
              <a key={l.href} href={l.href} className="text-sm text-slate-400 hover:text-white transition-colors">{l.label}</a>
            ))}
          </nav>

          {/* CTA */}
          <div className="hidden md:flex items-center gap-3">
            <a href="/portal" className="text-sm text-slate-400 hover:text-white transition-colors">Sign In</a>
            <a href="#pricing" className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-lg transition-colors">
              Get Started
            </a>
          </div>

          {/* Mobile menu toggle */}
          <button className="md:hidden p-2 text-slate-400" onClick={() => setOpen(!open)}>
            {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {open && (
        <div className="md:hidden bg-[#0F172A] border-b border-white/5 px-4 pb-4">
          <div className="py-3 border-b border-white/5 mb-1">
            <a href="/" onClick={() => setOpen(false)}>
              <Logo size={28} showText={true} animate={true} />
            </a>
          </div>
          {links.map(l => (
            <a key={l.href} href={l.href} onClick={() => setOpen(false)} className="block py-3 text-slate-300 border-b border-white/5 last:border-0">{l.label}</a>
          ))}
          <a href="#pricing" className="mt-4 block text-center px-4 py-3 bg-indigo-600 text-white font-semibold rounded-lg">Get Started</a>
        </div>
      )}
    </header>
  )
}
