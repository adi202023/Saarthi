import { useEffect, useRef, useState } from "react"
import { Link, useLocation } from "react-router-dom"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import { getSocket, releaseSocket } from "../lib/socket"
import type { PoliceAlertPayload } from "../lib/socket"
import type { PoliceStation, CabState } from "../lib/geo"
import { verifyPayload } from "../lib/crypto"
import { ShieldCheck, ShieldX, ShieldAlert } from "lucide-react"

const INITIAL_CENTER: [number, number] = [12.9716, 77.5946]
const INITIAL_ZOOM = 11

const API_BASE = "http://localhost:4000"

type VerifyStatus = "pending" | "verified" | "invalid" | "unsigned" | null

export default function PoliceDashboard() {
  const mapRef            = useRef<L.Map | null>(null)
  const mapContainerRef   = useRef<HTMLDivElement>(null)
  const stationLayerRef   = useRef<L.LayerGroup>(new L.LayerGroup())
  const rangeLayerRef     = useRef<L.LayerGroup>(new L.LayerGroup())
  const cabLayerRef       = useRef<L.LayerGroup>(new L.LayerGroup())
  const alertLayerRef     = useRef<L.LayerGroup>(new L.LayerGroup())
  const scanCircleRef     = useRef<L.Circle | null>(null)
  const gridLayerRef      = useRef<L.LayerGroup>(new L.LayerGroup())
  const destMarkersRef    = useRef<Map<string, L.CircleMarker>>(new Map())
  const sourceMarkersRef  = useRef<Map<string, L.CircleMarker>>(new Map())
  const routePolylinesRef = useRef<Map<string, L.Polyline>>(new Map())
  const stationCabLinesRef = useRef<Map<string, L.Polyline>>(new Map())
  const hasInitialFitRef   = useRef(false)
  const stationsRef        = useRef<PoliceStation[]>([])

  const loc = useLocation()
  const isVisible = loc.pathname === "/police"

  const [stations,         setStations]         = useState<PoliceStation[]>([])
  const [selectedStation,  setSelectedStation]  = useState<string>("")
  const [cabs,             setCabs]             = useState<Map<string, CabState & { cabId: string }>>(new Map())
  const [isScanning,       setIsScanning]       = useState(true)
  const [alerts,           setAlerts]           = useState<PoliceAlertPayload[]>([])
  const [selectedAlert,    setSelectedAlert]    = useState<PoliceAlertPayload | null>(null)
  const [verifyStatus,     setVerifyStatus]     = useState<VerifyStatus>(null)
  const [clockStr,         setClockStr]         = useState(new Date().toLocaleString())
  const [traceChains,      setTraceChains]      = useState<Map<string, { stationId: string; stationName: string; timestamp: number }[]>>(new Map())
  const [predictedIncoming, setPredictedIncoming] = useState<Array<{ cabId: string; stationName: string; type: string }>>([])
  const [alertCabs,        setAlertCabs]        = useState<Set<string>>(new Set())
  const [selectedCabForTrace, setSelectedCabForTrace] = useState<string | null>(null)

  useEffect(() => {
    const id = setInterval(() => setClockStr(new Date().toLocaleString()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    stationsRef.current = stations
  }, [stations])

  useEffect(() => {
    fetch(`${API_BASE}/api/stations`)
      .then(r => r.json())
      .then((data: PoliceStation[]) => {
        setStations(data)
        if (data.length > 0) setSelectedStation(data[0].id)
      })
      .catch(console.error)
  }, [])

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return
    const map = L.map(mapContainerRef.current, {
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
    })

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "",
      maxZoom: 19,
    }).addTo(map)

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
      const lineOpts = { color: "#999999", weight: 1, opacity: 0.35, pane: "grid" }
      for (let lng = lngW; lng <= lngE; lng += gs)
        gridLayerRef.current.addLayer(L.polyline([[latS, lng], [latN, lng]], lineOpts))
      for (let lat = latS; lat <= latN; lat += gs)
        gridLayerRef.current.addLayer(L.polyline([[lat, lngW], [lat, lngE]], lineOpts))
    }
    map.on("moveend", drawGrid)
    map.on("zoomend", drawGrid)
    drawGrid()

    const container = mapContainerRef.current
    const doInvalidateAndFit = () => {
      map.invalidateSize()
      if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) return
      if (hasInitialFitRef.current) return
      const st = stationsRef.current
      if (st.length === 0) return
      const group = new L.FeatureGroup()
      st.forEach(s => group.addLayer(L.circle([s.lat, s.lon], { radius: 2000 })))
      try {
        hasInitialFitRef.current = true
        map.fitBounds(group.getBounds(), { padding: [40, 40], maxZoom: 12 })
      } catch {}
    }
    const ro = container ? new ResizeObserver(doInvalidateAndFit) : null
    if (container) ro?.observe(container)
    window.addEventListener("resize", doInvalidateAndFit)
    const t = setTimeout(doInvalidateAndFit, 150)

    return () => {
      ro?.disconnect()
      window.removeEventListener("resize", doInvalidateAndFit)
      clearTimeout(t)
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!mapRef.current || stations.length === 0) return
    stationLayerRef.current.clearLayers()
    rangeLayerRef.current.clearLayers()

    const group = new L.FeatureGroup()
    stations.forEach(s => {
      const m = L.circleMarker([s.lat, s.lon], {
        radius: 8, fillColor: "#00ff00", color: "#ffffff",
        weight: 2, opacity: 1, fillOpacity: 0.8, pane: "stations",
      }).bindTooltip(s.name, { className: "ps-tooltip", direction: "top" })
      stationLayerRef.current.addLayer(m)
      group.addLayer(L.circleMarker([s.lat, s.lon], { radius: 1 }))

      rangeLayerRef.current.addLayer(L.circle([s.lat, s.lon], {
        radius: 2000, fillColor: "#00ff00", color: "#00ff00",
        weight: 1, opacity: 0.25, fillOpacity: 0.05, pane: "ranges",
      }))

      if (s.id === selectedStation) {
        rangeLayerRef.current.addLayer(L.circle([s.lat, s.lon], {
          radius: 2000, fillColor: "#00ff00", color: "#00ff00",
          weight: 2, opacity: 0.6, fillOpacity: 0.11, pane: "ranges",
        }))
      }
    })
    const container = mapContainerRef.current
    const hasSize = container && container.offsetWidth > 0 && container.offsetHeight > 0
    if (!hasInitialFitRef.current && hasSize) {
      hasInitialFitRef.current = true
      try { mapRef.current!.fitBounds(group.getBounds(), { padding: [40, 40], maxZoom: 12 }) } catch {}
    }
  }, [stations, selectedStation])

  // Invalidate map size when becoming visible (navigating from Cab to Police)
  useEffect(() => {
    if (!isVisible) return
    const map = mapRef.current
    if (!map) return
    const run = () => {
      map.invalidateSize()
      map.invalidateSize()
    }
    const t1 = setTimeout(run, 50)
    const t2 = setTimeout(run, 200)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [isVisible])

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

  useEffect(() => {
    const sock = getSocket()

    const onAlert = (data: PoliceAlertPayload) => {
      setAlerts(prev => [data, ...prev.slice(0, 49)])
      if (mapRef.current && data.payload?.location) {
        const { lat, lng } = data.payload.location
        L.circleMarker([lat, lng], {
          radius: 14, fillColor: "#ff0000", color: "#ff0000",
          weight: 2, fillOpacity: 0.55, pane: "alerts",
        })
          .bindTooltip(`⚠ ${data.payload?.tripId ?? "ALERT"}`, { className: "alert-tooltip" })
          .addTo(alertLayerRef.current)
      }
    }
    const onHistory = (history: PoliceAlertPayload[]) => setAlerts([...history].reverse())

    const onStationCabs = (list: Array<CabState & { cabId: string }>) => {
      setCabs(new Map(list.map(c => [c.cabId ?? c.id, { ...c, cabId: c.cabId ?? c.id }])))
    }
    const onCabUpdate = (cab: CabState & { cabId: string }) => {
      setCabs(prev => new Map(prev.set(cab.cabId, cab)))
    }
    const onCabLeft = (cabId: string) => {
      setCabs(prev => { const m = new Map(prev); m.delete(cabId); return m })
    }
    const onTraceChain = ({ cabId, chain }: { cabId: string; chain: { stationId: string; stationName: string; timestamp: number }[] }) => {
      setTraceChains(prev => new Map(prev.set(cabId, chain)))
    }
    const onPredicted = (data: CabState & { cabId: string; type: string; predictedNextStationName?: string; stationName?: string }) => {
      const stationName = data.type === "PREDICTED"
        ? (data.predictedNextStationName || "Unknown")
        : (data.stationName || "Unknown")
      setPredictedIncoming(prev => [...prev.filter(p => !(p.cabId === data.cabId && p.stationName === stationName)), { cabId: data.cabId, stationName, type: data.type }])
      setTimeout(() => setPredictedIncoming(prev => prev.filter(p => !(p.cabId === data.cabId && p.stationName === stationName))), 15000)
    }
    const onSilentAlert = (alert: { cabId: string }) => {
      setAlertCabs(prev => new Set(prev).add(alert.cabId))
      setCabs(prev => {
        const cab = prev.get(alert.cabId)
        if (cab) return new Map(prev.set(alert.cabId, { ...cab, isAlert: true }))
        return prev
      })
    }

    sock.on("POLICE_ALERT",   onAlert)
    sock.on("ALERT_HISTORY",  onHistory)
    sock.on("station_cabs",   onStationCabs)
    sock.on("cab_update",     onCabUpdate)
    sock.on("cab_left",       onCabLeft)
    sock.on("trace_chain_update", onTraceChain)
    sock.on("predicted_incoming", onPredicted)
    sock.on("silent_alert",   onSilentAlert)

    return () => {
      sock.off("POLICE_ALERT",  onAlert)
      sock.off("ALERT_HISTORY", onHistory)
      sock.off("station_cabs",  onStationCabs)
      sock.off("cab_update",    onCabUpdate)
      sock.off("cab_left",      onCabLeft)
      sock.off("trace_chain_update", onTraceChain)
      sock.off("predicted_incoming", onPredicted)
      sock.off("silent_alert",  onSilentAlert)
      releaseSocket()
    }
  }, [])

  useEffect(() => {
    if (selectedStation) getSocket().emit("join_station", selectedStation)
  }, [selectedStation])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    cabLayerRef.current.clearLayers()
    destMarkersRef.current.forEach(m => { try { map.removeLayer(m) } catch {} })
    destMarkersRef.current.clear()
    sourceMarkersRef.current.forEach(m => { try { map.removeLayer(m) } catch {} })
    sourceMarkersRef.current.clear()
    routePolylinesRef.current.forEach(p => { try { map.removeLayer(p) } catch {} })
    routePolylinesRef.current.clear()
    stationCabLinesRef.current.forEach(p => { try { map.removeLayer(p) } catch {} })
    stationCabLinesRef.current.clear()

    cabs.forEach(cab => {
      const risk = cab.riskScore ?? 0
      let color = "#00ff00"
      if (risk >= 70) color = "#ff0000"
      else if (risk >= 35) color = "#ffff00"
      const isAlert = cab.isAlert || alertCabs.has(cab.cabId)
      const flashClass = isAlert ? " cab-marker-flash" : ""

      const icon = L.divIcon({
        html: `<div class="cab-marker-wrap${flashClass}" style="--cab-color: ${color};">
          <div class="cab-icon">🚕</div>
          <div class="cab-label">${cab.cabId}</div>
          ${risk > 0 ? `<div class="cab-risk">${risk}</div>` : ""}
        </div>`,
        className: "custom-cab-marker",
        iconSize: [44, 44],
        iconAnchor: [22, 22],
      })
      L.marker([cab.lat, cab.lon], { icon, pane: "cabs" }).addTo(cabLayerRef.current)

      // Source marker (trip start)
      const src = cab.source
      if (src && (src.lat !== cab.lat || src.lng !== cab.lon)) {
        const sm = L.circleMarker([src.lat, src.lng], {
          radius: 6, fillColor: "#7C3AED", color: "#ffffff",
          weight: 2, fillOpacity: 0.9, pane: "cabs",
        }).bindTooltip(`${cab.cabId} Start`, { className: "ps-tooltip" }).addTo(map)
        sourceMarkersRef.current.set(cab.cabId, sm)
      }

      // Route polyline (source → destination)
      const route = cab.route
      if (route && route.length >= 2) {
        const lls = route.map(p => [p.lat, p.lng] as L.LatLngTuple)
        const pl = L.polyline(lls, { color: "#a78bfa", weight: 3, opacity: 0.8, pane: "cabs" }).addTo(map)
        routePolylinesRef.current.set(cab.cabId, pl)
      }

      // Destination marker
      const dest = cab.destination
      if (dest && (dest.lat !== cab.lat || dest.lng !== cab.lon)) {
        const dm = L.circleMarker([dest.lat, dest.lng], {
          radius: 8, fillColor: "#10b981", color: "#ffffff",
          weight: 2, fillOpacity: 0.9, pane: "cabs",
        }).bindTooltip(`${cab.cabId} Destination`, { className: "ps-tooltip" }).addTo(map)
        destMarkersRef.current.set(cab.cabId, dm)
      }

      // Station–cab connection line (real-time: station monitoring this cab)
      if (cab.insideRadius && cab.stationId) {
        const st = stations.find(s => s.id === cab.stationId)
        if (st) {
          const line = L.polyline(
            [[st.lat, st.lon], [cab.lat, cab.lon]] as L.LatLngTuple[],
            { color: "#ef4444", weight: 2.5, dashArray: "6 10", opacity: 0.85, pane: "cabs" }
          ).addTo(map)
          stationCabLinesRef.current.set(cab.cabId, line)
        }
      }
    })

    return () => {
      destMarkersRef.current.forEach(m => { try { map.removeLayer(m) } catch {} })
      destMarkersRef.current.clear()
      sourceMarkersRef.current.forEach(m => { try { map.removeLayer(m) } catch {} })
      sourceMarkersRef.current.clear()
      routePolylinesRef.current.forEach(p => { try { map.removeLayer(p) } catch {} })
      routePolylinesRef.current.clear()
      stationCabLinesRef.current.forEach(p => { try { map.removeLayer(p) } catch {} })
      stationCabLinesRef.current.clear()
    }
  }, [cabs, alertCabs, stations])

  useEffect(() => {
    if (stations.length === 0) return
    let simStep = 0
    const id = setInterval(() => {
      const st = stations.find(s => s.id === selectedStation) ?? stations[0]
      const angle = (simStep * 0.15) % (2 * Math.PI)
      const dist = 0.008 + (simStep % 5) * 0.002
      getSocket().emit("cab_position", {
        cabId: "cab_demo",
        lat: st.lat + dist * Math.cos(angle),
        lon: st.lon + dist * Math.sin(angle),
      })
      simStep++
    }, 2500)
    return () => clearInterval(id)
  }, [selectedStation, stations])

  useEffect(() => {
    if (!selectedAlert) { setVerifyStatus(null); return }
    if (!selectedAlert.publicKey || !selectedAlert.signature) { setVerifyStatus("unsigned"); return }
    setVerifyStatus("pending")
    verifyPayload(selectedAlert.publicKey, selectedAlert.payload, selectedAlert.signature)
      .then(ok => setVerifyStatus(ok ? "verified" : "invalid"))
      .catch(() => setVerifyStatus("invalid"))
  }, [selectedAlert])

  const stationsByArea = stations.reduce<Record<string, PoliceStation[]>>((acc, s) => {
    const area = s.area ?? "General"
    ;(acc[area] ??= []).push(s)
    return acc
  }, {})
  const cabArray   = Array.from(cabs.values())
  const activeCabs = cabArray.filter(c => c.insideRadius).length

  return (
    <div className="min-h-screen bg-gray-900 text-green-400 font-mono select-none">
      <div className="bg-black border-b border-green-500 px-4 py-3 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-widest text-green-400">▸ Saarthi POLICE PORTAL</h1>
          <p className="text-green-600 text-xs tracking-wider">TACTICAL COMMAND &amp; CONTROL SYSTEM</p>
        </div>
        <div className="flex items-center gap-6">
          <span className="text-green-500 text-xs">{clockStr}</span>
          <Link to="/" className="text-green-500 hover:text-green-300 border border-green-700 hover:border-green-400 px-3 py-1 text-xs rounded transition-colors">← HOME</Link>
        </div>
      </div>

      <div className="flex h-[calc(100vh-56px)]">
        <div className="w-72 bg-[#0a0f0a] border-r border-green-800 p-3 overflow-y-auto space-y-3 flex-shrink-0">
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

          <div className="border border-green-700 rounded p-3">
            <p className="text-green-500 text-xs font-bold tracking-widest mb-2">▸ OPERATIONAL STATUS</p>
            <div className="space-y-1 text-xs">
              <div className="flex justify-between"><span className="text-green-600">Stations</span><span className="text-green-300">{stations.length}</span></div>
              <div className="flex justify-between"><span className="text-green-600">Active Cabs</span><span className="text-green-300">{activeCabs}/{cabArray.length}</span></div>
              <div className="flex justify-between">
                <span className="text-green-600">Scan</span>
                <span className={isScanning ? "text-green-400" : "text-yellow-400"}>{isScanning ? "● SCANNING" : "○ SILENT"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-green-600">Emergencies</span>
                <span className={alerts.length > 0 ? "text-red-400" : "text-green-400"}>{alerts.length > 0 ? `⚠ ${alerts.length}` : "NONE"}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-green-600">Silent Alerts</span>
                <span className={alertCabs.size > 0 ? "text-red-400 font-bold" : "text-green-400"}>{alertCabs.size > 0 ? `${alertCabs.size} ACTIVE` : "NONE"}</span>
              </div>
            </div>
          </div>

          <button
            onClick={() => setIsScanning(v => !v)}
            className={`w-full py-2 text-xs font-bold rounded border transition-colors ${
              isScanning ? "bg-green-700 hover:bg-green-600 border-green-500 text-black" : "bg-transparent hover:bg-green-900 border-green-700 text-green-400"
            }`}
          >
            {isScanning ? "DISABLE SCAN" : "ENABLE SCAN"}
          </button>

          <div className="border border-green-700 rounded p-3">
            <p className="text-green-500 text-xs font-bold tracking-widest mb-2">▸ ACTIVE UNITS</p>
            <div className="space-y-1 max-h-28 overflow-y-auto">
              {cabArray.length === 0 ? (
                <p className="text-green-700 text-xs">No units detected</p>
              ) : (
                cabArray.map(cab => {
                  const r = cab.riskScore ?? 0
                  const riskColor = r >= 70 ? "text-red-400" : r >= 35 ? "text-yellow-400" : "text-green-300"
                  return (
                    <div
                      key={cab.cabId}
                      onClick={() => setSelectedCabForTrace(selectedCabForTrace === cab.cabId ? null : cab.cabId)}
                      className={`flex justify-between text-xs cursor-pointer p-1 rounded hover:bg-gray-800 ${cab.isAlert ? "ring-1 ring-red-500" : ""}`}
                    >
                      <span className="text-green-400">{cab.cabId}</span>
                      <div className="flex gap-2">
                        <span className={riskColor}>R:{r}</span>
                        <span className={cab.insideRadius ? "text-green-300" : "text-yellow-400"}>{cab.insideRadius ? "IN" : "OUT"}</span>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {predictedIncoming.length > 0 && (
            <div className="border border-yellow-600 rounded p-3 bg-yellow-500/10">
              <p className="text-yellow-400 text-xs font-bold mb-2">▸ INCOMING (PREDICTED)</p>
              <div className="space-y-1 text-xs">
                {predictedIncoming.map((p, i) => (
                  <div key={i} className="text-yellow-300">{p.cabId} → {p.stationName}</div>
                ))}
              </div>
            </div>
          )}

          <div className="border border-green-700 rounded p-3">
            <p className="text-green-500 text-xs font-bold tracking-widest mb-2">▸ TRACE CHAIN</p>
            {selectedCabForTrace ? (
              <div className="space-y-1 max-h-24 overflow-y-auto text-xs">
                {(traceChains.get(selectedCabForTrace) || []).map((entry, i) => (
                  <div key={i} className="text-green-300 flex justify-between">
                    <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                    <span>{entry.stationName}</span>
                  </div>
                ))}
                {(traceChains.get(selectedCabForTrace) || []).length === 0 && <div className="text-green-500">No hops yet</div>}
                <button onClick={() => setSelectedCabForTrace(null)} className="text-green-500 hover:underline mt-2 text-[10px]">Close</button>
              </div>
            ) : (
              <p className="text-green-600 text-xs">Click a cab above to view trace</p>
            )}
          </div>

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
                      selectedAlert === a ? "bg-red-900/60 border border-red-500" : "bg-red-950/30 hover:bg-red-900/40 border border-red-900"
                    }`}
                  >
                    <div className="text-red-300 font-bold truncate">{a.payload?.tripId ?? "UNKNOWN"}</div>
                    <div className="text-red-500 text-[10px]">
                      {a.payload?.location ? `${a.payload.location.lat.toFixed(4)}, ${a.payload.location.lng.toFixed(4)}` : "—"}
                    </div>
                  </button>
                ))
              )}
            </div>
            {selectedAlert && (
              <div className="mt-2 pt-2 border-t border-red-800 text-xs">
                {verifyStatus === "pending" && <span className="text-yellow-400">⏳ Verifying…</span>}
                {verifyStatus === "verified" && <span className="text-green-400 flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> SIGNATURE VALID</span>}
                {verifyStatus === "invalid" && <span className="text-red-400 flex items-center gap-1"><ShieldX className="w-3 h-3" /> SIGNATURE INVALID</span>}
                {verifyStatus === "unsigned" && <span className="text-yellow-500 flex items-center gap-1"><ShieldAlert className="w-3 h-3" /> UNSIGNED PACKET</span>}
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

        <div className="flex-1 relative">
          <div ref={mapContainerRef} className="w-full h-full" />
          <div className="absolute top-3 right-3 bg-black/80 border border-green-700 rounded p-2 text-green-400 text-xs z-[999] space-y-0.5">
            <div>GRID  <span className="text-green-300">ACTIVE</span></div>
            <div>RANGE <span className="text-green-300">2 KM</span></div>
            <div>MODE  <span className="text-green-300">TACTICAL</span></div>
          </div>
          <div className="absolute bottom-3 right-3 bg-black/80 border border-green-700 rounded p-2 text-[10px] z-[999] space-y-1">
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-3 rounded-full bg-green-400 border border-white" />
              <span>Police Station</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-block w-3 h-3 rounded-full bg-red-500" />
              <span className="text-red-400">Emergency</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-lg leading-3">🚕</span>
              <span>Cab (Green/Yellow/Red = Risk)</span>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .ps-tooltip { background: rgba(0,0,0,0.85) !important; border: 1px solid #00ff00 !important; color: #00ff00 !important; font-family: monospace !important; font-size: 11px !important; padding: 3px 7px !important; }
        .alert-tooltip { background: rgba(0,0,0,0.85) !important; border: 1px solid #ff0000 !important; color: #ff4444 !important; font-family: monospace !important; font-size: 11px !important; }
        .custom-cab-marker { background: transparent !important; border: none !important; }
        .cab-marker-wrap { text-align: center; color: var(--cab-color, #00ff00); font-family: monospace; font-weight: bold; }
        .cab-icon { font-size: 18px; margin-bottom: 1px; }
        .cab-label { background: rgba(0,0,0,0.85); border: 1px solid var(--cab-color, #00ff00); border-radius: 3px; padding: 1px 4px; font-size: 9px; white-space: nowrap; }
        .cab-risk { font-size: 9px; color: var(--cab-color, #00ff00); margin-top: 1px; }
        .cab-marker-flash { animation: cab-flash 0.8s ease-in-out infinite; }
        @keyframes cab-flash { 0%, 100% { opacity: 1; filter: brightness(1); } 50% { opacity: 0.7; filter: brightness(1.5); } }
      `}</style>
    </div>
  )
}
