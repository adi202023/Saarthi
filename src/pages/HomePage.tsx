import { useRef, useEffect, useState } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Link } from "react-router-dom"
import * as THREE from "three"
import { Lock, Car, Radio, Shield, MapPin, AlertTriangle } from "lucide-react"
import { useInView } from "framer-motion"

// ── Below-fold section helper ───────────────────────────────────────────────
const fadeUp = { initial: { opacity: 0, y: 24 }, animate: { opacity: 1, y: 0 } }

function Section({ children, className = "", id }: { children: React.ReactNode; className?: string; id?: string }) {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true, margin: "-80px" })
  return (
    <motion.section ref={ref} id={id}
      initial="initial" animate={inView ? "animate" : "initial"}
      variants={{ initial: {}, animate: { transition: { staggerChildren: 0.1 } } }}
      className={className}>
      {children}
    </motion.section>
  )
}

// ── Subtle particle layer ───────────────────────────────────────────────────
function useParticles(canvasRef: React.RefObject<HTMLCanvasElement>) {
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Wait one frame so CSS layout sizes the canvas before we read offsetWidth/Height
    const init = () => {
      const W = canvas.offsetWidth  || window.innerWidth
      const H = canvas.offsetHeight || window.innerHeight
      if (!W || !H) return

      let renderer: THREE.WebGLRenderer
      try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true })
      } catch { return }

      renderer.setSize(W, H)
      renderer.setPixelRatio(1)

      const scene  = new THREE.Scene()
      const camera = new THREE.PerspectiveCamera(55, W / H, 0.1, 200)
      camera.position.set(0, 0, 8)

      const COUNT = 600
      const pos   = new Float32Array(COUNT * 3)
      const vel: number[] = []
      for (let i = 0; i < COUNT; i++) {
        pos[i * 3]     = (Math.random() - 0.5) * 28
        pos[i * 3 + 1] = (Math.random() - 0.5) * 18
        pos[i * 3 + 2] = (Math.random() - 0.5) * 6
        vel.push((Math.random() - 0.5) * 0.0008, (Math.random() - 0.5) * 0.0008, 0)
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
      scene.add(new THREE.Points(geo,
        new THREE.PointsMaterial({ color: 0xffffff, size: 0.030, transparent: true, opacity: 0.30, sizeAttenuation: true })
      ))

      const onResize = () => {
        const w = canvas.offsetWidth || window.innerWidth
        const h = canvas.offsetHeight || window.innerHeight
        if (!w || !h) return
        renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix()
      }
      window.addEventListener("resize", onResize)

      let id: number
      const tick = () => {
        id = requestAnimationFrame(tick)
        const p = geo.attributes.position.array as Float32Array
        for (let i = 0; i < COUNT; i++) {
          p[i * 3]     += vel[i * 3]
          p[i * 3 + 1] += vel[i * 3 + 1]
          if (Math.abs(p[i * 3])     > 14) vel[i * 3]     *= -1
          if (Math.abs(p[i * 3 + 1]) > 9)  vel[i * 3 + 1] *= -1
        }
        geo.attributes.position.needsUpdate = true
        renderer.render(scene, camera)
      }
      tick()

      // Store cleanup on the canvas element so it runs on unmount
      ;(canvas as HTMLCanvasElement & { _cleanup?: () => void })._cleanup = () => {
        cancelAnimationFrame(id)
        window.removeEventListener("resize", onResize)
        renderer.dispose()
      }
    }

    const raf = requestAnimationFrame(init)
    return () => {
      cancelAnimationFrame(raf)
      const c = canvas as HTMLCanvasElement & { _cleanup?: () => void }
      c._cleanup?.()
    }
  }, [canvasRef])
}

