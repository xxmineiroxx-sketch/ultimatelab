import Hero from '@/components/Hero'
import AppShowcase from '@/components/AppShowcase'
import Features from '@/components/Features'
import Footer from '@/components/Footer'

export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white">
      <Hero />
      <AppShowcase />
      <Features />
      <Footer />
    </main>
  )
}