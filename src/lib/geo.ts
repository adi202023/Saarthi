export interface PoliceStation {
  id: string
  name: string
  lat: number
  lon: number
  area?: string
  address?: string
  phone?: string
  distance?: number
  insideRadius?: boolean
}

export interface CabState {
  id: string
  lat: number
  lon: number
  stationId: string
  tripToken: string
  insideRadius: boolean
  lastUpdate: number
  cabId?: string
}

export interface EmergencyAlert {
  id: string
  cabId: string
  lat: number
  lon: number
  type: string
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
  message: string
  timestamp: number
  hash: string
  prevHash: string
}

export function haversineDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
