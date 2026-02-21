import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { Link } from "react-router-dom"
import { motion, AnimatePresence } from "framer-motion"
import {
  Search, Crosshair, Loader2, AlertTriangle,
  Play, Square, Radio, Cpu, Zap, MapPin,
} from "lucide-react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import * as turf from "@turf/turf"
import type { Feature, Polygon, GeoJsonObject } from "geojson"
import { getSocket, releaseSocket } from "../lib/socket"
import { generateKeyPair, signPayload, exportPublicKey } from "../lib/crypto"

// ── Types ──────────────────────────────────────────────────────────────────

interface Coord { lat: number; lng: number }

type TripStatus = "ACTIVE" | "ALERT" | "COMPLETED"

interface Trip {
  tripId: string
  status: TripStatus
  startedAt: number
  startLocation: Coord
  path: Coord[]
}

interface NominatimResult {
  lat: string
  lon: string
  display_name: string
}

// ── Constants ──────────────────────────────────────────────────────────────

const SIM_STEP = 0.0003
const SIM_ARRIVE_THRESHOLD = 0.0002
const CORRIDOR_RADIUS_KM = 0.3
const DEVIATION_JUMP = 1.5

// ── Pure helpers ───────────────────────────────────────────────────────────

const makeTripId = () => "TRIP" + Date.now()

const saveTrip = (t: Trip) => localStorage.setItem("sahayak_trip", JSON.stringify(t))
const loadTrip = (): Trip | null => {
  try { const r = localStorage.getItem("sahayak_trip"); return r ? JSON.parse(r) : null } catch { return null }
}

const geoErrorMsg = (code: number) => ({
  1: "Permission denied — click the lock icon in the address bar and allow Location.",
  2: "Location unavailable — enable Location Services in your OS settings.",
  3: "Location timed out — check your network or OS location settings.",
}[code] ?? "Could not get location.")

function buildCorridor(start: Coord | null, dest: Coord | null): Feature<Polygon> | null {
  if (!start || !dest) return null
  const line = turf.lineString([[start.lng, start.lat], [dest.lng, dest.lat]])
  return turf.buffer(line, CORRIDOR_RADIUS_KM, { units: "kilometers" }) as Feature<Polygon>
}

function isInsideCorridor(polygon: Feature<Polygon>, lat: number, lng: number): boolean {
  return turf.booleanPointInPolygon(turf.point([lng, lat]), polygon)
}

// ── Component ──────────────────────────────────────────────────────────────