// ── Main component ──────────────────────────────────────────────────────────
export default function HomePage() {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const videoRef   = useRef<HTMLVideoElement>(null)
  const [navScrolled, setNavScrolled] = useState(false)
  const [scrollY, setScrollY]         = useState(0)

  useParticles(canvasRef)

  useEffect(() => {
    const v = videoRef.current
    if (v) { v.playbackRate = 0.7 }
  }, [])

  useEffect(() => {
    const onScroll = () => { setNavScrolled(window.scrollY > 60); setScrollY(window.scrollY) }
    window.addEventListener("scroll", onScroll)
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <div className="min-h-screen relative overflow-x-hidden" style={{ background: "#000" }}>

      {/* ── Navbar ── */}
      <header className={`fixed top-0 left-0 right-0 z-50 px-8 py-4 flex items-center justify-between transition-all duration-500 ${navScrolled ? "bg-black/70 backdrop-blur-xl border-b border-white/5" : "bg-transparent"}`}>
        <Link to="/" className="text-white font-bold text-sm tracking-[0.18em] uppercase">Saarthi</Link>
        <nav className="flex items-center gap-10">
          {[
            { to: "/wallet", label: "Wallet" },
            { to: "/cab",    label: "Cab"    },
            { to: "/police", label: "Police" },
          ].map(({ to, label }) => (
            <Link key={to} to={to}
              className="text-white/38 hover:text-white text-xs font-medium tracking-widest uppercase transition-colors duration-300">
              {label}
            </Link>
          ))}
        </nav>
      </header>

      {/* ══════════════════ HERO ══════════════════ */}
      <section className="relative h-screen w-full overflow-hidden"
        style={{ background: "#0a0a0e" }}>

        {/* ── BG video – full screen ── */}
        <video
          ref={videoRef}
          src="/chakra.mp4"
          autoPlay loop muted playsInline
          style={{
            position: "absolute", inset: 0,
            width: "100%", height: "100%",
            objectFit: "cover",
            zIndex: 5,
            filter: "grayscale(100%) brightness(55%) contrast(115%)",
          }} />

        {/* ── Cinematic gradient overlay ── */}
        <div className="absolute inset-0 pointer-events-none" style={{
          zIndex: 10,
          background: `
            linear-gradient(
              to bottom,
              rgba(0,0,0,0.65) 0%,
              rgba(0,0,0,0.25) 40%,
              rgba(0,0,0,0.25) 60%,
              rgba(0,0,0,0.80) 100%
            )
          `,
        }} />

        {/* ── Left-edge depth fade (frames the content) ── */}
        <div className="absolute inset-0 pointer-events-none" style={{
          zIndex: 11,
          background: "linear-gradient(to right, rgba(0,0,0,0.55) 0%, transparent 45%)",
        }} />

        {/* ── Subtle particles ── */}
        <canvas ref={canvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ zIndex: 15, opacity: 0.18 }} />

        {/* ── Very faint violet accent bottom-left ── */}
        <div className="absolute inset-0 pointer-events-none" style={{
          zIndex: 16,
          background: "radial-gradient(ellipse 35% 45% at 18% 65%, rgba(139,92,246,0.10) 0%, transparent 70%)",
        }} />

        {/* ── Content: slightly left-center ── */}
        <div className="absolute inset-0 flex items-center" style={{ zIndex: 50 }}>
          <div className="w-full max-w-6xl mx-auto px-10 md:px-16">
            <div
              className="max-w-[580px] select-none"
              style={{ transform: `translateY(${scrollY * 0.10}px)` }}>

              {/* Status tag */}
              <motion.div
                initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.8 }}
                className="inline-flex items-center gap-2 mb-7">
                <span className="w-1.5 h-1.5 rounded-full bg-[#8b5cf6] animate-pulse" />
                <span className="text-white/50 text-[10px] font-semibold tracking-[0.28em] uppercase">
                  Digital Safety Infrastructure
                </span>
              </motion.div>

              {/* Main heading – plain white, always visible */}
              <motion.h1
                initial={{ opacity: 0, y: 32 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.35, duration: 1.0, ease: [0.22, 1, 0.36, 1] }}
                className="font-black uppercase leading-none mb-5 text-white"
                style={{
                  fontSize: "clamp(3.8rem, 9.5vw, 8.5rem)",
                  letterSpacing: "0.28em",
                  textShadow: "0 0 60px rgba(139,92,246,0.45), 0 2px 40px rgba(0,0,0,0.8)",
                }}>
                Saarthi
              </motion.h1>

              {/* Subheading */}
              <motion.p
                initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.65, duration: 0.9 }}
                className="font-light uppercase mb-5"
                style={{ fontSize: "clamp(0.62rem, 1.15vw, 0.78rem)", letterSpacing: "0.22em", color: "rgba(255,255,255,0.42)" }}>
                Privacy-First Digital Safety Infrastructure
              </motion.p>

              {/* Thin divider */}
              <motion.div
                initial={{ scaleX: 0, opacity: 0 }} animate={{ scaleX: 1, opacity: 1 }}
                transition={{ delay: 0.9, duration: 0.7, ease: "easeOut" }}
                style={{ width: "52px", height: "1px", background: "rgba(255,255,255,0.25)", marginBottom: "2rem", transformOrigin: "left" }} />

              {/* CTA Buttons */}
              <motion.div
                initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.05, duration: 0.8 }}
                className="flex flex-row gap-3 items-center flex-wrap">

                <Link to="/cab"
                  className="px-7 py-3 rounded-full font-semibold text-xs tracking-widest uppercase text-white transition-all duration-300"
                  style={{ background: "linear-gradient(135deg, #7c3aed, #4f46e5)", boxShadow: "0 0 22px rgba(124,58,237,0.45)" }}
                  onMouseEnter={e => (e.currentTarget.style.boxShadow = "0 0 32px rgba(139,92,246,0.65)")}
                  onMouseLeave={e => (e.currentTarget.style.boxShadow = "0 0 22px rgba(124,58,237,0.45)")}>
                  Launch Cab
                </Link>

                <Link to="/wallet"
                  className="px-7 py-3 rounded-full font-semibold text-xs tracking-widest uppercase border border-white/20 hover:border-white/40 transition-all duration-300"
                  style={{ color: "rgba(255,255,255,0.55)", background: "rgba(255,255,255,0.04)" }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.9)"; (e.currentTarget as HTMLElement).style.boxShadow = "0 0 18px rgba(255,255,255,0.08)" }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = "rgba(255,255,255,0.55)"; (e.currentTarget as HTMLElement).style.boxShadow = "none" }}>
                  Open Identity Vault
                </Link>
              </motion.div>

              {/* Stats row */}
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.5, duration: 0.9 }}
                className="flex items-center gap-7 mt-10">
                {[
                  { value: "SHA-256", label: "Encryption"  },
                  { value: "0ms",     label: "Data Stored" },
                  { value: "E2E",     label: "Client-Side" },
                ].map((s, i) => (
                  <div key={i} className="flex flex-col gap-0.5">
                    <span className="text-xs font-bold tracking-widest" style={{ color: "rgba(255,255,255,0.62)" }}>{s.value}</span>
                    <span className="text-[9px] tracking-[0.2em] uppercase" style={{ color: "rgba(255,255,255,0.20)" }}>{s.label}</span>
                  </div>
                ))}
              </motion.div>
            </div>
          </div>
        </div>

        {/* Scroll indicator – bottom center */}
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 2.2, duration: 0.8 }}
          className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
          style={{ zIndex: 50 }}>
          <span className="text-white/18 text-[9px] font-medium tracking-[0.3em] uppercase">Scroll</span>
          <div className="w-px h-9 overflow-hidden relative">
            <motion.div
              animate={{ y: [-36, 36] }}
              transition={{ repeat: Infinity, duration: 1.9, ease: "linear" }}
              className="absolute inset-x-0 top-0 h-full"
              style={{ background: "linear-gradient(to bottom, transparent, rgba(255,255,255,0.35), transparent)" }} />
          </div>
        </motion.div>
      </section>

      {/* ══════════════════ BELOW FOLD ══════════════════ */}
      <div className="relative" style={{ background: "#030305" }}>

        {/* Section separator glow */}
        <div className="absolute top-0 left-0 right-0 h-px"
          style={{ background: "linear-gradient(90deg, transparent, rgba(139,92,246,0.3), transparent)" }} />

        {/* Problem */}
        <Section id="about" className="px-8 py-28 max-w-5xl mx-auto">
          <motion.div variants={fadeUp} className="flex items-center gap-2 mb-4">
            <div className="w-4 h-px bg-[#8b5cf6]" />
            <span className="text-[#8b5cf6] text-[10px] font-bold tracking-[0.3em] uppercase">The Problem</span>
          </motion.div>
          <motion.h2 variants={fadeUp} className="text-3xl md:text-4xl font-bold text-white mb-4 leading-snug">
            Privacy is broken<br />at the infrastructure level.
          </motion.h2>
          <motion.p variants={fadeUp} className="text-white/35 text-base mb-14 max-w-xl leading-relaxed">
            Traditional platforms store raw personal data in centralized servers. One breach exposes everyone.
          </motion.p>
          <div className="grid md:grid-cols-2 gap-3">
            {[
              { icon: Shield,        title: "Raw Identity Storage",        desc: "Platforms store unencrypted personal data in centralized servers." },
              { icon: AlertTriangle, title: "Centralized Data Leaks",      desc: "Central points of failure mean one hack compromises entire user bases." },
              { icon: MapPin,        title: "Ride-Sharing Safety Gaps",    desc: "Vulnerable users face risks with limited real-time route monitoring." },
              { icon: Radio,         title: "Emergency Connectivity Gaps", desc: "Internet outages during disasters cut off the very systems meant to save lives." },
            ].map(({ icon: Icon, title, desc }, i) => (
              <motion.div key={i} variants={fadeUp}
                className="rounded-2xl p-6 border border-white/6 hover:border-[#8b5cf6]/30 transition-all duration-300 group"
                style={{ background: "rgba(255,255,255,0.025)" }}
                onMouseEnter={e => (e.currentTarget.style.boxShadow = "0 0 24px rgba(139,92,246,0.1)")}
                onMouseLeave={e => (e.currentTarget.style.boxShadow = "none")}>
                <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-4"
                  style={{ background: "rgba(139,92,246,0.12)", border: "1px solid rgba(139,92,246,0.2)" }}>
                  <Icon className="w-4.5 h-4.5 text-[#8b5cf6]" />
                </div>
                <h3 className="text-white font-semibold text-sm mb-1.5">{title}</h3>
                <p className="text-white/35 text-sm leading-relaxed">{desc}</p>
              </motion.div>
            ))}
          </div>
        </Section>

        {/* Solution */}
        <Section id="architecture" className="px-8 py-28">
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-16">
              <motion.div variants={fadeUp} className="inline-flex items-center gap-2 mb-4">
                <div className="w-4 h-px bg-[#8b5cf6]" />
                <span className="text-[#8b5cf6] text-[10px] font-bold tracking-[0.3em] uppercase">Our Solution</span>
                <div className="w-4 h-px bg-[#8b5cf6]" />
              </motion.div>
              <motion.h2 variants={fadeUp} className="text-3xl md:text-4xl font-bold text-white mb-3">
                Three pillars of<br />privacy-first infrastructure.
              </motion.h2>
            </div>
            <div className="grid md:grid-cols-3 gap-4">
              {[
                { id: "identity", icon: Lock,  to: "/wallet", title: "Cryptographic Identity Vault", desc: "Store only hashes — never raw IDs. Prove identity without exposing data." },
                { id: "cab",      icon: Car,   to: "/cab",    title: "GPS-Based Smart Cab Monitoring", desc: "Real-time geo-fencing and deviation detection for ride safety." },
                { id: "police",   icon: Radio, to: "/police", title: "Multi-Layer Emergency Relay", desc: "Internet + mesh fallbacks so alerts get through when it matters most." },
              ].map(({ icon: Icon, to, title, desc }, i) => (
                <motion.div key={i} variants={fadeUp}>
                  <Link to={to} className="block rounded-2xl p-6 border border-white/6 hover:border-[#8b5cf6]/40 transition-all duration-300 group h-full"
                    style={{ background: "rgba(255,255,255,0.02)" }}
                    onMouseEnter={e => (e.currentTarget.style.boxShadow = "0 0 32px rgba(139,92,246,0.12)", e.currentTarget.style.transform = "translateY(-2px)")}
                    onMouseLeave={e => (e.currentTarget.style.boxShadow = "none", e.currentTarget.style.transform = "none")}>
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-5"
                      style={{ background: "rgba(139,92,246,0.15)", border: "1px solid rgba(139,92,246,0.25)" }}>
                      <Icon className="w-5 h-5 text-[#8b5cf6]" />
                    </div>
                    <h3 className="text-white font-semibold text-sm mb-2">{title}</h3>
                    <p className="text-white/35 text-sm leading-relaxed mb-4">{desc}</p>
                    <span className="text-[#8b5cf6]/60 text-[10px] font-bold tracking-widest uppercase group-hover:text-[#8b5cf6] transition-colors">
                      Explore →
                    </span>
                  </Link>
                </motion.div>
              ))}
            </div>
          </div>
        </Section>

        {/* Footer line */}
        <div className="px-8 py-10 border-t border-white/5 flex items-center justify-between max-w-5xl mx-auto">
          <span className="text-white/15 text-xs tracking-widest uppercase">Saarthi · Privacy-First Safety</span>
          <span className="text-white/15 text-xs tracking-widest uppercase">Built for Hack-A-League</span>
        </div>
      </div>
    </div>
  )
}
