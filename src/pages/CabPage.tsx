import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { Link } from "react-router-dom"
import { motion, AnimatePresence } from "framer-motion"
import {
  Search, Crosshair, Loader2, AlertTriangle,
  Play, Square, Radio, Cpu, Zap, MapPin,
  Wifi, WifiOff, Network,
  Sliders, AlertCircle, ShieldAlert, CheckCircle2,
  Clock, Shield, Car, Star, UserCheck,
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
type RelayPhase = "idle" | "scanning" | "connecting" | "queued"

interface RelayNode { id: string; lat: number; lng: number }
interface QueuedPacket { payload: object; signature: string; publicKey: string }

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

// ── Booking types ───────────────────────────────────────────────────────────

interface VehicleOption {
  id: string; name: string; icon: string | null; img: string | null
  fareMin: number; fareMax: number; fare: number
  eta: number; safetyScore: number; model: string
}

interface DriverDetails {
  name: string; initials: string
  rating: number; vehicleNumber: string; model: string
}

type BookingStep = "select" | "assigning" | "assigned" | "riding"

// ── Constants ──────────────────────────────────────────────────────────────

const SIM_STEP = 0.0003
const SIM_ARRIVE_THRESHOLD = 0.0002
const CORRIDOR_RADIUS_KM = 0.3
const DEVIATION_JUMP = 1.5

// ── Risk scoring constants ──────────────────────────────────────────────────
const RISK_DECAY         = 4    // score decrease per tick while inside corridor
const RISK_BASE_INCREASE = 5    // base score increase per tick while outside
const RISK_TIME_FACTOR   = 0.8  // extra score per consecutive tick outside
const RISK_DIST_FACTOR   = 12   // extra score per km from route line
const RISK_CAP_PER_TICK  = 30   // max score increase in a single tick

// ── Booking catalog ─────────────────────────────────────────────────────────

const VEHICLE_CATALOG = [
  { id: "mini",    name: "Mini",    icon: null,         img: "/mini.png",   fareMin: 80,  fareMax: 150, model: "Maruti Alto / WagonR" },
  { id: "sedan",   name: "Sedan",   icon: null,         img: "/sedan.png",  fareMin: 120, fareMax: 200, model: "Honda City / Dzire"   },
  { id: "suv",     name: "SUV",     icon: null,         img: "/suv.png",    fareMin: 180, fareMax: 280, model: "Innova Crysta"        },
  { id: "premium", name: "Premium", icon: null,         img: "/premium.png", fareMin: 280, fareMax: 450, model: "Tesla Model 3"        },
]
const DRIVER_POOL = [
  { name: "Ravi Kumar",   initials: "RK" },
  { name: "Suresh Patel", initials: "SP" },
  { name: "Amit Singh",   initials: "AS" },
  { name: "Mohammed Ali", initials: "MA" },
  { name: "Karthik Nair", initials: "KN" },
]
const PLATES = ["MH 12 AB 4567", "KA 09 CD 8901", "DL 7C 2345 JK", "TN 22 EF 7890"]

function makeVehicleOptions(): VehicleOption[] {
  return VEHICLE_CATALOG.map(v => ({
    ...v,
    fare:        Math.floor(v.fareMin + Math.random() * (v.fareMax - v.fareMin)),
    eta:         2 + Math.floor(Math.random() * 7),
    safetyScore: 75 + Math.floor(Math.random() * 21),
  }))
}

function makeDriver(v: VehicleOption): DriverDetails {
  const d = DRIVER_POOL[Math.floor(Math.random() * DRIVER_POOL.length)]
  return {
    name:          d.name,
    initials:      d.initials,
    rating:        Math.round((4.1 + Math.random() * 0.8) * 10) / 10,
    vehicleNumber: PLATES[Math.floor(Math.random() * PLATES.length)],
    model:         v.model,
  }
}

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

/** Fetch a real driving route from the free OSRM demo server. Returns ordered [lat,lng] waypoints. */
async function fetchOsrmRoute(start: Coord, dest: Coord): Promise<Coord[]> {
  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${start.lng},${start.lat};${dest.lng},${dest.lat}` +
      `?overview=full&geometries=geojson`
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return []
    const data = await res.json()
    if (data.code !== "Ok" || !data.routes?.[0]) return []
    return (data.routes[0].geometry.coordinates as [number, number][]).map(
      ([lng, lat]) => ({ lat, lng })
    )
  } catch {
    return []
  }
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
  const [riskScore, setRiskScore]           = useState(0)
  const [demoOpen, setDemoOpen]             = useState(false)
  const [demoOffline, setDemoOffline]       = useState(false)
  const [routeCoords, setRouteCoords]       = useState<Coord[]>([])
  const [fetchingRoute, setFetchingRoute]   = useState(false)

  // ── Booking state ────────────────────────────────────────────────────────
  const [bookingStep, setBookingStep]         = useState<BookingStep>(() => {
    const s = loadTrip()
    return (s?.status === "ACTIVE" || s?.status === "ALERT") ? "riding" : "select"
  })
  const [vehicleOptions, setVehicleOptions]   = useState<VehicleOption[]>(() => makeVehicleOptions())
  const [selectedVehicle, setSelectedVehicle] = useState<VehicleOption | null>(null)
  const [driverDetails, setDriverDetails]     = useState<DriverDetails | null>(null)
  const [etaCountdown, setEtaCountdown]       = useState(0)

  // ── Relay / offline state ────────────────────────────────────────────────
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [relayPhase, setRelayPhase] = useState<RelayPhase>("idle")
  const [relayNodes, setRelayNodes] = useState<RelayNode[]>([])
  const [relayHops, setRelayHops] = useState(0)
  const [transmitStatus, setTransmitStatus] = useState<"idle" | "transmitting" | "transmitted">("idle")

  // Map layer refs
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.CircleMarker | null>(null)
  const destMarkerRef = useRef<L.CircleMarker | null>(null)
  const accuracyCircleRef = useRef<L.Circle | null>(null)
  const polylineRef = useRef<L.Polyline | null>(null)
  const routeLineRef = useRef<L.Polyline | null>(null)
  const bufferLayerRef = useRef<L.GeoJSON | null>(null)
  const tileLayerRef = useRef<L.TileLayer | null>(null)

  // Logic refs
  const watchIdRef = useRef<number | null>(null)
  const simIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const simPosRef = useRef<Coord>({ lat: 20.5937, lng: 78.9629 })
  const tripRef = useRef<Trip | null>(trip)
  const destinationRef = useRef<Coord | null>(destination)
  const corridorRef = useRef<Feature<Polygon> | null>(null)
  const awaitingDestRef = useRef(false)
  const alertEmittedRef  = useRef(false)
  const keyPairRef       = useRef<CryptoKeyPair | null>(null)
  const riskScoreRef     = useRef(0)
  const timeOutsideRef   = useRef(0)
  const demoRampRef      = useRef<ReturnType<typeof setInterval> | null>(null)
  const demoOfflineRef   = useRef(false)
  const routeCoordsRef   = useRef<Coord[]>([])
  const simRouteIdxRef   = useRef(0)

  // Relay refs
  const relayLayerRef    = useRef<L.LayerGroup | null>(null)
  const queuedPacketRef  = useRef<QueuedPacket | null>(null)
  const isOnlineRef      = useRef(navigator.onLine)
  const relayPhaseRef    = useRef<RelayPhase>("idle")

  useEffect(() => { tripRef.current = trip }, [trip])
  useEffect(() => { destinationRef.current = destination }, [destination])
  useEffect(() => { awaitingDestRef.current = awaitingDest }, [awaitingDest])
  useEffect(() => { isOnlineRef.current = isOnline }, [isOnline])
  useEffect(() => { relayPhaseRef.current = relayPhase }, [relayPhase])

  // ── Network detection ────────────────────────────────────────────────────

  useEffect(() => {
    const goOnline  = () => setIsOnline(true)
    const goOffline = () => setIsOnline(false)
    window.addEventListener("online",  goOnline)
    window.addEventListener("offline", goOffline)
    return () => {
      window.removeEventListener("online",  goOnline)
      window.removeEventListener("offline", goOffline)
    }
  }, [])

  // ── Booking countdown ────────────────────────────────────────────────────

  useEffect(() => {
    if (bookingStep !== "assigning") return
    const init = 5 + Math.floor(Math.random() * 4)   // 5–8 s
    setEtaCountdown(init)
    let rem = init
    const id = setInterval(() => {
      rem -= 1
      setEtaCountdown(rem)
      if (rem <= 0) { clearInterval(id); setBookingStep("assigned") }
    }, 1000)
    return () => clearInterval(id)
  }, [bookingStep])

  // ── Clear relay layer helper ──────────────────────────────────────────────

  const clearRelay = useCallback(() => {
    relayLayerRef.current?.clearLayers()
    setRelayNodes([])
    setRelayHops(0)
    setRelayPhase("idle")
    relayPhaseRef.current = "idle"
    queuedPacketRef.current = null
  }, [])

  // ── Relay simulation ──────────────────────────────────────────────────────

  const startRelaySimulation = useCallback((lat: number, lng: number) => {
    if (relayPhaseRef.current !== "idle") return
    setRelayPhase("scanning")
    relayPhaseRef.current = "scanning"

    // Generate 1–3 nearby virtual Sahayak Nodes
    const count = 1 + Math.floor(Math.random() * 3)
    const nodes: RelayNode[] = Array.from({ length: count }, (_, i) => ({
      id: `SN-${String(i + 1).padStart(2, "0")}`,
      lat: lat + (Math.random() * 0.018 - 0.009),
      lng: lng + (Math.random() * 0.018 - 0.009),
    }))
    setRelayNodes(nodes)

    const map = mapInstanceRef.current
    const layer = relayLayerRef.current
    if (map && layer) {
      nodes.forEach((node, i) => {
        setTimeout(() => {
          if (!relayLayerRef.current) return
          // Blue glowing node marker
          L.circleMarker([node.lat, node.lng], {
            radius: 9, fillColor: "#3b82f6", color: "#93c5fd",
            weight: 2.5, fillOpacity: 0.85, pane: "markerPane",
          })
            .bindTooltip(`⚡ Sahayak Node ${node.id}`, { permanent: false, direction: "top" })
            .addTo(relayLayerRef.current)

          // Animated dashed connection line: user → node
          L.polyline([[lat, lng], [node.lat, node.lng]], {
            color: "#60a5fa", weight: 2, dashArray: "8 5", opacity: 0.75,
          }).addTo(relayLayerRef.current)
        }, i * 600)
      })
    }

    // Phase: scanning → connecting (after 2 s)
    setTimeout(() => {
      if (relayPhaseRef.current !== "scanning") return
      setRelayPhase("connecting")
      relayPhaseRef.current = "connecting"
      setRelayHops(1)
    }, 2000)

    // Phase: connecting → queued (4–6 s total)
    const queueDelay = 4000 + Math.floor(Math.random() * 2000)
    setTimeout(() => {
      if (relayPhaseRef.current !== "connecting") return
      setRelayPhase("queued")
      relayPhaseRef.current = "queued"
      setRelayHops(nodes.length)
    }, queueDelay)
  }, [])

  // ── Auto-send queued packet when network reconnects ───────────────────────

  useEffect(() => {
    if (!isOnline || !queuedPacketRef.current) return
    const pkt = queuedPacketRef.current
    setTransmitStatus("transmitting")
    // Small dramatic delay so user sees the "transmitting" state
    setTimeout(() => {
      getSocket().emit("EMERGENCY_EVENT", pkt)
      queuedPacketRef.current = null
      setTransmitStatus("transmitted")
      clearRelay()
      setTimeout(() => setTransmitStatus("idle"), 5000)
    }, 1200)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline])

  // ── Corridor (useMemo) ────────────────────────────────────────────────────

  const corridor = useMemo(() => {
    // Prefer OSRM route polyline for a more accurate corridor
    if (routeCoords.length >= 2) {
      const line = turf.lineString(routeCoords.map(c => [c.lng, c.lat]))
      return turf.buffer(line, CORRIDOR_RADIUS_KM, { units: "kilometers" }) as Feature<Polygon>
    }
    // Fallback: straight line between start and dest (while OSRM loads)
    return buildCorridor(trip?.startLocation ?? null, destination)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeCoords, trip?.startLocation?.lat, trip?.startLocation?.lng, destination?.lat, destination?.lng])

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

    if (routeCoords.length >= 2) {
      // Draw actual OSRM road route
      const lls = routeCoords.map(c => [c.lat, c.lng] as L.LatLngTuple)
      routeLineRef.current = L.polyline(lls, {
        color: "#a78bfa", weight: 4, opacity: 0.9,
      }).addTo(map)
      // Fit map to the real route bounds
      try { map.fitBounds(routeLineRef.current.getBounds(), { padding: [60, 60] }) } catch { /* ignore */ }
    } else if (trip?.startLocation && destination) {
      // Fallback straight-line while OSRM loads (dashed)
      const startPt = [trip.startLocation.lat, trip.startLocation.lng] as L.LatLngTuple
      const destPt  = [destination.lat, destination.lng] as L.LatLngTuple
      routeLineRef.current = L.polyline([startPt, destPt],
        { color: "#a78bfa", weight: 2, dashArray: "6 6", opacity: 0.6 }
      ).addTo(map)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corridor, routeCoords])

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
    const tl = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map)
    tileLayerRef.current = tl
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
    relayLayerRef.current = L.layerGroup().addTo(map)

    return () => {
      cancelAnimationFrame(rafId)
      map.remove()
      mapInstanceRef.current = null
      markerRef.current = null
      relayLayerRef.current = null
      tileLayerRef.current  = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onResize = () => mapInstanceRef.current?.invalidateSize()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  // ── Offline map mode ──────────────────────────────────────────────────────

  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return
    const container = map.getContainer()

    if (!isOnline) {
      // Strip tile layer → dark void background
      if (tileLayerRef.current && map.hasLayer(tileLayerRef.current)) {
        tileLayerRef.current.remove()
      }
      container.style.backgroundColor = "#0f0f14"
      // Lock interactions for dramatic effect
      map.dragging.disable()
      map.touchZoom.disable()
      map.doubleClickZoom.disable()
      map.scrollWheelZoom.disable()
      map.keyboard.disable()
    } else {
      // Restore tile layer
      if (tileLayerRef.current && !map.hasLayer(tileLayerRef.current)) {
        tileLayerRef.current.addTo(map)
      }
      container.style.backgroundColor = ""
      // Re-enable all interactions
      map.dragging.enable()
      map.touchZoom.enable()
      map.doubleClickZoom.enable()
      map.scrollWheelZoom.enable()
      map.keyboard.enable()
    }
  }, [isOnline])

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

  // ── OSRM route fetch ──────────────────────────────────────────────────────

  useEffect(() => {
    const start = tripRef.current?.startLocation
    if (!destination || !start) return

    let cancelled = false
    setFetchingRoute(true)

    fetchOsrmRoute(start, destination).then(coords => {
      if (cancelled) return
      setFetchingRoute(false)
      if (coords.length >= 2) {
        // Find nearest route point to current sim position so sim starts from there
        const cur = simPosRef.current
        let nearest = 0, minDist = Infinity
        coords.forEach((c, i) => {
          const d = (c.lat - cur.lat) ** 2 + (c.lng - cur.lng) ** 2
          if (d < minDist) { minDist = d; nearest = i }
        })
        simRouteIdxRef.current = nearest
        routeCoordsRef.current = coords
        setRouteCoords(coords)
      } else {
        // OSRM unavailable — keep straight-line fallback silently
        setFetchingRoute(false)
      }
    })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination?.lat, destination?.lng])

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
    const current  = tripRef.current
    let markerColor = polyColor
    let lineColor   = polyColor

    if (corridor && current && (current.status === "ACTIVE" || current.status === "ALERT")) {
      const inside = isInsideCorridor(corridor, lat, lng)

      if (!inside) {
        markerColor = "#ef4444"
        lineColor   = "#ef4444"

        // First time outside: escalate trip to ALERT
        if (current.status === "ACTIVE") {
          const alertTrip: Trip = { ...current, status: "ALERT" }
          tripRef.current = alertTrip
          setTrip(alertTrip)
          saveTrip(alertTrip)
          setDeviationAlert(true)
        }

        // ── Risk score: increase every tick outside ─────────────────────────
        timeOutsideRef.current += 1

        // Distance from route line (km) — used to scale risk increase
        const start = current.startLocation
        const dest  = destinationRef.current
        let distKm  = 0
        if (start && dest) {
          const line    = turf.lineString([[start.lng, start.lat], [dest.lng, dest.lat]])
          const nearest = turf.nearestPointOnLine(line, turf.point([lng, lat]), { units: "kilometers" })
          distKm        = nearest.properties.dist ?? 0
        }

        const prevRisk = riskScoreRef.current
        const rawInc   = RISK_BASE_INCREASE
                       + timeOutsideRef.current * RISK_TIME_FACTOR
                       + distKm * RISK_DIST_FACTOR
        const increase = Math.min(rawInc, RISK_CAP_PER_TICK)
        const newRisk  = Math.min(100, prevRisk + increase)
        riskScoreRef.current = newRisk
        setRiskScore(newRisk)

        // Only emit emergency when risk first crosses CRITICAL (≥ 70)
        if (newRisk >= 70 && !alertEmittedRef.current) {
          alertEmittedRef.current = true
          const emergencyPayload = {
            tripId:    current.tripId,
            location:  { lat, lng },
            timestamp: Date.now(),
            severity:  "HIGH" as const,
          }
          ;(async () => {
            const kp = keyPairRef.current
            let pkt: QueuedPacket
            if (kp) {
              const [signature, publicKey] = await Promise.all([
                signPayload(kp.privateKey, emergencyPayload),
                exportPublicKey(kp.publicKey),
              ])
              pkt = { payload: emergencyPayload, signature, publicKey }
            } else {
              pkt = { payload: emergencyPayload, signature: "", publicKey: "" }
            }
            if (isOnlineRef.current) {
              getSocket().emit("EMERGENCY_EVENT", pkt)
            } else {
              queuedPacketRef.current = pkt
              startRelaySimulation(lat, lng)
            }
          })()
        }

      } else {
        // ── Inside corridor: gradually decay risk score ─────────────────────
        timeOutsideRef.current = 0
        const prevRisk = riskScoreRef.current
        const newRisk  = Math.max(0, prevRisk - RISK_DECAY)
        riskScoreRef.current = newRisk
        setRiskScore(newRisk)
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
  }, [placeMarker, appendToPolyline, startRelaySimulation])

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
      const rCoords = routeCoordsRef.current

      if (rCoords.length >= 2) {
        // ── Road-following mode: walk OSRM waypoints ──────────────────────
        const idx = simRouteIdxRef.current
        if (idx >= rCoords.length) {
          // Reached end of route
          clearInterval(simIntervalRef.current!)
          simIntervalRef.current = null
          setSimActive(false)
          return
        }
        const pt = rCoords[idx]
        pushCoord(pt.lat, pt.lng, "#2563EB")
        simRouteIdxRef.current = idx + 1
      } else {
        // ── Fallback: vector movement toward destination ───────────────────
        const cur  = simPosRef.current
        const dest = destinationRef.current
        if (dest) {
          const deltaLat = dest.lat - cur.lat
          const deltaLng = dest.lng - cur.lng
          const distance = Math.sqrt(deltaLat * deltaLat + deltaLng * deltaLng)
          if (distance < SIM_ARRIVE_THRESHOLD) {
            pushCoord(dest.lat, dest.lng, "#2563EB")
            clearInterval(simIntervalRef.current!)
            simIntervalRef.current = null
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
    setRiskScore(0)
    setRouteCoords([])
    riskScoreRef.current   = 0
    timeOutsideRef.current = 0
    alertEmittedRef.current = false
    keyPairRef.current     = null
    routeCoordsRef.current = []
    simRouteIdxRef.current = 0

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

      setBookingStep("riding")
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
    setRiskScore(0)
    setRouteCoords([])
    setBookingStep("select")
    setSelectedVehicle(null)
    setDriverDetails(null)
    setVehicleOptions(makeVehicleOptions())
    riskScoreRef.current   = 0
    timeOutsideRef.current = 0
    routeCoordsRef.current = []
    simRouteIdxRef.current = 0
    clearRelay()
    setTransmitStatus("idle")
    markerRef.current?.bindPopup("<b>Trip Ended</b>").openPopup()
    if (polylineRef.current && mapInstanceRef.current) {
      try { mapInstanceRef.current.fitBounds(polylineRef.current.getBounds(), { padding: [60, 60] }) } catch { /* short */ }
    }
  }, [stopWatch, stopSimulation, clearRelay])

  // ── Confirm Ride ──────────────────────────────────────────────────────────

  const handleConfirmRide = useCallback(() => {
    if (!selectedVehicle) return
    setDriverDetails(makeDriver(selectedVehicle))
    setBookingStep("assigning")
  }, [selectedVehicle])

  useEffect(() => {
    getSocket()
    return () => {
      stopWatch(); stopSimulation(); releaseSocket()
      if (demoRampRef.current) clearInterval(demoRampRef.current)
    }
  }, [stopWatch, stopSimulation])

  // ── Demo Control Panel helpers ────────────────────────────────────────────

  /** Smoothly animate riskScore from its current value to `target` over `ms`. */
  const rampRisk = useCallback((target: number, ms = 2000) => {
    if (demoRampRef.current) clearInterval(demoRampRef.current)
    const start  = riskScoreRef.current
    const startT = Date.now()
    demoRampRef.current = setInterval(() => {
      const p   = Math.min(1, (Date.now() - startT) / ms)
      const val = Math.round(start + (target - start) * p)
      riskScoreRef.current = val
      setRiskScore(val)
      if (p >= 1) { clearInterval(demoRampRef.current!); demoRampRef.current = null }
    }, 40)
  }, [])

  /** Demo: ride entirely inside corridor — score decays to 0. */
  const demoSafeRide = useCallback(() => {
    timeOutsideRef.current = 0
    setDeviationAlert(false)
    rampRisk(0, 2500)
  }, [rampRisk])

  /** Demo: mild drift — WARNING band. */
  const demoMildDeviation = useCallback(() => {
    const current = tripRef.current
    if (!current) { setError("Start a ride first to use demo scenarios."); return }
    if (current.status === "ACTIVE") {
      const alertTrip: Trip = { ...current, status: "ALERT" }
      tripRef.current = alertTrip; setTrip(alertTrip); saveTrip(alertTrip)
    }
    setDeviationAlert(true)
    timeOutsideRef.current = 5
    rampRisk(45, 2000)
  }, [rampRisk])

  /** Demo: serious drift — approaches CRITICAL but stays below emission. */
  const demoCriticalDeviation = useCallback(() => {
    const current = tripRef.current
    if (!current) { setError("Start a ride first to use demo scenarios."); return }
    if (current.status === "ACTIVE") {
      const alertTrip: Trip = { ...current, status: "ALERT" }
      tripRef.current = alertTrip; setTrip(alertTrip); saveTrip(alertTrip)
    }
    setDeviationAlert(true)
    timeOutsideRef.current = 15
    rampRisk(82, 2500)
  }, [rampRisk])

  /** Demo: instantly reach CRITICAL and emit emergency. */
  const demoTriggerEmergency = useCallback(() => {
    const current = tripRef.current
    if (!current) { setError("Start a ride first to use demo scenarios."); return }
    if (current.status === "ACTIVE") {
      const alertTrip: Trip = { ...current, status: "ALERT" }
      tripRef.current = alertTrip; setTrip(alertTrip); saveTrip(alertTrip)
    }
    setDeviationAlert(true)
    riskScoreRef.current = 100; setRiskScore(100)
    if (!alertEmittedRef.current) {
      alertEmittedRef.current = true
      const pos = simPosRef.current
      const emergencyPayload = {
        tripId:    current.tripId,
        location:  { lat: pos.lat, lng: pos.lng },
        timestamp: Date.now(),
        severity:  "HIGH" as const,
      }
      ;(async () => {
        const kp = keyPairRef.current
        let pkt: QueuedPacket
        if (kp) {
          const [sig, pub] = await Promise.all([
            signPayload(kp.privateKey, emergencyPayload),
            exportPublicKey(kp.publicKey),
          ])
          pkt = { payload: emergencyPayload, signature: sig, publicKey: pub }
        } else {
          pkt = { payload: emergencyPayload, signature: "", publicKey: "" }
        }
        if (isOnlineRef.current) {
          getSocket().emit("EMERGENCY_EVENT", pkt)
        } else {
          queuedPacketRef.current = pkt
          startRelaySimulation(pos.lat, pos.lng)
        }
      })()
    }
  }, [startRelaySimulation])

  /** Demo: force system offline / restore to real network state. */
  const demoToggleOffline = useCallback(() => {
    const next = !demoOfflineRef.current
    demoOfflineRef.current = next
    setDemoOffline(next)
    setIsOnline(!next)
    isOnlineRef.current = !next
    if (next) {
      // Forced offline — if there's an active queued packet start relay immediately
      const pos = simPosRef.current
      if (deviationAlert && !queuedPacketRef.current) startRelaySimulation(pos.lat, pos.lng)
    } else {
      // Back online — clear relay UI if nothing queued
      if (!queuedPacketRef.current) clearRelay()
    }
  }, [deviationAlert, startRelaySimulation, clearRelay])

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

  const isActive    = trip?.status === "ACTIVE"
  const isAlert     = trip?.status === "ALERT"
  const isRunning   = isActive || isAlert
  const isCompleted = trip?.status === "COMPLETED"

  const riskStatus: "SAFE" | "WARNING" | "CRITICAL" =
    riskScore < 30 ? "SAFE" : riskScore < 70 ? "WARNING" : "CRITICAL"

  const riskColor =
    riskStatus === "SAFE" ? "#22c55e" : riskStatus === "WARNING" ? "#eab308" : "#ef4444"

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

        {/* Offline grid overlay — shown instead of tiles */}
        <AnimatePresence>
          {!isOnline && (
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.6 }}
              className="absolute inset-0 z-[1] pointer-events-none"
              style={{
                backgroundImage: `
                  linear-gradient(rgba(124,58,237,0.07) 1px, transparent 1px),
                  linear-gradient(90deg, rgba(124,58,237,0.07) 1px, transparent 1px),
                  linear-gradient(rgba(124,58,237,0.03) 1px, transparent 1px),
                  linear-gradient(90deg, rgba(124,58,237,0.03) 1px, transparent 1px)
                `,
                backgroundSize: "80px 80px, 80px 80px, 20px 20px, 20px 20px",
              }}
            />
          )}
        </AnimatePresence>

        {/* Offline Secure Mode banner */}
        <AnimatePresence>
          {!isOnline && relayPhase === "idle" && (
            <motion.div
              initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
              className={`absolute left-0 right-0 z-[1048] ${deviationAlert ? "top-12" : "top-0"}`}>
              <motion.div
                animate={{ opacity: [0.85, 1, 0.85] }} transition={{ repeat: Infinity, duration: 2.5 }}
                className="flex items-center justify-center gap-3 px-6 py-2.5 text-sm font-bold text-white"
                style={{ background: "linear-gradient(90deg,#312e81,#4f46e5,#312e81)", boxShadow: "0 4px 20px rgba(79,70,229,0.45)" }}>
                <motion.div
                  animate={{ scale: [1, 1.15, 1] }} transition={{ repeat: Infinity, duration: 1.8 }}>
                  <WifiOff className="w-4 h-4" />
                </motion.div>
                ⚡ Offline Secure Mode — Relay Enabled · Map tiles suspended
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

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

        {/* Relay mode banner */}
        <AnimatePresence>
          {relayPhase !== "idle" && (
            <motion.div
              initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
              className={`absolute left-0 right-0 z-[1049] ${deviationAlert && !isOnline ? "top-24" : deviationAlert ? "top-12" : !isOnline ? "top-10" : "top-0"}`}>
              <motion.div
                animate={{ opacity: [0.88, 1, 0.88] }} transition={{ repeat: Infinity, duration: 1.6 }}
                className="flex items-center justify-center gap-3 px-6 py-2.5 text-sm font-bold text-white"
                style={{ background: "linear-gradient(90deg,#1e3a8a,#2563eb,#1e3a8a)", boxShadow: "0 4px 20px rgba(37,99,235,0.55)" }}>
                <motion.div animate={{ rotate: relayPhase === "scanning" ? 360 : 0 }} transition={{ repeat: Infinity, duration: 1.4, ease: "linear" }}>
                  <Network className="w-4 h-4" />
                </motion.div>
                {relayPhase === "scanning"   && "⚡ Network Unavailable — Switching to Relay Mode"}
                {relayPhase === "connecting" && `⚡ Connecting via Sahayak Nodes… (${relayHops} hop${relayHops !== 1 ? "s" : ""})`}
                {relayPhase === "queued"     && `📡 Emergency queued · ${relayHops} relay hop${relayHops !== 1 ? "s" : ""} — will transmit on reconnect`}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Transmission success banner */}
        <AnimatePresence>
          {transmitStatus === "transmitting" && (
            <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
              className="absolute top-0 left-0 right-0 z-[1049]">
              <div className="flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-bold text-white"
                style={{ background: "linear-gradient(90deg,#065f46,#10b981,#065f46)", boxShadow: "0 4px 20px rgba(16,185,129,0.5)" }}>
                <Loader2 className="w-4 h-4 animate-spin" />
                Transmitting emergency packet…
              </div>
            </motion.div>
          )}
          {transmitStatus === "transmitted" && (
            <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
              className="absolute top-0 left-0 right-0 z-[1049]">
              <div className="flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-bold text-white"
                style={{ background: "linear-gradient(90deg,#065f46,#10b981,#065f46)", boxShadow: "0 4px 20px rgba(16,185,129,0.5)" }}>
                <Wifi className="w-4 h-4" />
                ✓ Emergency transmitted successfully
              </div>
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

          {/* Network status badge */}
          <motion.div
            key={isOnline ? "online" : "offline"}
            initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold backdrop-blur-md border shadow-xl whitespace-nowrap ${
              isOnline
                ? "bg-[#18181B]/90 border-emerald-500/40 text-emerald-400"
                : "bg-[#18181B]/90 border-red-500/40 text-red-400"
            }`}>
            {isOnline
              ? <Wifi className="w-3 h-3" />
              : <motion.div animate={{ opacity: [0.5, 1, 0.5] }} transition={{ repeat: Infinity, duration: 1 }}><WifiOff className="w-3 h-3" /></motion.div>
            }
            {isOnline ? "Online" : "Offline"}
          </motion.div>

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
            {destination && isRunning && fetchingRoute && (
              <motion.div initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-[#18181B]/90 backdrop-blur-md border border-purple-500/40 text-purple-400 text-xs font-semibold shadow-xl whitespace-nowrap">
                <Loader2 className="w-3.5 h-3.5 flex-shrink-0 animate-spin" />
                Fetching road route…
              </motion.div>
            )}
            {destination && isRunning && !fetchingRoute && (
              <motion.div
                key={routeCoords.length > 0 ? "road" : "straight"}
                initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                className={`flex items-center gap-2 px-4 py-2 rounded-full bg-[#18181B]/90 backdrop-blur-md text-xs font-semibold shadow-xl whitespace-nowrap ${
                  routeCoords.length > 0
                    ? "border border-emerald-500/40 text-emerald-400"
                    : "border border-yellow-500/40 text-yellow-400"
                }`}>
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${routeCoords.length > 0 ? "bg-emerald-400" : "bg-yellow-400"}`} />
                <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                {routeCoords.length > 0
                  ? `Road Route — ${routeCoords.length} waypoints`
                  : "Corridor Active — straight line"}
              </motion.div>
            )}
            {isRunning && riskScore > 0 && (
              <motion.div
                key={riskStatus}
                initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-[#18181B]/90 backdrop-blur-md text-xs font-bold shadow-xl whitespace-nowrap"
                style={{ border: `1px solid ${riskColor}55`, color: riskColor }}>
                <motion.div
                  animate={riskStatus === "CRITICAL" ? { scale: [1, 1.35, 1] } : {}}
                  transition={{ repeat: Infinity, duration: 0.7 }}
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: riskColor }}
                />
                Risk {Math.round(riskScore)} — {riskStatus}
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
                    setRouteCoords([])
                    routeCoordsRef.current = []
                    simRouteIdxRef.current = 0
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

          {/* ── Demo Controls toggle ── */}
          <div className="mt-1 pt-2 border-t border-white/10">
            <button
              onClick={() => setDemoOpen(d => !d)}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold shadow-xl transition-all w-full whitespace-nowrap ${
                demoOpen
                  ? "bg-[#7C3AED]/25 border border-[#7C3AED]/60 text-purple-300"
                  : "bg-[#18181B]/90 backdrop-blur-md border border-white/10 text-[#A1A1AA] hover:text-white hover:bg-white/10"
              }`}
              style={demoOpen ? { boxShadow: "0 0 18px rgba(124,58,237,0.3)" } : {}}>
              <Sliders className="w-4 h-4 flex-shrink-0" />
              {demoOpen ? "Close Demo" : "Demo Controls"}
            </button>
          </div>

          {/* ── Demo panel (collapsible) ── */}
          <AnimatePresence>
            {demoOpen && (
              <motion.div
                initial={{ opacity: 0, height: 0, y: -8 }}
                animate={{ opacity: 1, height: "auto", y: 0 }}
                exit={{ opacity: 0, height: 0, y: -8 }}
                transition={{ duration: 0.25, ease: "easeInOut" }}
                className="overflow-hidden">
                <div className="rounded-2xl overflow-hidden shadow-2xl mt-0.5"
                  style={{ background: "rgba(12,12,18,0.97)", backdropFilter: "blur(16px)", border: "1px solid rgba(124,58,237,0.3)" }}>

                  {/* Header */}
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-white/8"
                    style={{ background: "linear-gradient(135deg,rgba(124,58,237,0.18),transparent)" }}>
                    <motion.div
                      animate={{ opacity: [0.5, 1, 0.5] }} transition={{ repeat: Infinity, duration: 2 }}
                      className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                    <span className="text-[10px] font-bold tracking-[0.15em] text-purple-300 uppercase">Demo Controls</span>
                    <span className="ml-auto text-[9px] text-[#52525B] font-medium">Presentation Only</span>
                  </div>

                  <div className="p-3 flex flex-col gap-2">

                    {/* Safe Ride */}
                    <button
                      onClick={demoSafeRide}
                      className="group flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all text-left w-full
                        bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 hover:border-emerald-500/50">
                      <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 group-hover:scale-110 transition-transform" />
                      <div>
                        <div className="text-[11px] font-bold">Simulate Safe Ride</div>
                        <div className="text-[9px] text-emerald-600 font-normal">Ramp risk → 0 (SAFE)</div>
                      </div>
                    </button>

                    {/* Mild Deviation */}
                    <button
                      onClick={demoMildDeviation}
                      className="group flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all text-left w-full
                        bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/20 hover:border-yellow-500/50">
                      <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 group-hover:scale-110 transition-transform" />
                      <div>
                        <div className="text-[11px] font-bold">Simulate Mild Deviation</div>
                        <div className="text-[9px] text-yellow-600 font-normal">Ramp risk → 45 (WARNING)</div>
                      </div>
                    </button>

                    {/* Critical Deviation */}
                    <button
                      onClick={demoCriticalDeviation}
                      className="group flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all text-left w-full
                        bg-orange-500/10 border border-orange-500/30 text-orange-400 hover:bg-orange-500/20 hover:border-orange-500/50">
                      <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0 group-hover:scale-110 transition-transform" />
                      <div>
                        <div className="text-[11px] font-bold">Simulate Critical Deviation</div>
                        <div className="text-[9px] text-orange-600 font-normal">Ramp risk → 82 (near CRITICAL)</div>
                      </div>
                    </button>

                    {/* Trigger Emergency */}
                    <button
                      onClick={demoTriggerEmergency}
                      className="group flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all text-left w-full
                        bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 hover:border-red-500/50">
                      <motion.div
                        animate={{ scale: [1, 1.15, 1] }} transition={{ repeat: Infinity, duration: 0.9 }}>
                        <Zap className="w-3.5 h-3.5 flex-shrink-0" />
                      </motion.div>
                      <div>
                        <div className="text-[11px] font-bold">Trigger Emergency Instantly</div>
                        <div className="text-[9px] text-red-600 font-normal">Risk → 100 → emit WebSocket</div>
                      </div>
                    </button>

                    {/* Offline Toggle */}
                    <button
                      onClick={demoToggleOffline}
                      className={`group flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all text-left w-full ${
                        demoOffline
                          ? "bg-blue-500/20 border border-blue-400/60 text-blue-300"
                          : "bg-blue-500/10 border border-blue-500/30 text-blue-400 hover:bg-blue-500/20 hover:border-blue-500/50"
                      }`}>
                      {demoOffline
                        ? <motion.div animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 1.2 }}>
                            <WifiOff className="w-3.5 h-3.5 flex-shrink-0" />
                          </motion.div>
                        : <Wifi className="w-3.5 h-3.5 flex-shrink-0 group-hover:scale-110 transition-transform" />
                      }
                      <div>
                        <div className="text-[11px] font-bold">{demoOffline ? "Restore Network" : "Toggle Offline Mode"}</div>
                        <div className={`text-[9px] font-normal ${demoOffline ? "text-blue-500" : "text-blue-600"}`}>
                          {demoOffline ? "Currently: OFFLINE (relay active)" : "Force relay mode simulation"}
                        </div>
                      </div>
                    </button>

                  </div>
                </div>
              </motion.div>
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

        {/* Relay status panel */}
        <AnimatePresence>
          {relayPhase !== "idle" && (
            <motion.div
              initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}
              className="absolute bottom-32 left-4 z-[1000] w-56 rounded-xl overflow-hidden shadow-2xl"
              style={{ border: "1px solid rgba(59,130,246,0.4)", background: "rgba(15,23,42,0.92)", backdropFilter: "blur(12px)" }}>
              <div className="px-4 py-2.5 flex items-center gap-2 border-b border-blue-500/20"
                style={{ background: "linear-gradient(90deg,rgba(37,99,235,0.2),transparent)" }}>
                <motion.div animate={{ opacity: [0.5, 1, 0.5] }} transition={{ repeat: Infinity, duration: 1.2 }}
                  className="w-2 h-2 rounded-full bg-blue-500" />
                <span className="text-blue-300 text-xs font-bold tracking-wider">RELAY MODE</span>
              </div>
              <div className="px-4 py-3 space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-[#A1A1AA]">Status</span>
                  <span className="text-blue-300 font-semibold capitalize">
                    {relayPhase === "scanning" && "Scanning…"}
                    {relayPhase === "connecting" && "Connecting"}
                    {relayPhase === "queued" && "Queued"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#A1A1AA]">Relay Hops</span>
                  <span className="text-blue-300 font-semibold">{relayHops}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#A1A1AA]">Nodes Found</span>
                  <span className="text-blue-300 font-semibold">{relayNodes.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#A1A1AA]">Transmission</span>
                  <span className={`font-semibold ${relayPhase === "queued" ? "text-yellow-400" : "text-blue-300"}`}>
                    {relayPhase === "queued" ? "Queued" : "Pending"}
                  </span>
                </div>
                {relayNodes.length > 0 && (
                  <div className="pt-1 border-t border-blue-500/20">
                    {relayNodes.map(n => (
                      <div key={n.id} className="flex items-center gap-1.5 mt-1">
                        <motion.div animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 1.5, delay: Math.random() }}
                          className="w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
                        <span className="text-blue-400 font-mono text-[10px]">{n.id}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Risk Score Meter */}
        <AnimatePresence>
          {isRunning && (
            <motion.div
              initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}
              className="absolute bottom-36 right-4 z-[1000] w-48 rounded-2xl overflow-hidden shadow-2xl"
              style={{ background: "rgba(18,18,22,0.92)", backdropFilter: "blur(14px)", border: `1px solid ${riskColor}40` }}>
              {/* Header */}
              <div className="flex items-center justify-between px-4 pt-3 pb-1">
                <span className="text-[10px] font-bold tracking-widest text-[#A1A1AA] uppercase">Risk Score</span>
                <motion.span
                  key={riskStatus}
                  initial={{ scale: 0.8 }} animate={{ scale: 1 }}
                  className="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-full"
                  style={{ background: `${riskColor}22`, color: riskColor, border: `1px solid ${riskColor}55` }}>
                  {riskStatus}
                </motion.span>
              </div>

              {/* Numeric score */}
              <div className="flex items-end gap-1 px-4 pb-2">
                <motion.span
                  key={Math.round(riskScore)}
                  initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                  className="text-3xl font-black tabular-nums"
                  style={{ color: riskColor }}>
                  {Math.round(riskScore)}
                </motion.span>
                <span className="text-[#A1A1AA] text-sm mb-1">/100</span>
              </div>

              {/* Bar track */}
              <div className="px-4 pb-4">
                <div className="h-2.5 rounded-full bg-white/8 overflow-hidden">
                  <motion.div
                    animate={{ width: `${riskScore}%` }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                    className="h-full rounded-full"
                    style={{
                      background: `linear-gradient(90deg, #22c55e, ${riskScore >= 30 ? "#eab308" : "#22c55e"}, ${riskScore >= 70 ? "#ef4444" : riskScore >= 30 ? "#eab308" : "#22c55e"})`,
                      boxShadow: riskScore > 0 ? `0 0 10px ${riskColor}80` : "none",
                    }}
                  />
                </div>

                {/* Scale ticks */}
                <div className="flex justify-between mt-1">
                  <span className="text-[9px] text-green-500">0</span>
                  <span className="text-[9px] text-yellow-500">30</span>
                  <span className="text-[9px] text-red-500">70</span>
                  <span className="text-[9px] text-[#A1A1AA]">100</span>
                </div>
              </div>

              {/* Critical pulse overlay */}
              {riskStatus === "CRITICAL" && (
                <motion.div
                  animate={{ opacity: [0, 0.15, 0] }}
                  transition={{ repeat: Infinity, duration: 1.2 }}
                  className="absolute inset-0 rounded-2xl pointer-events-none"
                  style={{ background: "#ef4444" }}
                />
              )}
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

        {/* End Ride button (visible only while trip is running) */}
        <AnimatePresence>
          {isRunning && (
            <motion.div
              initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
              className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1000]">
              <button
                onClick={handleEndRide}
                className="flex items-center gap-2.5 px-8 py-3.5 rounded-2xl font-semibold text-white text-sm shadow-2xl"
                style={{ background: "linear-gradient(135deg,#dc2626,#991b1b)", boxShadow: "0 0 24px rgba(220,38,38,0.5)" }}>
                <Square className="w-4 h-4 fill-white" />
                End Ride
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Booking Panel (bottom-sheet, hidden during active trip) ── */}
        <AnimatePresence>
          {!isRunning && (
            <motion.div
              key={bookingStep}
              initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
              transition={{ type: "spring", damping: 28, stiffness: 260 }}
              className="absolute bottom-0 left-0 right-0 z-[1010] rounded-t-3xl overflow-hidden"
              style={{ background: "rgba(10,10,15,0.97)", backdropFilter: "blur(24px)", borderTop: "1px solid rgba(255,255,255,0.08)" }}>

              {/* Drag handle */}
              <div className="flex justify-center pt-3 pb-1">
                <div className="w-9 h-1 rounded-full bg-white/15" />
              </div>

              {/* ── STEP: select ── */}
              {bookingStep === "select" && (
                <div>
                  <div className="px-5 pt-2 pb-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-white font-bold text-base">Choose a ride</h3>
                        <p className="text-[#A1A1AA] text-xs mt-0.5">Select vehicle type to continue</p>
                      </div>
                      <Car className="w-5 h-5 text-[#7C3AED]" />
                    </div>
                  </div>

                  {/* Vehicle cards 2×2 */}
                  <div className="px-4 grid grid-cols-2 gap-2.5">
                    {vehicleOptions.map(v => (
                      <motion.button
                        key={v.id}
                        onClick={() => setSelectedVehicle(v)}
                        whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
                        className={`relative p-3.5 rounded-2xl text-left transition-all ${
                          selectedVehicle?.id === v.id
                            ? "border-2 border-[#7C3AED]"
                            : "border border-white/10 hover:border-white/20"
                        }`}
                        style={
                          selectedVehicle?.id === v.id
                            ? { background: "rgba(124,58,237,0.15)", boxShadow: "0 0 22px rgba(124,58,237,0.3)" }
                            : { background: "rgba(255,255,255,0.04)" }
                        }>
                        {/* Checkmark badge */}
                        <AnimatePresence>
                          {selectedVehicle?.id === v.id && (
                            <motion.div
                              initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}
                              className="absolute top-2.5 right-2.5 w-4 h-4 rounded-full bg-[#7C3AED] flex items-center justify-center">
                              <span className="text-[9px] text-white font-bold">✓</span>
                            </motion.div>
                          )}
                        </AnimatePresence>

                        {v.img
                          ? <img
                              src={v.img} alt={v.name}
                              className="h-12 w-auto object-contain mb-1"
                              style={{
                                maskImage: "radial-gradient(ellipse 88% 82% at 52% 52%, black 38%, transparent 82%)",
                                WebkitMaskImage: "radial-gradient(ellipse 88% 82% at 52% 52%, black 38%, transparent 82%)",
                                filter: v.id === "suv"
                                  ? "drop-shadow(0 2px 8px rgba(220,38,38,0.5)) brightness(1.1)"
                                  : v.id === "premium"
                                  ? "drop-shadow(0 2px 8px rgba(124,58,237,0.5)) brightness(1.05)"
                                  : v.id === "mini"
                                  ? "drop-shadow(0 2px 6px rgba(180,50,50,0.4)) brightness(1.1) saturate(1.2)"
                                  : "drop-shadow(0 2px 6px rgba(37,99,235,0.4)) brightness(1.05)",
                              }}
                            />
                          : <div className="text-2xl mb-2">{v.icon}</div>
                        }
                        <div className="text-white font-bold text-sm">{v.name}</div>
                        <div className="text-[#7C3AED] font-bold text-sm">₹{v.fare}</div>

                        <div className="mt-2 flex flex-col gap-1">
                          <div className="flex items-center gap-1 text-[#A1A1AA] text-[10px]">
                            <Clock className="w-2.5 h-2.5 flex-shrink-0" />
                            {v.eta} min away
                          </div>
                          <div className="flex items-center gap-1 text-[10px]">
                            <Shield className="w-2.5 h-2.5 flex-shrink-0 text-emerald-400" />
                            <span className="text-emerald-400">{v.safetyScore}% safe</span>
                          </div>
                          <div className="text-[9px] text-[#52525B] truncate">{v.model}</div>
                        </div>
                      </motion.button>
                    ))}
                  </div>

                  {/* Confirm button */}
                  <div className="px-4 pt-3 pb-6">
                    <motion.button
                      onClick={handleConfirmRide}
                      disabled={!selectedVehicle}
                      whileHover={selectedVehicle ? { scale: 1.01 } : {}}
                      whileTap={selectedVehicle ? { scale: 0.98 } : {}}
                      className={`w-full py-3.5 rounded-2xl font-bold text-sm transition-all ${
                        selectedVehicle
                          ? "text-white"
                          : "bg-white/5 border border-white/10 text-[#52525B] cursor-not-allowed"
                      }`}
                      style={selectedVehicle ? {
                        background: "linear-gradient(135deg,#7C3AED,#2563EB)",
                        boxShadow: "0 0 28px rgba(124,58,237,0.45)",
                      } : {}}>
                      {selectedVehicle
                        ? `Confirm ${selectedVehicle.name} — ₹${selectedVehicle.fare}`
                        : "Select a vehicle to continue"}
                    </motion.button>
                  </div>
                </div>
              )}

              {/* ── STEP: assigning ── */}
              {bookingStep === "assigning" && (
                <div className="flex flex-col items-center py-10 gap-4 px-5">
                  <div className="relative">
                    <motion.div
                      animate={{ rotate: 360 }}
                      transition={{ repeat: Infinity, duration: 2.2, ease: "linear" }}
                      className="w-20 h-20 rounded-full"
                      style={{ border: "3px solid rgba(124,58,237,0.2)", borderTop: "3px solid #7C3AED" }}
                    />
                    <div className="absolute inset-0 flex items-center justify-center">
                      {selectedVehicle?.img
                        ? <img
                            src={selectedVehicle.img} alt={selectedVehicle.name}
                            className="h-9 w-auto object-contain"
                            style={{
                              maskImage: "radial-gradient(ellipse 88% 82% at 52% 52%, black 38%, transparent 82%)",
                              WebkitMaskImage: "radial-gradient(ellipse 88% 82% at 52% 52%, black 38%, transparent 82%)",
                              filter: selectedVehicle.id === "suv"
                                ? "drop-shadow(0 2px 8px rgba(220,38,38,0.5)) brightness(1.1)"
                                : selectedVehicle.id === "premium"
                                ? "drop-shadow(0 2px 8px rgba(124,58,237,0.5)) brightness(1.05)"
                                : selectedVehicle.id === "mini"
                                ? "drop-shadow(0 2px 6px rgba(180,50,50,0.4)) brightness(1.1) saturate(1.2)"
                                : "drop-shadow(0 2px 6px rgba(37,99,235,0.4)) brightness(1.05)",
                            }}
                          />
                        : <span className="text-2xl">{selectedVehicle?.icon}</span>
                      }
                    </div>
                  </div>

                  <div className="text-center">
                    <div className="text-white font-bold text-lg">Finding your driver…</div>
                    <div className="text-[#A1A1AA] text-sm mt-1">
                      Matching with nearest {selectedVehicle?.name}
                    </div>
                  </div>

                  <div className="flex items-end gap-1.5">
                    <motion.span
                      key={etaCountdown}
                      initial={{ opacity: 0, scale: 1.4 }} animate={{ opacity: 1, scale: 1 }}
                      className="text-5xl font-black text-white tabular-nums">
                      {etaCountdown}
                    </motion.span>
                    <span className="text-[#A1A1AA] text-sm pb-2">sec</span>
                  </div>

                  {/* Pulse dots */}
                  <div className="flex gap-2">
                    {[0, 1, 2].map(i => (
                      <motion.div key={i}
                        animate={{ opacity: [0.2, 1, 0.2], scale: [0.8, 1, 0.8] }}
                        transition={{ repeat: Infinity, duration: 1.2, delay: i * 0.4 }}
                        className="w-2 h-2 rounded-full bg-[#7C3AED]" />
                    ))}
                  </div>
                  <div className="pb-2" />
                </div>
              )}

              {/* ── STEP: assigned ── */}
              {bookingStep === "assigned" && driverDetails && (
                <div className="px-5 pt-3 pb-6">
                  {/* Title */}
                  <div className="flex items-center gap-2 mb-4">
                    <motion.div
                      initial={{ scale: 0 }} animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 260, damping: 18 }}>
                      <UserCheck className="w-5 h-5 text-emerald-400" />
                    </motion.div>
                    <span className="text-emerald-400 font-bold text-sm">Driver Assigned</span>
                  </div>

                  {/* Driver card */}
                  <div className="flex items-center gap-3 p-3.5 rounded-2xl mb-3"
                    style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)" }}>
                    {/* Avatar */}
                    <div className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-base flex-shrink-0"
                      style={{ background: "linear-gradient(135deg,#7C3AED,#2563EB)" }}>
                      {driverDetails.initials}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-white font-bold text-sm">{driverDetails.name}</div>
                      <div className="flex items-center gap-1 mt-0.5">
                        <Star className="w-3 h-3 text-yellow-400 fill-yellow-400 flex-shrink-0" />
                        <span className="text-yellow-400 text-xs font-semibold">{driverDetails.rating}</span>
                        <span className="text-[#52525B] text-xs">·</span>
                        <span className="text-[#A1A1AA] text-xs truncate">{driverDetails.vehicleNumber}</span>
                      </div>
                      <div className="text-[#52525B] text-[10px] mt-0.5 truncate">{driverDetails.model}</div>
                    </div>
                    <div className="flex-shrink-0">
                      {selectedVehicle?.img
                        ? <img
                            src={selectedVehicle.img} alt={selectedVehicle.name}
                            className="h-9 w-auto object-contain"
                            style={{
                              maskImage: "radial-gradient(ellipse 88% 82% at 52% 52%, black 38%, transparent 82%)",
                              WebkitMaskImage: "radial-gradient(ellipse 88% 82% at 52% 52%, black 38%, transparent 82%)",
                              filter: selectedVehicle.id === "suv"
                                ? "drop-shadow(0 2px 8px rgba(220,38,38,0.5)) brightness(1.1)"
                                : selectedVehicle.id === "premium"
                                ? "drop-shadow(0 2px 8px rgba(124,58,237,0.5)) brightness(1.05)"
                                : selectedVehicle.id === "mini"
                                ? "drop-shadow(0 2px 6px rgba(180,50,50,0.4)) brightness(1.1) saturate(1.2)"
                                : "drop-shadow(0 2px 6px rgba(37,99,235,0.4)) brightness(1.05)",
                            }}
                          />
                        : <span className="text-2xl">{selectedVehicle?.icon}</span>
                      }
                    </div>
                  </div>

                  {/* ETA banner */}
                  <div className="flex items-center gap-2 p-3 rounded-xl mb-4"
                    style={{ background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.25)" }}>
                    <motion.div animate={{ opacity: [0.4, 1, 0.4] }} transition={{ repeat: Infinity, duration: 1.5 }}
                      className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0" />
                    <Clock className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                    <span className="text-emerald-400 text-xs font-semibold">
                      Arriving in {selectedVehicle?.eta} min · ₹{selectedVehicle?.fare}
                    </span>
                  </div>

                  {/* Start Ride */}
                  <motion.button
                    onClick={handleStartRide}
                    disabled={startingRide}
                    whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }}
                    className="w-full py-3.5 rounded-2xl font-bold text-white text-sm disabled:opacity-60 flex items-center justify-center gap-2"
                    style={{
                      background: simMode ? "linear-gradient(135deg,#2563EB,#1d4ed8)" : "linear-gradient(135deg,#7C3AED,#2563EB)",
                      boxShadow: "0 0 28px rgba(124,58,237,0.45)",
                    }}>
                    {startingRide
                      ? <><Loader2 className="w-4 h-4 animate-spin" /> Starting…</>
                      : <><Play className="w-4 h-4 fill-white" />{simMode ? "Start Sim Ride" : "Start Ride"}</>
                    }
                  </motion.button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

      </div>
    </div>
  )
}
