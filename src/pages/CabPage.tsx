import { useState, useEffect, useRef } from "react"
import { Link } from "react-router-dom"
import { motion } from "framer-motion"
import { Car, Search, Crosshair, Loader2, AlertCircle } from "lucide-react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"

interface NominatimResult {
  lat: string
  lon: string
  display_name: string
}

export default function CabPage() {
  const [navScrolled, setNavScrolled] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [locating, setLocating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [locationLabel, setLocationLabel] = useState<string>("India")
  const [suggestions, setSuggestions] = useState<NominatimResult[]>([])

  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.CircleMarker | null>(null)
  const accuracyCircleRef = useRef<L.Circle | null>(null)

  useEffect(() => {
    const onScroll = () => setNavScrolled(window.scrollY > 60)
    window.addEventListener("scroll", onScroll)
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return

    const map = L.map(mapRef.current, { zoomControl: false }).setView([20.5937, 78.9629], 5)

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map)

    L.control.zoom({ position: "bottomright" }).addTo(map)

    // Initial India marker
    const marker = L.circleMarker([20.5937, 78.9629], {
      radius: 12,
      fillColor: "#7C3AED",
      color: "#fff",
      weight: 2.5,
      opacity: 1,
      fillOpacity: 0.9,
    }).addTo(map)
    marker.bindPopup("<b>India</b>").openPopup()

    mapInstanceRef.current = map
    markerRef.current = marker

    return () => {
      map.remove()
      mapInstanceRef.current = null
      markerRef.current = null
    }
  }, [])

  const moveMarker = (lat: number, lon: number, label: string, accuracyM?: number) => {
    const map = mapInstanceRef.current
    if (!map) return

    if (markerRef.current) markerRef.current.remove()
    if (accuracyCircleRef.current) accuracyCircleRef.current.remove()

    const marker = L.circleMarker([lat, lon], {
      radius: 12,
      fillColor: "#7C3AED",
      color: "#fff",
      weight: 2.5,
      opacity: 1,
      fillOpacity: 0.9,
    }).addTo(map)
    marker.bindPopup(`<b>${label}</b>`).openPopup()
    markerRef.current = marker

    if (accuracyM) {
      const circle = L.circle([lat, lon], {
        radius: accuracyM,
        color: "#7C3AED",
        fillColor: "#7C3AED",
        fillOpacity: 0.1,
        weight: 1,
      }).addTo(map)
      accuracyCircleRef.current = circle
    }

    map.flyTo([lat, lon], accuracyM && accuracyM < 1000 ? 15 : 13, { duration: 1.5 })
    setLocationLabel(label)
  }

  const handleLocate = () => {
    if (!navigator.geolocation) {
      setError("Geolocation is not supported by your browser.")
      return
    }
    setLocating(true)
    setError(null)

    const onSuccess = (pos: GeolocationPosition) => {
      const { latitude, longitude, accuracy } = pos.coords
      moveMarker(latitude, longitude, "Your Current Location", accuracy)
      setLocating(false)
    }

    const onError = (err: GeolocationPositionError) => {
      // First attempt (high accuracy) failed — retry without it
      if (err.code !== err.PERMISSION_DENIED) {
        navigator.geolocation.getCurrentPosition(
          onSuccess,
          (err2) => {
            setLocating(false)
            const msgs: Record<number, string> = {
              1: "Location permission denied. Click the lock icon in your browser's address bar and allow location.",
              2: "Location unavailable. Make sure location services are enabled in your OS settings.",
              3: "Location request timed out. Check your network or OS location settings.",
            }
            setError(msgs[err2.code] ?? "Unable to get location. Please try again.")
          },
          { enableHighAccuracy: false, timeout: 15000, maximumAge: 30000 }
        )
      } else {
        setLocating(false)
        setError("Location permission denied. Click the lock icon in your browser's address bar and allow location.")
      }
    }

    // First try: high accuracy (GPS)
    navigator.geolocation.getCurrentPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      timeout: 8000,
      maximumAge: 0,
    })
  }

  const handleSearch = async (query: string) => {
    if (!query.trim()) return
    setSearching(true)
    setError(null)
    setSuggestions([])
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query + ", India")}&format=json&limit=5&addressdetails=1`,
        { headers: { "Accept-Language": "en" } }
      )
      const data: NominatimResult[] = await res.json()
      if (data.length === 0) {
        setError(`No results found for "${query}" in India.`)
      } else {
        setSuggestions(data)
      }
    } catch {
      setError("Search failed. Check your internet connection.")
    } finally {
      setSearching(false)
    }
  }

  const selectSuggestion = (r: NominatimResult) => {
    setSuggestions([])
    setSearchQuery(r.display_name.split(",")[0])
    moveMarker(parseFloat(r.lat), parseFloat(r.lon), r.display_name.split(",").slice(0, 2).join(", "))
  }

  return (
    <div className="h-screen flex flex-col relative overflow-hidden bg-[#0B0B0F]">
      {/* Navbar */}
      <header
        className={`flex-shrink-0 z-[1100] px-6 py-4 flex items-center justify-between transition-all duration-300 ${
          navScrolled ? "bg-[#0B0B0F]/70 backdrop-blur-xl border-b border-white/5" : "bg-[#0B0B0F]/80 backdrop-blur-md"
        }`}
      >
        <Link to="/" className="text-white font-bold text-lg tracking-tight">Sahayak</Link>
        <nav className="flex items-center gap-8">
          <Link to="/wallet" className="text-[#A1A1AA] hover:text-white text-sm font-medium transition-colors duration-300">Wallet</Link>
          <span className="text-white text-sm font-medium">Cab</span>
          <Link to="/" className="text-[#A1A1AA] hover:text-white text-sm font-medium transition-colors duration-300">Home</Link>
        </nav>
      </header>

      {/* Map panel - fills rest of screen */}
      <div className="flex-1 relative">
        {/* Leaflet map */}
        <div ref={mapRef} className="absolute inset-0 z-0" />

        {/* Controls overlay */}
        <div className="absolute top-4 left-4 right-4 z-[1000] flex gap-3 flex-col sm:flex-row">
          {/* Search */}
          <div className="relative flex-1">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#A1A1AA]" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value)
                    setSuggestions([])
                  }}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch(searchQuery)}
                  placeholder="Search city, street or place in India…"
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-[#18181B]/90 backdrop-blur-md border border-white/10 text-white text-sm placeholder:text-[#A1A1AA]/60 focus:outline-none focus:border-[#7C3AED] shadow-xl"
                />
              </div>
              <button
                onClick={() => handleSearch(searchQuery)}
                disabled={searching}
                className="px-4 py-3 rounded-xl bg-gradient-to-r from-[#7C3AED] to-[#2563EB] text-white text-sm font-semibold hover:shadow-[0_0_16px_rgba(124,58,237,0.4)] transition-all disabled:opacity-60 shadow-xl"
              >
                {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : "Go"}
              </button>
            </div>

            {/* Suggestions dropdown */}
            {suggestions.length > 0 && (
              <motion.ul
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="absolute top-full mt-1 left-0 right-14 bg-[#18181B]/95 backdrop-blur-md border border-white/10 rounded-xl overflow-hidden shadow-2xl z-10"
              >
                {suggestions.map((r, i) => (
                  <li key={i}>
                    <button
                      onClick={() => selectSuggestion(r)}
                      className="w-full text-left px-4 py-3 text-sm text-[#A1A1AA] hover:bg-white/5 hover:text-white border-b border-white/5 last:border-0 transition-colors"
                    >
                      {r.display_name}
                    </button>
                  </li>
                ))}
              </motion.ul>
            )}
          </div>

          {/* Locate me */}
          <button
            onClick={handleLocate}
            disabled={locating}
            className="flex items-center gap-2 px-4 py-3 rounded-xl bg-[#18181B]/90 backdrop-blur-md border border-white/10 text-white text-sm font-medium hover:bg-white/10 transition-all shadow-xl disabled:opacity-60 whitespace-nowrap"
          >
            {locating
              ? <Loader2 className="w-4 h-4 animate-spin text-[#7C3AED]" />
              : <Crosshair className="w-4 h-4 text-[#7C3AED]" />}
            {locating ? "Getting location…" : "My Location"}
          </button>
        </div>

        {/* Error toast */}
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="absolute bottom-6 left-4 right-4 z-[1000] flex items-center gap-3 p-4 rounded-xl bg-red-500/20 backdrop-blur-md border border-red-500/30 text-red-400 shadow-xl"
          >
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <p className="text-sm">{error}</p>
            <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-white text-xs">✕</button>
          </motion.div>
        )}

        {/* Location label badge */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-[1000] px-4 py-2 rounded-full bg-[#18181B]/90 backdrop-blur-md border border-white/10 text-white text-xs font-medium shadow-xl whitespace-nowrap">
          <Car className="inline w-3.5 h-3.5 mr-1.5 text-[#7C3AED]" />
          {locationLabel}
        </div>
      </div>
    </div>
  )
}
