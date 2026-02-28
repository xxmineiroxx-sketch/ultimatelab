import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Ultimatelab - Music Production Ecosystem',
  description: 'Professional music production tools powered by AI. Ultimate Musician and Ultimate Playback apps for modern creators.',
  keywords: 'music production, AI, audio, ultimate musician, ultimate playback, DAW, mixing',
  authors: [{ name: 'Ultimatelab' }],
  openGraph: {
    title: 'Ultimatelab - Music Production Ecosystem',
    description: 'Professional music production tools powered by AI',
    type: 'website',
    url: 'https://ultimatelab.co',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="font-sans">{children}</body>
    </html>
  )
}