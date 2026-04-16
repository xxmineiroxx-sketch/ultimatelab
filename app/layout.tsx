import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })

export const metadata: Metadata = {
  title: 'Ultimatelabs — The Worship Team Platform',
  description:
    'Plan services, rehearse with AI stem tracks, coordinate your team, and run seamless Sunday experiences. Built for modern worship teams and multi-campus churches.',
  keywords:
    'worship team software, church service planning, stem separation, worship leader tools, multi-campus church management, ultimate musician, ultimate playback',
  authors: [{ name: 'Ultimatelabs' }],
  openGraph: {
    title: 'Ultimatelabs — The Worship Team Platform',
    description:
      'Plan services, rehearse with AI stem tracks, coordinate your team, and run seamless Sunday experiences.',
    type: 'website',
    url: 'https://ultimatelabs.co',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Ultimatelabs — The Worship Team Platform',
    description: 'Plan. Rehearse. Lead. The all-in-one platform for modern worship teams.',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  )
}
