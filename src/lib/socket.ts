import { io, Socket } from "socket.io-client"
import type { CabState, TraceChainEntry, SilentAlert } from "./geo"

const rawUrl = import.meta.env.VITE_API_URL ?? ""
const isDeployed = typeof window !== "undefined" &&
  !/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(window.location.host)
const pointsToLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(rawUrl)

// On deployed site: never use localhost, skip connection when no valid backend
const hasBackend = rawUrl && (!isDeployed || !pointsToLocalhost)
const SERVER_URL = hasBackend ? rawUrl : ""
const shouldConnect = hasBackend || (import.meta.env.DEV && rawUrl === "")

/** Effective API base URL. Empty when no backend (use static fallback). */
export const API_BASE = hasBackend ? SERVER_URL : ""

let socket: Socket | null = null
let refCount = 0

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SERVER_URL || undefined, {
      transports:           ["websocket"],
      autoConnect:          shouldConnect,
      reconnection:         shouldConnect,
      reconnectionAttempts: shouldConnect ? 10 : 0,
      reconnectionDelay:    1500,
    })
    if (shouldConnect) {
      socket.on("connect", () =>
        console.log("[socket] ✅ Connected  id=", socket?.id))
      socket.on("connect_error", (err) =>
        console.error("[socket] ❌ Connection error:", err.message))
      socket.on("disconnect", (reason) =>
        console.log("[socket] 🔌 Disconnected:", reason))
      socket.on("reconnect", (attempt) =>
        console.log("[socket] 🔄 Reconnected after attempt", attempt))
    }
  }
  refCount++
  return socket
}

export function releaseSocket(): void {
  refCount = Math.max(0, refCount - 1)
  if (refCount === 0 && socket) {
    socket.disconnect()
    socket = null
  }
}

// ── SocketManager: thin wrapper used by PoliceDashboard ──────────────────────
// Reuses the same singleton connection so there is never a duplicate socket.
class SocketManager {
  connect(): Socket { return getSocket() }
  disconnect() { releaseSocket() }

  joinStation(stationId: string) {
    getSocket().emit("join_station", stationId)
  }

  onStationCabs(cb: (cabs: Array<CabState & { cabId: string }>) => void) {
    getSocket().on("station_cabs", cb)
  }

  onCabUpdate(cb: (cab: CabState & { cabId: string }) => void) {
    getSocket().on("cab_update", cb)
  }

  onCabLeft(cb: (cabId: string) => void) {
    getSocket().on("cab_left", cb)
  }

  onTraceChainUpdate(cb: (data: { cabId: string; chain: TraceChainEntry[] }) => void) {
    getSocket().on("trace_chain_update", cb)
  }

  onPredictedIncoming(cb: (data: CabState & { cabId: string; type: string; etaSeconds?: number }) => void) {
    getSocket().on("predicted_incoming", cb)
  }

  onSilentAlert(cb: (alert: SilentAlert) => void) {
    getSocket().on("silent_alert", cb)
  }

  onAlertBufferSynced(cb: (alerts: SilentAlert[]) => void) {
    getSocket().on("alert_buffer_synced", cb)
  }

  emitCabPosition(cabId: string, lat: number, lon: number) {
    getSocket().emit("cab_position", { cabId, lat, lon })
  }

  off(event: string, cb?: (...args: unknown[]) => void) {
    getSocket().off(event, cb)
  }
}

export const socketManager = new SocketManager()

/** The raw emergency data object that is signed. */
export interface EmergencyPayload {
  tripId: string
  location: { lat: number; lng: number }
  timestamp: number
  severity: "HIGH" | "MEDIUM" | "LOW"
}

/** What the Cab module emits on "EMERGENCY_EVENT". */
export interface SignedEmergencyPacket {
  payload: EmergencyPayload
  signature: string
  publicKey: string
}

/** What the server broadcasts on "POLICE_ALERT". */
export interface PoliceAlertPayload extends SignedEmergencyPacket {
  receivedAt: number
  socketId: string
}
