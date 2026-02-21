import { useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import { getSocket, releaseSocket } from "../lib/socket"
import type { PoliceAlertPayload } from "../lib/socket"
import type { PoliceStation, CabState } from "../lib/geo"
import { verifyPayload } from "../lib/crypto"
import { ShieldCheck, ShieldX, ShieldAlert } from "lucide-react"

const INITIAL_CENTER: [number, number] = [12.9716, 77.5946]
const INITIAL_ZOOM = 11

type VerifyStatus = "pending" | "verified" | "invalid" | "unsigned" | null

export default function PoliceDashboard() {
  // ── Map refs ──────────────────────────────────────────────────────────────
  const mapRef            = useRef<L.Map | null>(null)
  const mapContainerRef   = useRef<HTMLDivElement>(null)
  const stationLayerRef   = useRef<L.LayerGroup>(new L.LayerGroup())
  const rangeLayerRef     = useRef<L.LayerGroup>(new L.LayerGroup())
  const cabLayerRef       = useRef<L.LayerGroup>(new L.LayerGroup())
  const alertLayerRef     = useRef<L.LayerGroup>(new L.LayerGroup())
  const scanCircleRef     = useRef<L.Circle | null>(null)
  const gridLayerRef      = useRef<L.LayerGroup>(new L.LayerGroup())

  // ── State ─────────────────────────────────────────────────────────────────
  const [stations,         setStations]         = useState<PoliceStation[]>([])
  const [selectedStation,  setSelectedStation]  = useState<string>("")
  const [cabs,             setCabs]             = useState<Map<string, CabState & { cabId: string }>>(new Map())
  const [isScanning,       setIsScanning]       = useState(true)
  const [alerts,           setAlerts]           = useState<PoliceAlertPayload[]>([])
  const [selectedAlert,    setSelectedAlert]    = useState<PoliceAlertPayload | null>(null)
  const [verifyStatus,     setVerifyStatus]     = useState<VerifyStatus>(null)
  const [clockStr,         setClockStr]         = useState(new Date().toLocaleString())

  // Live clock
  useEffect(() => {
    const id = setInterval(() => setClockStr(new Date().toLocaleString()), 1000)
    return () => clearInterval(id)
  }, [])

  // ── Fetch police stations ─────────────────────────────────────────────────
  useEffect(() => {
    fetch("http://localhost:4000/api/stations")
      .then(r => r.json())
      .then((data: PoliceStation[]) => {
        setStations(data)
        if (data.length > 0) setSelectedStation(data[0].id)
      })
      .catch(console.error)
  }, [])

  // ── Initialise Leaflet map ────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return

    const map = L.map(mapContainerRef.current, {
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
    })

    // OpenStreetMap tiles (matches the tactical portal screenshot)
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "",
      maxZoom: 19,
    }).addTo(map)

    // Custom pane z-ordering
    const panes: [string, string][] = [
      ["grid", "400"], ["ranges", "500"], ["stations", "600"],
      ["cabs", "700"], ["scanning", "800"], ["alerts", "900"],
    ]
    panes.forEach(([name, z]) => {
      map.createPane(name)
      map.getPane(name)!.style.zIndex = z
    })

    stationLayerRef.current.addTo(map)
    rangeLayerRef.current.addTo(map)
    cabLayerRef.current.addTo(map)
    alertLayerRef.current.addTo(map)
    gridLayerRef.current.addTo(map)

    mapRef.current = map

    // ── Green tactical grid ──────────────────────────────────────────────
    const drawGrid = () => {
      if (!mapRef.current) return
      gridLayerRef.current.clearLayers()
      const bounds = mapRef.current.getBounds()
      const zoom   = mapRef.current.getZoom()
      const gs     = Math.max(0.01, 0.1 / Math.pow(2, zoom - 10))
      const latS = Math.floor(bounds.getSouth() / gs) * gs
      const latN = Math.ceil(bounds.getNorth()  / gs) * gs
      const lngW = Math.floor(bounds.getWest()  / gs) * gs
      const lngE = Math.ceil(bounds.getEast()   / gs) * gs
      const lineOpts = { color: "#00ff00", weight: 0.5, opacity: 0.18, pane: "grid" }
      for (let lng = lngW; lng <= lngE; lng += gs)
        gridLayerRef.current.addLayer(L.polyline([[latS, lng], [latN, lng]], lineOpts))
      for (let lat = latS; lat <= latN; lat += gs)
        gridLayerRef.current.addLayer(L.polyline([[lat, lngW], [lat, lngE]], lineOpts))
    }
    map.on("moveend", drawGrid)
    map.on("zoomend", drawGrid)
    drawGrid()

    return () => { map.remove(); mapRef.current = null }
  }, [])

  // ── Draw station markers + range circles ─────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || stations.length === 0) return

    stationLayerRef.current.clearLayers()
    rangeLayerRef.current.clearLayers()

    const group = new L.FeatureGroup()
    stations.forEach(s => {
      // Marker
      const m = L.circleMarker([s.lat, s.lon], {
        radius: 8, fillColor: "#00ff00", color: "#ffffff",
        weight: 2, opacity: 1, fillOpacity: 0.8, pane: "stations",
      }).bindTooltip(s.name, { className: "ps-tooltip", direction: "top" })
      stationLayerRef.current.addLayer(m)
      group.addLayer(L.circleMarker([s.lat, s.lon], { radius: 1 }))

      // Subtle 2 km range for all
      rangeLayerRef.current.addLayer(L.circle([s.lat, s.lon], {
        radius: 2000, fillColor: "#00ff00", color: "#00ff00",
        weight: 1, opacity: 0.25, fillOpacity: 0.05, pane: "ranges",
      }))

      // Bold ring for selected
      if (s.id === selectedStation) {
        rangeLayerRef.current.addLayer(L.circle([s.lat, s.lon], {
          radius: 2000, fillColor: "#00ff00", color: "#00ff00",
          weight: 2, opacity: 0.6, fillOpacity: 0.11, pane: "ranges",
        }))
      }
    })
    try { mapRef.current.fitBounds(group.getBounds(), { padding: [20, 20] }) } catch {}
  }, [stations, selectedStation])

  // ── Scanning pulse animation ──────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !selectedStation || !isScanning) return
    const st = stations.find(s => s.id === selectedStation)
    if (!st) return

    let raf: number
    const t0 = Date.now()
    const tick = () => {
      const p  = ((Date.now() - t0) % 3000) / 3000
      const r  = 50 + p * 1950
      if (scanCircleRef.current) map.removeLayer(scanCircleRef.current)
      scanCircleRef.current = L.circle([st.lat, st.lon], {
        radius: r, fillColor: "transparent",
        color: "#00ff00", weight: 2, opacity: 0.8 - p * 0.6, fillOpacity: 0, pane: "scanning",
      })
      scanCircleRef.current.addTo(map)
      if (isScanning) raf = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      cancelAnimationFrame(raf)
      if (scanCircleRef.current && mapRef.current) mapRef.current.removeLayer(scanCircleRef.current)
    }
  }, [selectedStation, stations, isScanning])

  // ── Socket events (combined: emergency + cab tracking) ───────────────────
  useEffect(() => {
    const socket = getSocket()

    // Our emergency channel
    const onAlert = (data: PoliceAlertPayload) => {
      setAlerts(prev => [data, ...prev.slice(0, 49)])
      if (mapRef.current) {
        const { lat, lng } = data.payload.location
        L.circleMarker([lat, lng], {
          radius: 14, fillColor: "#ff0000", color: "#ff0000",
          weight: 2, fillOpacity: 0.55, pane: "alerts",
        })
          .bindTooltip(`⚠ ${data.payload.tripId}`, { className: "alert-tooltip" })
          .addTo(alertLayerRef.current)
      }
    }
    const onHistory = (history: PoliceAlertPayload[]) => setAlerts([...history].reverse())

    // Friend's cab channel
    const onStationCabs = (list: Array<CabState & { cabId: string }>) => {
      setCabs(new Map(list.map(c => [c.cabId ?? c.id, { ...c, cabId: c.cabId ?? c.id }])))
    }
    const onCabUpdate = (cab: CabState & { cabId: string }) => {
      setCabs(prev => new Map(prev.set(cab.cabId, cab)))
    }
    const onCabLeft = (cabId: string) => {
      setCabs(prev => { const m = new Map(prev); m.delete(cabId); return m })
    }

    socket.on("POLICE_ALERT",   onAlert)
    socket.on("ALERT_HISTORY",  onHistory)
    socket.on("station_cabs",   onStationCabs)
    socket.on("cab_update",     onCabUpdate)
    socket.on("cab_left",       onCabLeft)

    return () => {
      socket.off("POLICE_ALERT",  onAlert)
      socket.off("ALERT_HISTORY", onHistory)
      socket.off("station_cabs",  onStationCabs)
      socket.off("cab_update",    onCabUpdate)
      socket.off("cab_left",      onCabLeft)
      releaseSocket()
    }
  }, [])

  // Join station room when selection changes
  useEffect(() => {
    if (selectedStation) getSocket().emit("join_station", selectedStation)
  }, [selectedStation])

  // ── Cab marker rendering ──────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current) return
    cabLayerRef.current.clearLayers()
    cabs.forEach(cab => {
      const icon = L.divIcon({
        html: `<div class="cab-marker-wrap">
          <div class="cab-icon">🚕</div>
          <div class="cab-label">${cab.cabId}</div>
        </div>`,
        className: "custom-cab-marker",
        iconSize: [40, 40],
        iconAnchor: [20, 20],
      })
      L.marker([cab.lat, cab.lon], { icon, pane: "cabs" }).addTo(cabLayerRef.current)
    })
  }, [cabs])

  // ── Simulate cab movement for demo ───────────────────────────────────────
  useEffect(() => {
    if (stations.length === 0) return
    const id = setInterval(() => {
      const st = stations.find(s => s.id === selectedStation) ?? stations[0]
      const angle = Math.random() * 2 * Math.PI
      const dist  = Math.random() * 0.018
      getSocket().emit("cab_position", {
        cabId: "cab_demo",
        lat: st.lat + dist * Math.cos(angle),
        lon: st.lon + dist * Math.sin(angle),
      })
    }, 2500)
    return () => clearInterval(id)
  }, [selectedStation, stations])

  // ── Verify selected alert ─────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedAlert) { setVerifyStatus(null); return }
    if (!selectedAlert.publicKey || !selectedAlert.signature) { setVerifyStatus("unsigned"); return }
    setVerifyStatus("pending")
    verifyPayload(selectedAlert.publicKey, selectedAlert.payload, selectedAlert.signature)
      .then(ok => setVerifyStatus(ok ? "verified" : "invalid"))
      .catch(() => setVerifyStatus("invalid"))
  }, [selectedAlert])

  // ── Derived values ────────────────────────────────────────────────────────
  const stationsByArea = stations.reduce<Record<string, PoliceStation[]>>((acc, s) => {
    const area = s.area ?? "General"
    ;(acc[area] ??= []).push(s)
    return acc
  }, {})
  const cabArray   = Array.from(cabs.values())
  const activeCabs = cabArray.filter(c => c.insideRadius).length

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-900 text-green-400 font-mono select-none">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="bg-black border-b border-green-500 px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-widest text-green-400">
            ▸ SAHAYAK POLICE PORTAL
          </h1>
          <p className="text-green-600 text-xs tracking-wider">
            TACTICAL COMMAND &amp; CONTROL SYSTEM
          </p>
        </div>
        <div className="flex items-center gap-6">
          <span className="text-green-500 text-xs">{clockStr}</span>
          <Link to="/" className="text-green-500 hover:text-green-300 border border-green-700 hover:border-green-400 px-3 py-1 text-xs rounded transition-colors">
            ← HOME
          </Link>
        </div>
      </div>

      <div className="flex h-[calc(100vh-56px)]">

        {/* ── Sidebar ──────────────────────────────────────────────────── */}
        <div className="w-72 bg-[#0a0f0a] border-r border-green-800 p-3 overflow-y-auto space-y-3 flex-shrink-0">

          {/* Station selector */}
          <div className="border border-green-700 rounded p-3">
            <p className="text-green-500 text-xs font-bold tracking-widest mb-2">▸ COMMAND STATION</p>
            <select
              value={selectedStation}
              onChange={e => setSelectedStation(e.target.value)}
              className="w-full bg-black border border-green-600 text-green-300 text-xs p-2 rounded focus:outline-none focus:border-green-400"
            >
              {Object.entries(stationsByArea).map(([area, list]) => (
                <optgroup key={area} label={area}>
                  {list.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {/* Operational status */}
          <div className="border border-green-700 rounded p-3">
            <p className="text-green-500 text-xs font-bold tracking-widest mb-2">▸ OPERATIONAL STATUS</p>
            <div className="space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-green-600">Stations</span>
                <span className="text-green-300">{stations.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-green-600">Active Cabs</span>
                <span className="text-green-300">{activeCabs}/{cabArray.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-green-600">Scan</span>
                <span className={isScanning ? "text-green-400" : "text-yellow-400"}>
                  {isScanning ? "● SCANNING" : "○ SILENT"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-green-600">Emergencies</span>
                <span className={alerts.length > 0 ? "text-red-400" : "text-green-400"}>
                  {alerts.length > 0 ? `⚠ ${alerts.length}` : "NONE"}
                </span>
              </div>
            </div>
          </div>

          {/* Controls */}
          <button
            onClick={() => setIsScanning(v => !v)}
            className={`w-full py-2 text-xs font-bold rounded border transition-colors ${
              isScanning
                ? "bg-green-700 hover:bg-green-600 border-green-500 text-black"
                : "bg-transparent hover:bg-green-900 border-green-700 text-green-400"
            }`}
          >
            {isScanning ? "DISABLE SCAN" : "ENABLE SCAN"}
          </button>

          {/* Active units */}
          <div className="border border-green-700 rounded p-3">
            <p className="text-green-500 text-xs font-bold tracking-widest mb-2">▸ ACTIVE UNITS</p>
            <div className="space-y-1 max-h-28 overflow-y-auto">
              {cabArray.length === 0 ? (
                <p className="text-green-700 text-xs">No units detected</p>
              ) : (
                cabArray.map(cab => (
                  <div key={cab.cabId} className="flex justify-between text-xs">
                    <span className="text-green-400">{cab.cabId}</span>
                    <span className={cab.insideRadius ? "text-green-300" : "text-yellow-400"}>
                      {cab.insideRadius ? "IN RANGE" : "OUT OF RANGE"}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Emergency alerts */}
          <div className="border border-red-800 rounded p-3">
            <p className="text-red-400 text-xs font-bold tracking-widest mb-2">▸ EMERGENCY ALERTS</p>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {alerts.length === 0 ? (
                <p className="text-green-700 text-xs">No alerts received</p>
              ) : (
                alerts.map((a, i) => (
                  <button
                    key={i}
                    onClick={() => setSelectedAlert(prev => prev === a ? null : a)}
                    className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors ${
                      selectedAlert === a
                        ? "bg-red-900/60 border border-red-500"
                        : "bg-red-950/30 hover:bg-red-900/40 border border-red-900"
                    }`}
                  >
                    <div className="text-red-300 font-bold truncate">{a.payload?.tripId ?? "UNKNOWN"}</div>
                    <div className="text-red-500 text-[10px]">
                      {a.payload?.location
                        ? `${a.payload.location.lat.toFixed(4)}, ${a.payload.location.lng.toFixed(4)}`
                        : "—"}
                    </div>
                  </button>
                ))
              )}
            </div>

            {/* Verification badge */}
            {selectedAlert && (
              <div className="mt-2 pt-2 border-t border-red-800 text-xs">
                {verifyStatus === "pending" && (
                  <span className="text-yellow-400">⏳ Verifying…</span>
                )}
                {verifyStatus === "verified" && (
                  <span className="text-green-400 flex items-center gap-1">
                    <ShieldCheck className="w-3 h-3" /> SIGNATURE VALID
                  </span>
                )}
                {verifyStatus === "invalid" && (
                  <span className="text-red-400 flex items-center gap-1">
                    <ShieldX className="w-3 h-3" /> SIGNATURE INVALID
                  </span>
                )}
                {verifyStatus === "unsigned" && (
                  <span className="text-yellow-500 flex items-center gap-1">
                    <ShieldAlert className="w-3 h-3" /> UNSIGNED PACKET
                  </span>
                )}
                {selectedAlert.payload && (
                  <div className="mt-1 text-[10px] text-red-400 space-y-0.5">
                    <div>TRIP: {selectedAlert.payload.tripId}</div>
                    <div>SEV:  {selectedAlert.payload.severity}</div>
                    <div>TIME: {new Date(selectedAlert.payload.timestamp).toLocaleTimeString()}</div>
                  </div>
                )}
              </div>
            )}
          </div>

        </div>

        {/* ── Map ──────────────────────────────────────────────────────── */}
        <div className="flex-1 relative">
          <div ref={mapContainerRef} className="w-full h-full" />

          {/* Overlay info */}
          <div className="absolute top-3 right-3 bg-black/80 border border-green-700 rounded p-2 text-green-400 text-xs z-[999] space-y-0.5">
            <div>GRID  <span className="text-green-300">ACTIVE</span></div>
            <div>RANGE <span className="text-green-300">2 KM</span></div>
            <div>MODE  <span className="text-green-300">TACTICAL</span></div>
          </div>

          {/* Legend */}
          <div className="absolute bottom-3 right-3 bg-black/80 border border-green-700 rounded p-2 text-[10px] z-[999] space-y-1">
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-3 rounded-full bg-green-400 border border-white" />
              <span className="text-green-400">Police Station</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-3 rounded-full bg-red-500" />
              <span className="text-red-400">Emergency Alert</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-lg leading-3">🚕</span>
              <span className="text-green-400">Active Cab</span>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .ps-tooltip {
          background: rgba(0,0,0,0.85) !important;
          border: 1px solid #00ff00 !important;
          color: #00ff00 !important;
          font-family: monospace !important;
          font-size: 11px !important;
          padding: 3px 7px !important;
        }
        .alert-tooltip {
          background: rgba(0,0,0,0.85) !important;
          border: 1px solid #ff0000 !important;
          color: #ff4444 !important;
          font-family: monospace !important;
          font-size: 11px !important;
        }
        .custom-cab-marker {
          background: transparent !important;
          border: none !important;
        }
        .cab-marker-wrap {
          text-align: center;
          color: #00ff00;
          font-family: monospace;
          font-weight: bold;
        }
        .cab-icon { font-size: 18px; margin-bottom: 1px; }
        .cab-label {
          background: rgba(0,0,0,0.85);
          border: 1px solid #00ff00;
          border-radius: 3px;
          padding: 1px 4px;
          font-size: 9px;
          white-space: nowrap;
        }
      `}</style>
    </div>
  )
}
