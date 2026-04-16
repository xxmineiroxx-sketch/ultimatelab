import Navbar from '@/components/Navbar'
import Hero from '@/components/Hero'
import SocialProof from '@/components/SocialProof'
import HowItWorks from '@/components/HowItWorks'
import Features from '@/components/Features'
import AppShowcase from '@/components/AppShowcase'
import Pricing from '@/components/Pricing'
import Testimonials from '@/components/Testimonials'
import CTASection from '@/components/CTASection'
import Footer from '@/components/Footer'

export default function Home() {
  return (
    <main className="min-h-screen bg-[#020617] text-white">
      <Navbar />
      <Hero />
      <SocialProof />
      <HowItWorks />
      <Features />
      <AppShowcase />
      <Pricing />
      <Testimonials />
      <CTASection />
      <Footer />
    </main>
  )
}
