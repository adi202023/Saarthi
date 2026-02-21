import { useState, useEffect } from "react"
import { Link } from "react-router-dom"
import { WalletSection } from "../components/WalletSection"

export default function WalletPage() {
  const [navScrolled, setNavScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setNavScrolled(window.scrollY > 60)
    window.addEventListener("scroll", onScroll)
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <div className="min-h-screen relative overflow-x-hidden bg-[#0B0B0F]">
      <header className={`fixed top-0 left-0 right-0 z-50 px-6 py-4 flex items-center justify-between transition-all duration-300 ${navScrolled ? "bg-[#0B0B0F]/70 backdrop-blur-xl border-b border-white/5" : "bg-transparent"}`}>
        <Link to="/" className="text-white font-bold text-lg tracking-tight">Sahayak</Link>
        <nav className="flex items-center gap-8">
          <span className="text-white text-sm font-medium border-b border-[#7C3AED] pb-0.5">Wallet</span>
          <Link to="/cab" className="text-[#A1A1AA] hover:text-white text-sm font-medium transition-colors duration-300">Cab</Link>
          <Link to="/police" className="text-[#A1A1AA] hover:text-white text-sm font-medium transition-colors duration-300">Police</Link>
        </nav>
      </header>

      <div className="fixed inset-0 -z-10" style={{ backgroundImage: "url('/background-4k-BqzvgkMx%20(2).svg')", backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat", backgroundAttachment: "fixed" }} />
      <div className="fixed inset-0 -z-[9] bg-[#0B0B0F]/40" />

      <div className="pt-24">
        <WalletSection />
      </div>
    </div>
  )
}
