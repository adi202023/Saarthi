import { io, Socket } from "socket.io-client"
import type { CabState } from "./geo"

const SERVER_URL = "http://localhost:4000"

let socket: Socket | null = null
let refCount = 0

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SERVER_URL, {
      autoConnect: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    })
    socket.on("connect", () => console.log("[socket] Connected  id=", socket?.id))
    socket.on("connect_error", (err) => console.warn("[socket] Error:", err.message))
    socket.on("disconnect", (reason) => console.log("[socket] Disconnected:", reason))
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