export default function CabPage() {
  const [navScrolled, setNavScrolled] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [suggestions, setSuggestions] = useState<NominatimResult[]>([])
  const [locating, setLocating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [trip, setTrip] = useState<Trip | null>(() => loadTrip())
  const [startingRide, setStartingRide] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [simMode, setSimMode] = useState(false)
  const [simActive, setSimActive] = useState(false)
  const [destination, setDestination] = useState<Coord | null>(null)
  const [awaitingDest, setAwaitingDest] = useState(false)
  const [deviationAlert, setDeviationAlert] = useState(false)

  // Map layer refs
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.CircleMarker | null>(null)
  const destMarkerRef = useRef<L.CircleMarker | null>(null)
  const accuracyCircleRef = useRef<L.Circle | null>(null)
  const polylineRef = useRef<L.Polyline | null>(null)
  const routeLineRef = useRef<L.Polyline | null>(null)
  const bufferLayerRef = useRef<L.GeoJSON | null>(null)

  // Logic refs
  const watchIdRef = useRef<number | null>(null)
  const simIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const simPosRef = useRef<Coord>({ lat: 20.5937, lng: 78.9629 })
  const tripRef = useRef<Trip | null>(trip)
  const destinationRef = useRef<Coord | null>(destination)
  const corridorRef = useRef<Feature<Polygon> | null>(null)
  const awaitingDestRef = useRef(false)
  const alertEmittedRef = useRef(false)
  const keyPairRef = useRef<CryptoKeyPair | null>(null)

  useEffect(() => { tripRef.current = trip }, [trip])
  useEffect(() => { destinationRef.current = destination }, [destination])
  useEffect(() => { awaitingDestRef.current = awaitingDest }, [awaitingDest])

  // ── Corridor (useMemo) ────────────────────────────────────────────────────

  const corridor = useMemo(
    () => buildCorridor(trip?.startLocation ?? null, destination),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trip?.startLocation?.lat, trip?.startLocation?.lng, destination?.lat, destination?.lng]
  )

  useEffect(() => {
    corridorRef.current = corridor
    const map = mapInstanceRef.current
    if (!map) return

    if (bufferLayerRef.current) { bufferLayerRef.current.remove(); bufferLayerRef.current = null }
    if (!corridor) return

    bufferLayerRef.current = L.geoJSON(corridor as GeoJsonObject, {
      style: { color: "#7C3AED", fillColor: "#7C3AED", fillOpacity: 0.12, weight: 1, opacity: 0.3 },
    }).addTo(map)

    if (routeLineRef.current) { routeLineRef.current.remove(); routeLineRef.current = null }
    if (trip?.startLocation && destination) {
      const startPt = [trip.startLocation.lat, trip.startLocation.lng] as L.LatLngTuple
      const destPt  = [destination.lat, destination.lng] as L.LatLngTuple
      console.log("[CabPage] Route line — start:", startPt, "dest:", destPt)
      routeLineRef.current = L.polyline([startPt, destPt],
        { color: "#a78bfa", weight: 2, dashArray: "6 6", opacity: 0.7 }
      ).addTo(map)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corridor])

  // ── Nav scroll ────────────────────────────────────────────────────────────

  useEffect(() => {
    const fn = () => setNavScrolled(window.scrollY > 60)
    window.addEventListener("scroll", fn)
    return () => window.removeEventListener("scroll", fn)
  }, [])

  // ── Init map ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return

    const map = L.map(mapRef.current, { zoomControl: false }).setView([20.5937, 78.9629], 5)
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map)
    L.control.zoom({ position: "bottomright" }).addTo(map)

    const marker = L.circleMarker([20.5937, 78.9629], {
      radius: 10, fillColor: "#7C3AED", color: "#fff", weight: 2.5, fillOpacity: 0.9,
    }).addTo(map)
    marker.bindPopup("<b>India</b>")
    mapInstanceRef.current = map
    markerRef.current = marker

    const saved = loadTrip()
    if (saved?.path && saved.path.length > 1) {
      const lls = saved.path.map(c => [c.lat, c.lng] as L.LatLngTuple)
      const pl = L.polyline(lls, { color: "#7C3AED", weight: 4, opacity: 0.9 }).addTo(map)
      polylineRef.current = pl
      map.fitBounds(pl.getBounds(), { padding: [40, 40] })
      const last = saved.path[saved.path.length - 1]
      placeMarker(last.lat, last.lng, saved.status === "ACTIVE" ? "In Progress" : "Trip Ended")
      simPosRef.current = last
    }

    const rafId = requestAnimationFrame(() => { map.invalidateSize() })

    return () => {
      cancelAnimationFrame(rafId)
      map.remove()
      mapInstanceRef.current = null
      markerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onResize = () => mapInstanceRef.current?.invalidateSize()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  // ── Destination click handler ─────────────────────────────────────────────

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return

    const onClick = (e: L.LeafletMouseEvent) => {
      if (!awaitingDestRef.current) return
      const { lat, lng } = e.latlng
      console.log("[CabPage] Map clicked — Leaflet latlng:", { lat, lng })

      if (destMarkerRef.current) { destMarkerRef.current.remove(); destMarkerRef.current = null }

      const dm = L.circleMarker([lat, lng], {
        radius: 10, fillColor: "#10b981", color: "#fff", weight: 2.5, fillOpacity: 0.9,
      }).addTo(map)
      dm.bindPopup("<b>Destination</b>").openPopup()
      destMarkerRef.current = dm
      console.log("[CabPage] Destination marker placed at:", { lat, lng })
      setDestination({ lat, lng })
      setAwaitingDest(false)
    }

    map.on("click", onClick)
    return () => { map.off("click", onClick) }
  }, [])

  useEffect(() => {
    const id = setTimeout(() => mapInstanceRef.current?.invalidateSize(), 120)
    return () => clearTimeout(id)
  }, [deviationAlert])

  useEffect(() => {
    const container = mapInstanceRef.current?.getContainer()
    if (!container) return
    container.style.cursor = awaitingDest ? "crosshair" : ""
  }, [awaitingDest])

  useEffect(() => {
    if (trip?.status === "ACTIVE" && watchIdRef.current === null && !simMode) startWatch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!trip || (trip.status !== "ACTIVE" && trip.status !== "ALERT")) { setElapsed(0); return }
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - trip.startedAt) / 1000)), 1000)
    return () => clearInterval(id)
  }, [trip])

  // ── Map helpers ───────────────────────────────────────────────────────────

  const placeMarker = useCallback((lat: number, lng: number, label: string, color = "#7C3AED") => {
    const map = mapInstanceRef.current
    if (!map) return

    if (accuracyCircleRef.current) { accuracyCircleRef.current.remove(); accuracyCircleRef.current = null }

    console.log(`[CabPage] placeMarker — label="${label}" lat=${lat} lng=${lng} color=${color}`)

    if (markerRef.current) {
      markerRef.current.setLatLng([lat, lng])
      markerRef.current.setStyle({ fillColor: color })
      markerRef.current.bindPopup(`<b>${label}</b>`)
    } else {
      const m = L.circleMarker([lat, lng], {
        radius: 12, fillColor: color, color: "#fff", weight: 2.5, fillOpacity: 0.9,
      }).addTo(map)
      m.bindPopup(`<b>${label}</b>`)
      markerRef.current = m
    }
  }, [])

  const appendToPolyline = useCallback((lat: number, lng: number, color = "#7C3AED") => {
    const map = mapInstanceRef.current
    if (!map) return
    if (!polylineRef.current) {
      polylineRef.current = L.polyline([[lat, lng]], { color, weight: 4, opacity: 0.9 }).addTo(map)
    } else {
      polylineRef.current.addLatLng([lat, lng])
      polylineRef.current.setStyle({ color })
    }
  }, [])

  // ── Core push: position update + deviation check ──────────────────────────

  const pushCoord = useCallback((lat: number, lng: number, polyColor = "#7C3AED") => {
    const corridor = corridorRef.current
    const current = tripRef.current
    let markerColor = polyColor
    let lineColor = polyColor

    if (corridor && current && current.status === "ACTIVE") {
      const inside = isInsideCorridor(corridor, lat, lng)
      if (!inside) {
        markerColor = "#ef4444"
        lineColor = "#ef4444"
        const alertTrip: Trip = { ...current, status: "ALERT" }
        tripRef.current = alertTrip
        setTrip(alertTrip)
        saveTrip(alertTrip)
        setDeviationAlert(true)

        if (!alertEmittedRef.current) {
          alertEmittedRef.current = true
          const emergencyPayload = {
            tripId: current.tripId,
            location: { lat, lng },
            timestamp: Date.now(),
            severity: "HIGH" as const,
          }
          ;(async () => {
            const kp = keyPairRef.current
            if (kp) {
              const [signature, publicKey] = await Promise.all([
                signPayload(kp.privateKey, emergencyPayload),
                exportPublicKey(kp.publicKey),
              ])
              getSocket().emit("EMERGENCY_EVENT", { payload: emergencyPayload, signature, publicKey })
            } else {
              getSocket().emit("EMERGENCY_EVENT", { payload: emergencyPayload, signature: "", publicKey: "" })
            }
          })()
        }
      }
    }

    placeMarker(lat, lng, "You", markerColor)
    appendToPolyline(lat, lng, lineColor)
    mapInstanceRef.current?.panTo([lat, lng], { animate: true, duration: 0.8, easeLinearity: 0.5 })

    if (current && (current.status === "ACTIVE" || current.status === "ALERT")) {
      const updated: Trip = { ...current, path: [...current.path, { lat, lng }] }
      tripRef.current = updated
      setTrip(updated)
      saveTrip(updated)
    }

    simPosRef.current = { lat, lng }
  }, [placeMarker, appendToPolyline])

  // ── GPS helpers ───────────────────────────────────────────────────────────

  const getPosition = useCallback((): Promise<GeolocationPosition> => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error("not supported")); return }
      navigator.geolocation.getCurrentPosition(resolve, (e) => {
        if (e.code !== e.PERMISSION_DENIED) {
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: false, timeout: 15000, maximumAge: 30000,
          })
        } else reject(e)
      }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 })
    })
  }, [])

  const handleLocate = async () => {
    setLocating(true); setError(null)

    if (simIntervalRef.current !== null && !tripRef.current) {
      clearInterval(simIntervalRef.current)
      simIntervalRef.current = null
      setSimActive(false)
    }

    try {
      const pos = await getPosition()
      const { latitude: lat, longitude: lng, accuracy } = pos.coords

      placeMarker(lat, lng, "Your Location")
      simPosRef.current = { lat, lng }
      mapInstanceRef.current?.flyTo([lat, lng], 16, { animate: true, duration: 1.5 })

      if (accuracy && mapInstanceRef.current) {
        if (accuracyCircleRef.current) {
          accuracyCircleRef.current.setLatLng([lat, lng])
          accuracyCircleRef.current.setRadius(accuracy)
        } else {
          accuracyCircleRef.current = L.circle([lat, lng], {
            radius: accuracy, color: "#7C3AED", fillColor: "#7C3AED", fillOpacity: 0.07, weight: 1,
          }).addTo(mapInstanceRef.current)
        }
      }
    } catch (e: unknown) {
      const code = (e as GeolocationPositionError).code ?? 0
      setError(code ? geoErrorMsg(code) : "Location unavailable.")
    } finally { setLocating(false) }
  }

  // ── GPS watch ─────────────────────────────────────────────────────────────

  const startWatch = useCallback(() => {
    if (watchIdRef.current !== null) return
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => pushCoord(pos.coords.latitude, pos.coords.longitude),
      (err) => setError(geoErrorMsg(err.code)),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    )
  }, [pushCoord])

  const stopWatch = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
  }, [])

  // ── Simulation engine ─────────────────────────────────────────────────────

  const startSimulation = useCallback(() => {
    if (simIntervalRef.current !== null) return
    setSimActive(true)

    simIntervalRef.current = setInterval(() => {
      const cur = simPosRef.current
      const dest = destinationRef.current

      if (dest) {
        const deltaLat = dest.lat - cur.lat
        const deltaLng = dest.lng - cur.lng
        const distance = Math.sqrt(deltaLat * deltaLat + deltaLng * deltaLng)

        if (distance < SIM_ARRIVE_THRESHOLD) {
          pushCoord(dest.lat, dest.lng, "#2563EB")
          if (simIntervalRef.current !== null) {
            clearInterval(simIntervalRef.current)
            simIntervalRef.current = null
          }
          setSimActive(false)
          return
        }

        const jitter = () => (Math.random() * 0.00004 - 0.00002)
        pushCoord(
          cur.lat + (deltaLat / distance) * SIM_STEP + jitter(),
          cur.lng + (deltaLng / distance) * SIM_STEP + jitter(),
          "#2563EB"
        )
      } else {
        pushCoord(cur.lat, cur.lng, "#2563EB")
      }
    }, 1500)
  }, [pushCoord])

  const stopSimulation = useCallback(() => {
    if (simIntervalRef.current !== null) {
      clearInterval(simIntervalRef.current)
      simIntervalRef.current = null
    }
    setSimActive(false)
  }, [])

  const handleToggleSim = useCallback(() => {
    const next = !simMode
    setSimMode(next)
    if (trip?.status !== "ACTIVE" && trip?.status !== "ALERT") return
    if (next) { stopWatch(); startSimulation() }
    else { stopSimulation(); startWatch() }
  }, [simMode, trip, stopWatch, startSimulation, stopSimulation, startWatch])

  const handleTriggerDeviation = useCallback(() => {
    const cur = simPosRef.current
    const devLat = cur.lat + DEVIATION_JUMP + Math.random() * 0.3
    const devLng = cur.lng - DEVIATION_JUMP - Math.random() * 0.3
    pushCoord(devLat, devLng, "#ef4444")
    mapInstanceRef.current?.flyTo([devLat, devLng], 12, { duration: 1.5 })
  }, [pushCoord])

  // ── Start Ride ────────────────────────────────────────────────────────────

  const handleStartRide = async () => {
    setStartingRide(true); setError(null)
    if (polylineRef.current) { polylineRef.current.remove(); polylineRef.current = null }
    if (routeLineRef.current) { routeLineRef.current.remove(); routeLineRef.current = null }
    if (bufferLayerRef.current) { bufferLayerRef.current.remove(); bufferLayerRef.current = null }
    if (destMarkerRef.current) { destMarkerRef.current.remove(); destMarkerRef.current = null }
    setDestination(null)
    setDeviationAlert(false)
    alertEmittedRef.current = false
    keyPairRef.current = null

    generateKeyPair().then((kp) => { keyPairRef.current = kp })

    try {
      let lat: number, lng: number
      if (simMode) {
        lat = simPosRef.current.lat; lng = simPosRef.current.lng
      } else {
        const pos = await getPosition()
        lat = pos.coords.latitude; lng = pos.coords.longitude
      }

      const newTrip: Trip = {
        tripId: makeTripId(), status: "ACTIVE",
        startedAt: Date.now(), startLocation: { lat, lng }, path: [{ lat, lng }],
      }
      setTrip(newTrip); saveTrip(newTrip); tripRef.current = newTrip
      simPosRef.current = { lat, lng }

      placeMarker(lat, lng, simMode ? "Sim Start" : "Trip Started")
      mapInstanceRef.current?.flyTo([lat, lng], 15, { animate: true, duration: 1.3 })
      appendToPolyline(lat, lng, simMode ? "#2563EB" : "#7C3AED")

      setAwaitingDest(true)

      if (simMode) startSimulation(); else startWatch()
    } catch (e: unknown) {
      const code = (e as GeolocationPositionError).code ?? 0
      setError(code ? geoErrorMsg(code) : "Could not start ride.")
    } finally { setStartingRide(false) }
  }

  // ── End Ride ──────────────────────────────────────────────────────────────

  const handleEndRide = useCallback(() => {
    stopWatch(); stopSimulation()
    setAwaitingDest(false)
    const current = tripRef.current
    if (!current) return
    const completed: Trip = { ...current, status: "COMPLETED" }
    setTrip(completed); saveTrip(completed); tripRef.current = completed
    setDeviationAlert(false)
    markerRef.current?.bindPopup("<b>Trip Ended</b>").openPopup()
    if (polylineRef.current && mapInstanceRef.current) {
      try { mapInstanceRef.current.fitBounds(polylineRef.current.getBounds(), { padding: [60, 60] }) } catch { /* short */ }
    }
  }, [stopWatch, stopSimulation])

  useEffect(() => {
    getSocket()
    return () => { stopWatch(); stopSimulation(); releaseSocket() }
  }, [stopWatch, stopSimulation])

  // ── Search ────────────────────────────────────────────────────────────────

  const handleSearch = async (q: string) => {
    if (!q.trim()) return
    setSearching(true); setError(null); setSuggestions([])
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ", India")}&format=json&limit=5`,
        { headers: { "Accept-Language": "en" } }
      )
      const data: NominatimResult[] = await res.json()
      if (!data.length) setError(`No results for "${q}"`)
      else setSuggestions(data)
    } catch { setError("Search failed.") }
    finally { setSearching(false) }
  }

  const selectSuggestion = (r: NominatimResult) => {
    setSuggestions([])
    setSearchQuery(r.display_name.split(",")[0])
    const lat = parseFloat(r.lat), lng = parseFloat(r.lon)
    const label = r.display_name.split(",").slice(0, 2).join(", ")
    placeMarker(lat, lng, label)
    simPosRef.current = { lat, lng }
    mapInstanceRef.current?.flyTo([lat, lng], 14, { animate: true, duration: 1.2 })
  }

  // ── Derived state ─────────────────────────────────────────────────────────

  const isActive = trip?.status === "ACTIVE"
  const isAlert = trip?.status === "ALERT"
  const isRunning = isActive || isAlert
  const isCompleted = trip?.status === "COMPLETED"

  const formatElapsed = (s: number) => {
    const m = Math.floor(s / 60), sec = s % 60
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-screen flex flex-col relative overflow-hidden bg-[#0B0B0F]">

      {/* Navbar */}
      <header className={`flex-shrink-0 z-[1100] px-6 py-4 flex items-center justify-between transition-all duration-300 ${navScrolled ? "bg-[#0B0B0F]/70 backdrop-blur-xl border-b border-white/5" : "bg-[#0B0B0F]/80 backdrop-blur-md"}`}>
        <Link to="/" className="text-white font-bold text-lg tracking-tight">Sahayak</Link>
        <nav className="flex items-center gap-8">
          <Link to="/wallet" className="text-[#A1A1AA] hover:text-white text-sm font-medium transition-colors">Wallet</Link>
          <span className="text-white text-sm font-medium">Cab</span>
          <Link to="/police" className="text-[#A1A1AA] hover:text-white text-sm font-medium transition-colors">Police</Link>
          <Link to="/" className="text-[#A1A1AA] hover:text-white text-sm font-medium transition-colors">Home</Link>
        </nav>
      </header>

      <div className="flex-1 relative">
        <div ref={mapRef} className="absolute inset-0 z-0" />

        {/* Deviation alert banner */}
        <AnimatePresence>
          {deviationAlert && (
            <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
              className="absolute top-0 left-0 right-0 z-[1050]">
              <motion.div animate={{ opacity: [0.9, 1, 0.9] }} transition={{ repeat: Infinity, duration: 1.2 }}
                className="flex items-center justify-center gap-3 px-6 py-3 text-sm font-bold text-white"
                style={{ background: "linear-gradient(90deg,#991b1b,#dc2626,#991b1b)", boxShadow: "0 4px 24px rgba(220,38,38,0.6)" }}>
                <motion.div animate={{ scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 0.8 }}>
                  <AlertTriangle className="w-5 h-5" />
                </motion.div>
                ⚠ Route Deviation Detected — You are outside the safe corridor
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Search bar */}
        <div className={`absolute left-4 right-4 z-[1000] flex gap-2 flex-col sm:flex-row transition-all duration-300 ${deviationAlert ? "top-14" : "top-4"}`}>
          <div className="relative flex-1">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#A1A1AA]" />
                <input type="text" value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setSuggestions([]) }}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch(searchQuery)}
                  placeholder="Search city, street or place in India…"
                  className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[#18181B]/90 backdrop-blur-md border border-white/10 text-white text-sm placeholder:text-[#A1A1AA]/60 focus:outline-none focus:border-[#7C3AED] shadow-xl" />
              </div>
              <button onClick={() => handleSearch(searchQuery)} disabled={searching}
                className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-[#7C3AED] to-[#2563EB] text-white text-sm font-semibold hover:shadow-[0_0_16px_rgba(124,58,237,0.4)] transition-all disabled:opacity-60 shadow-xl">
                {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : "Go"}
              </button>
            </div>
            <AnimatePresence>
              {suggestions.length > 0 && (
                <motion.ul initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className="absolute top-full mt-1 left-0 right-14 bg-[#18181B]/95 backdrop-blur-md border border-white/10 rounded-xl overflow-hidden shadow-2xl z-10">
                  {suggestions.map((r, i) => (
                    <li key={i}>
                      <button onClick={() => selectSuggestion(r)}
                        className="w-full text-left px-4 py-2.5 text-sm text-[#A1A1AA] hover:bg-white/5 hover:text-white border-b border-white/5 last:border-0">
                        {r.display_name}
                      </button>
                    </li>
                  ))}
                </motion.ul>
              )}
            </AnimatePresence>
          </div>

          <button onClick={handleLocate} disabled={locating || isRunning}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#18181B]/90 backdrop-blur-md border border-white/10 text-white text-sm font-medium hover:bg-white/10 transition-all shadow-xl disabled:opacity-50 whitespace-nowrap">
            {locating ? <Loader2 className="w-4 h-4 animate-spin text-[#7C3AED]" /> : <Crosshair className="w-4 h-4 text-[#7C3AED]" />}
            {locating ? "Locating…" : "My Location"}
          </button>
        </div>

        {/* Destination hint */}
        <AnimatePresence>
          {awaitingDest && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}
              className="absolute bottom-36 left-1/2 -translate-x-1/2 z-[1000] flex items-center gap-2 px-5 py-3 rounded-xl bg-[#18181B]/95 backdrop-blur-md border border-[#7C3AED]/50 text-white text-sm font-medium shadow-xl whitespace-nowrap">
              <MapPin className="w-4 h-4 text-[#7C3AED]" />
              Click anywhere on the map to set your destination
              <button onClick={() => setAwaitingDest(false)} className="ml-2 text-[#A1A1AA] hover:text-white text-xs">✕</button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Status badges */}
        <div className={`absolute left-1/2 -translate-x-1/2 z-[1000] flex items-center gap-2 flex-wrap justify-center transition-all ${deviationAlert ? "top-24" : "top-20"}`}>
          <AnimatePresence mode="wait">
            {isAlert ? (
              <motion.div key="alert" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                className="relative flex items-center gap-2 px-4 py-2 rounded-full bg-[#18181B]/90 backdrop-blur-md border border-red-500/60 text-red-400 text-xs font-semibold shadow-xl whitespace-nowrap">
                <motion.div animate={{ opacity: [0.4, 0.9, 0.4], scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 1.2 }}
                  className="absolute inset-0 rounded-full border border-red-500/40 pointer-events-none" style={{ boxShadow: "0 0 16px rgba(239,68,68,0.4)" }} />
                <motion.div animate={{ opacity: [0.5, 1, 0.5] }} transition={{ repeat: Infinity, duration: 0.8 }}
                  className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                ALERT – Deviation · {formatElapsed(elapsed)}
              </motion.div>
            ) : isActive ? (
              <motion.div key="active" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                className="relative flex items-center gap-2 px-4 py-2 rounded-full bg-[#18181B]/90 backdrop-blur-md border border-[#7C3AED]/60 text-white text-xs font-semibold shadow-xl whitespace-nowrap">
                <motion.div animate={{ opacity: [0.4, 0.9, 0.4], scale: [1, 1.18, 1] }} transition={{ repeat: Infinity, duration: 2 }}
                  className="absolute inset-0 rounded-full border border-[#7C3AED]/50 pointer-events-none" />
                <motion.div animate={{ opacity: [0.3, 1, 0.3] }} transition={{ repeat: Infinity, duration: 1.4 }}
                  className="w-2 h-2 rounded-full bg-[#7C3AED] flex-shrink-0" />
                <Radio className="w-3.5 h-3.5 text-[#7C3AED] flex-shrink-0" />
                Trip Active – Monitoring · {formatElapsed(elapsed)}
              </motion.div>
            ) : isCompleted ? (
              <motion.div key="done" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-[#18181B]/90 backdrop-blur-md border border-green-500/40 text-green-400 text-xs font-semibold shadow-xl whitespace-nowrap">
                <div className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
                Trip Completed — {trip?.path.length ?? 0} pts
              </motion.div>
            ) : (
              <motion.div key="none" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-[#18181B]/90 backdrop-blur-md border border-white/10 text-[#A1A1AA] text-xs font-medium shadow-xl whitespace-nowrap">
                <div className="w-2 h-2 rounded-full bg-[#A1A1AA] flex-shrink-0" />
                No Active Trip
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {simActive && (
              <motion.div initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                className="relative flex items-center gap-2 px-4 py-2 rounded-full bg-[#18181B]/90 backdrop-blur-md border border-[#2563EB]/60 text-[#60a5fa] text-xs font-semibold shadow-xl whitespace-nowrap">
                <motion.div animate={{ opacity: [0.3, 0.7, 0.3], scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 1.8 }}
                  className="absolute inset-0 rounded-full border border-[#2563EB]/40 pointer-events-none" style={{ boxShadow: "0 0 16px rgba(37,99,235,0.35)" }} />
                <motion.div animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 1 }}
                  className="w-2 h-2 rounded-full bg-[#2563EB] flex-shrink-0" />
                <Cpu className="w-3.5 h-3.5 flex-shrink-0" />
                Simulation Active
              </motion.div>
            )}
            {destination && isRunning && (
              <motion.div initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-[#18181B]/90 backdrop-blur-md border border-emerald-500/40 text-emerald-400 text-xs font-semibold shadow-xl whitespace-nowrap">
                <div className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0" />
                <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                Corridor Active — 300 m buffer
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Right-side controls */}
        <div className={`absolute right-4 z-[1000] flex flex-col gap-2 transition-all ${deviationAlert ? "top-24" : "top-20"}`}>
          <button onClick={handleToggleSim}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold shadow-xl transition-all whitespace-nowrap ${simMode ? "bg-[#2563EB] text-white" : "bg-[#18181B]/90 backdrop-blur-md border border-white/10 text-[#A1A1AA] hover:text-white hover:bg-white/10"}`}
            style={simMode ? { boxShadow: "0 0 18px rgba(37,99,235,0.45)" } : {}}>
            <Cpu className="w-4 h-4 flex-shrink-0" />
            {simMode ? "Simulation ON" : "Enable Simulation"}
          </button>

          <AnimatePresence>
            {isRunning && (
              <motion.button initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                onClick={() => {
                  if (destination) {
                    setDestination(null)
                    if (destMarkerRef.current) { destMarkerRef.current.remove(); destMarkerRef.current = null }
                    if (bufferLayerRef.current) { bufferLayerRef.current.remove(); bufferLayerRef.current = null }
                    if (routeLineRef.current) { routeLineRef.current.remove(); routeLineRef.current = null }
                    corridorRef.current = null
                  } else { setAwaitingDest(true) }
                }}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold shadow-xl transition-all whitespace-nowrap ${destination ? "bg-[#18181B]/90 backdrop-blur-md border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10" : "bg-[#18181B]/90 backdrop-blur-md border border-white/10 text-[#A1A1AA] hover:text-white hover:bg-white/10"}`}>
                <MapPin className="w-4 h-4 flex-shrink-0" />
                {destination ? "Clear Destination" : "Set Destination"}
              </motion.button>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {isRunning && (
              <motion.button initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                onClick={handleTriggerDeviation}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#18181B]/90 backdrop-blur-md border border-red-500/40 text-red-400 hover:bg-red-500/20 text-sm font-semibold shadow-xl transition-all whitespace-nowrap">
                <Zap className="w-4 h-4 flex-shrink-0" />
                Trigger Deviation
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {/* Error toast */}
        <AnimatePresence>
          {error && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="absolute bottom-32 left-4 right-4 z-[1000] flex items-center gap-3 p-4 rounded-xl bg-red-500/20 backdrop-blur-md border border-red-500/30 text-red-400 shadow-xl">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <p className="text-sm flex-1">{error}</p>
              <button onClick={() => setError(null)} className="text-red-400 hover:text-white text-xs">✕</button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Trip ID badge */}
        <AnimatePresence>
          {trip && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="absolute bottom-24 left-4 z-[1000] px-3 py-1.5 rounded-lg bg-[#18181B]/90 backdrop-blur-md border border-white/10 text-[#A1A1AA] text-xs font-mono shadow-xl">
              {trip.tripId} · {trip.path.length} pts
            </motion.div>
          )}
        </AnimatePresence>

        {/* Start / End Ride */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1000]">
          <AnimatePresence mode="wait">
            {!isRunning ? (
              <motion.button key="start" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
                onClick={handleStartRide} disabled={startingRide}
                className="flex items-center gap-2.5 px-8 py-3.5 rounded-2xl font-semibold text-white text-sm shadow-2xl disabled:opacity-60"
                style={{ background: simMode ? "linear-gradient(135deg,#2563EB,#1d4ed8)" : "linear-gradient(135deg,#7C3AED,#2563EB)", boxShadow: simMode ? "0 0 30px rgba(37,99,235,0.5)" : "0 0 30px rgba(124,58,237,0.5)" }}>
                {startingRide ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-white" />}
                {startingRide ? "Starting…" : simMode ? "Start Sim Ride" : "Start Ride"}
              </motion.button>
            ) : (
              <motion.button key="end" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
                onClick={handleEndRide}
                className="flex items-center gap-2.5 px-8 py-3.5 rounded-2xl font-semibold text-white text-sm shadow-2xl"
                style={{ background: "linear-gradient(135deg,#dc2626,#991b1b)", boxShadow: "0 0 24px rgba(220,38,38,0.5)" }}>
                <Square className="w-4 h-4 fill-white" />
                End Ride
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
