import { useRef, useEffect, useState } from "react"
import { motion, useInView } from "framer-motion"
import { Link } from "react-router-dom"
import gsap from "gsap"
import { Lock, Car, Radio, Shield, MapPin, AlertTriangle } from "lucide-react"

const fadeUp = { initial: { opacity: 0, y: 24 }, animate: { opacity: 1, y: 0 } }

function Section({ children, className = "", id }: { children: React.ReactNode; className?: string; id?: string }) {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true, margin: "-80px" })
  return (
    <motion.section ref={ref} id={id} initial="initial" animate={inView ? "animate" : "initial"} variants={{ initial: {}, animate: { transition: { staggerChildren: 0.1 } } }} className={className}>
      {children}
    </motion.section>
  )
}

export default function HomePage() {
  const heroRef = useRef<HTMLDivElement>(null)
  const headlineRef = useRef<HTMLHeadingElement>(null)
  const gradientRef = useRef<HTMLHeadingElement>(null)
  const subheadRef = useRef<HTMLParagraphElement>(null)
  const paraRef = useRef<HTMLParagraphElement>(null)
  const ctaRef = useRef<HTMLDivElement>(null)
  const [navScrolled, setNavScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setNavScrolled(window.scrollY > 60)
    window.addEventListener("scroll", onScroll)
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  useEffect(() => {
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } })
      tl.fromTo(headlineRef.current, { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.9 })
        .fromTo(gradientRef.current, { opacity: 0, filter: "blur(8px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.8 }, "-=0.5")
        .fromTo(subheadRef.current, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.6 }, "-=0.5")
        .fromTo(paraRef.current, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.6 }, "-=0.3")
        .fromTo(ctaRef.current ? Array.from(ctaRef.current.children) : [], { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.1 }, "-=0.4")
    }, heroRef)
    return () => ctx.revert()
  }, [])

  return (
    <div className="min-h-screen relative overflow-x-hidden bg-[#0B0B0F]">
      <header className={`fixed top-0 left-0 right-0 z-50 px-6 py-4 flex items-center justify-between transition-all duration-300 ${navScrolled ? "bg-[#0B0B0F]/70 backdrop-blur-xl border-b border-white/5" : "bg-transparent"}`}>
        <Link to="/" className="text-white font-bold text-lg tracking-tight">Sahayak</Link>
        <nav className="flex items-center gap-8">
          <Link to="/wallet" className="text-[#A1A1AA] hover:text-white text-sm font-medium transition-colors duration-300">Wallet</Link>
          <Link to="/cab" className="text-[#A1A1AA] hover:text-white text-sm font-medium transition-colors duration-300">Cab</Link>
          <Link to="/police" className="text-[#A1A1AA] hover:text-white text-sm font-medium transition-colors duration-300">Police</Link>
        </nav>
      </header>

      <section ref={heroRef} className="relative min-h-screen flex flex-col items-center justify-center px-6 pt-20 pb-24 overflow-hidden">
        <div className="absolute inset-0 -z-10" style={{ backgroundImage: "url('/background-4k-BqzvgkMx%20(2).svg')", backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat", backgroundAttachment: "fixed" }} />
        <div className="absolute inset-0 -z-[9] bg-[#0B0B0F]/30" />
        <div className="absolute inset-0 -z-[9] pointer-events-none" style={{ background: "radial-gradient(ellipse 80% 50% at 50% 50%, rgba(124, 58, 237, 0.08) 0%, transparent 60%)" }} />

        <div className="text-center max-w-[1200px] mx-auto relative z-10">
          <h1 ref={headlineRef} className="text-[clamp(2.5rem,5vw,4.5rem)] font-extrabold leading-[1.2] tracking-tight text-white mb-3" style={{ fontWeight: 800 }}>
            Sahayak
          </h1>
          <h2 ref={gradientRef} className="text-[clamp(1.5rem,3.5vw,2.5rem)] font-bold tracking-tight mb-4" style={{ fontWeight: 700 }}>
            <span className="bg-gradient-to-r from-[#7C3AED] to-[#2563EB] bg-clip-text text-transparent">Privacy-First</span> Digital Safety Infrastructure
          </h2>
          <p ref={subheadRef} className="text-[#A1A1AA] text-base md:text-lg font-medium max-w-[700px] mx-auto mb-4">
            Cryptographic Identity. Smart Geo-Fencing. Resilient Emergency Protection.
          </p>
          <p ref={paraRef} className="text-[#A1A1AA]/90 text-sm md:text-base max-w-[600px] mx-auto mb-10 leading-relaxed">
            Sahayak protects individuals using cryptographic proof instead of storing sensitive data.
          </p>
          <div ref={ctaRef} className="flex flex-col sm:flex-row gap-4 justify-center items-center">
            <Link to="/wallet" className="px-8 py-4 rounded-xl font-semibold text-white bg-gradient-to-r from-[#7C3AED] to-[#2563EB] hover:shadow-[0_0_30px_rgba(124,58,237,0.4)] transition-all duration-300 hover:scale-[1.05]">
              Explore the System
            </Link>
            <button className="px-8 py-4 rounded-xl font-semibold text-white border border-white/20 hover:border-white/40 hover:bg-white/5 transition-all duration-300 hover:scale-[1.05]">
              View Demo
            </button>
          </div>
        </div>

        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 2, duration: 0.6 }} className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
          <span className="text-[#A1A1AA]/70 text-xs tracking-widest uppercase">Scroll</span>
          <motion.div animate={{ y: [0, 6, 0] }} transition={{ repeat: Infinity, duration: 2, ease: "easeInOut" }} className="w-px h-6 bg-gradient-to-b from-[#7C3AED]/50 to-transparent" />
        </motion.div>
      </section>

      <div className="relative bg-[#0B0B0F]">
        <Section id="about" className="px-6 py-24 max-w-5xl mx-auto">
          <motion.h2 variants={fadeUp} className="text-3xl md:text-4xl font-bold text-[#e8e4e0] mb-4">The Problem</motion.h2>
          <motion.p variants={fadeUp} className="text-[#a8a29e] text-lg mb-12 max-w-2xl">
            Traditional platforms store raw personal data. Sahayak uses cryptographic proof instead—with intelligent route monitoring and secure emergency escalation.
          </motion.p>
          <div className="grid md:grid-cols-2 gap-4">
            {[
              { icon: Shield, title: "Raw Identity Storage", desc: "Platforms store unencrypted personal data in centralized servers." },
              { icon: AlertTriangle, title: "Centralized Data Leaks", desc: "Central points of failure mean one hack compromises entire user bases." },
              { icon: MapPin, title: "Ride-Sharing Safety Gaps", desc: "Women and vulnerable users face risks with limited real-time monitoring." },
              { icon: Radio, title: "Emergency Connectivity Failures", desc: "Internet outages during disasters cut off the very systems meant to save lives." },
            ].map(({ icon: Icon, title, desc }, i) => (
              <motion.div key={i} variants={fadeUp} className="rounded-xl border border-[rgba(86,79,77,0.5)] bg-[rgba(47,37,35,0.6)] backdrop-blur-xl p-6 hover:bg-[rgba(47,37,35,0.75)] hover:border-[#e1d9d0]/30 transition-all duration-300">
                <Icon className="w-8 h-8 text-[#e1d9d0] mb-4" />
                <h3 className="text-lg font-semibold text-[#e8e4e0] mb-2">{title}</h3>
                <p className="text-[#a8a29e] text-sm">{desc}</p>
              </motion.div>
            ))}
          </div>
        </Section>

        <Section id="architecture" className="px-6 py-24 bg-gradient-to-b from-transparent via-[rgba(47,37,35,0.15)] to-transparent">
          <motion.h2 variants={fadeUp} className="text-3xl md:text-4xl font-bold text-[#e8e4e0] mb-4 text-center">Our Solution</motion.h2>
          <motion.p variants={fadeUp} className="text-[#a8a29e] text-lg mb-16 text-center max-w-2xl mx-auto">Three pillars of privacy-first infrastructure.</motion.p>
          <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {[
              { id: "identity", icon: Lock, title: "Cryptographic Identity Vault", desc: "Store only hashes—never raw IDs. Prove identity without exposing data." },
              { id: "cab", icon: Car, title: "GPS-Based Smart Cab Monitoring", desc: "Real-time geo-fencing and deviation detection for ride safety." },
              { id: "police", icon: Radio, title: "Multi-Layer Emergency Relay", desc: "Internet + SMS + mesh fallbacks so alerts get through when it matters." },
            ].map(({ id, icon: Icon, title, desc }, i) => (
              <motion.div key={i} id={id} variants={fadeUp} className="rounded-xl border border-[rgba(86,79,77,0.5)] bg-[rgba(47,37,35,0.6)] backdrop-blur-xl p-6 hover:scale-[1.02] hover:border-[#e1d9d0]/40 hover:shadow-xl transition-all duration-300">
                <Icon className="w-10 h-10 text-[#e1d9d0] mb-4" />
                <h3 className="text-lg font-semibold text-[#e8e4e0] mb-2">{title}</h3>
                <p className="text-[#a8a29e] text-sm">{desc}</p>
              </motion.div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  )
}
