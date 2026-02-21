/**
 * Sahayak – Unified Emergency + Police Station Server
 * Merges our RSA-signed EMERGENCY_EVENT / POLICE_ALERT system
 * with the teammate's station-awareness and cab-tracking features.
 * Port: 4000
 */

const express = require("express")
const http    = require("http")
const { Server } = require("socket.io")
const cors   = require("cors")
const geo    = require("./geo")
const crypto = require("./crypto")
const intel  = require("./intelligence")

const app    = express()
const server = http.createServer(app)
const io     = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } })

app.use(cors())
app.use(express.json())

// ── In-memory state ───────────────────────────────────────────────────────────

const alertLog      = []
const cabState      = new Map()
const movementHist  = new Map()
const traceChain    = new Map()
let lastAlertHash   = "0"

// ── REST API ──────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => res.json({ status: "ok" }))

/** Police stations list */
app.get("/api/stations", (_req, res) => res.json(geo.getStations()))

/** Server RSA public key (PEM) */
app.get("/api/crypto/public-key", (_req, res) =>
  res.json({ publicKey: crypto.getPublicKeyPem() })
)

/**
 * POST /api/emergency
 * Accepts a signed emergency payload from external clients.
 * Verifies signature, chains SHA-256 hash, broadcasts to all.
 */
app.post("/api/emergency", (req, res) => {
  const { payload, signature } = req.body
  const sigToVerify = signature || crypto.signEmergencyPayload(payload)
  if (!crypto.verifySignature(payload, sigToVerify))
    return res.status(401).json({ error: "Invalid signature" })

  const alert = {
    id: `alert_${Date.now()}`,
    ...payload,
    prevHash: lastAlertHash,
    timestamp: Date.now(),
  }
  alert.hash = crypto.sha256(alert)
  lastAlertHash = alert.hash
  alertLog.push(alert)

  io.emit("POLICE_ALERT", {
    payload: alert,
    signature: sigToVerify,
    publicKey: crypto.getPublicKeyPem(),
    receivedAt: Date.now(),
    socketId: "api",
  })
  res.json({ ok: true, alertId: alert.id })
})

// ── Socket.io ─────────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[+] Client connected   id=${socket.id}`)

  // Send alert history to newly connected clients (police dashboard)
  if (alertLog.length > 0) {
    const history = alertLog.map(a => ({
      payload: a, signature: "", publicKey: "",
      receivedAt: a.timestamp, socketId: "history",
    }))
    socket.emit("ALERT_HISTORY", history)
  }

  // ── Our emergency channel ─────────────────────────────────────────────────
  socket.on("EMERGENCY_EVENT", (data) => {
    const enriched = { ...data, receivedAt: Date.now(), socketId: socket.id }
    console.log(`[!] EMERGENCY_EVENT  trip=${data?.payload?.tripId}  from=${socket.id}`)
    alertLog.push({ ...data.payload, receivedAt: enriched.receivedAt })
    io.emit("POLICE_ALERT", enriched)
  })

  // ── Teammate's station channel ────────────────────────────────────────────
  socket.on("join_station", (stationId) => {
    socket.join(`station:${stationId}`)
    const cabs = [...cabState.entries()]
      .filter(([, s]) => s.stationId === stationId)
      .map(([id, s]) => ({ id, ...s }))
    socket.emit("station_cabs", cabs)
    for (const [cabId, chain] of traceChain.entries()) {
      const cab = cabState.get(cabId)
      if (cab && cab.stationId === stationId) socket.emit("trace_chain_update", { cabId, chain })
    }
  })

  socket.on("cab_position", (data) => {
    const { cabId, lat, lon } = data
    const now = Date.now()

    let hist = movementHist.get(cabId) || []
    hist.push({ lat, lon, ts: now })
    if (hist.length > 20) hist = hist.slice(-20)
    movementHist.set(cabId, hist)

    const station   = geo.getOwningStation(lat, lon)
    const prevState = cabState.get(cabId)
    const prevStationId = prevState?.stationId

    const tripToken = prevState?.tripToken || crypto.generateTripToken({ cabId, lat, lon })
    const riskScore = intel.computeRiskScore(cabId, movementHist, traceChain)
    const predictedNext = intel.predictNextStation(cabId, movementHist, geo.getStations())

    const newState  = {
      lat, lon,
      stationId: station.id,
      stationName: station.name,
      tripToken,
      insideRadius: station.insideRadius,
      lastUpdate: now,
      riskScore,
      predictedNextStationId: predictedNext ? predictedNext.id : null,
      predictedNextStationName: predictedNext ? predictedNext.name : null,
      isAlert: false,
    }

    if (prevStationId && prevStationId !== station.id) {
      const entry = intel.buildTraceEntry(station.id, station.name)
      const chain = intel.chainTrace(traceChain, cabId, entry)
      io.to(`station:${prevStationId}`).emit("cab_left", cabId)
      io.emit("trace_chain_update", { cabId, chain })
      io.to(`station:${station.id}`).emit("predicted_incoming", { cabId, ...newState, type: "ACTUAL" })
    } else if (!prevStationId && station.insideRadius) {
      const entry = intel.buildTraceEntry(station.id, station.name)
      const chain = intel.chainTrace(traceChain, cabId, entry)
      io.emit("trace_chain_update", { cabId, chain })
    }
    if (predictedNext && predictedNext.id !== station.id) {
      io.to(`station:${predictedNext.id}`).emit("predicted_incoming", {
        cabId, ...newState, type: "PREDICTED", etaSeconds: 90,
      })
    }

    const distressTriggers = intel.checkSilentDistress(cabId, movementHist, traceChain, riskScore)
    if (distressTriggers.length > 0) {
      newState.isAlert = true
      newState.distressTriggers = distressTriggers
      const alertPayload = {
        cabId, lat, lon, stationId: station.id, riskScore,
        traceChain: traceChain.get(cabId) || [],
        triggers: distressTriggers, type: "SILENT_DISTRESS",
        severity: riskScore >= 75 ? "CRITICAL" : riskScore >= 50 ? "HIGH" : "MEDIUM",
      }
      const alert = { id: `alert_${Date.now()}`, ...alertPayload, prevHash: lastAlertHash, timestamp: Date.now() }
      alert.hash = crypto.sha256(alert)
      lastAlertHash = alert.hash
      alertLog.push(alert)
      io.emit("silent_alert", alert)
    }

    cabState.set(cabId, newState)
    io.to(`station:${station.id}`).emit("cab_update", { cabId, ...newState })
  })

  socket.on("disconnect", (reason) => {
    console.log(`[-] Client disconnected id=${socket.id}  reason=${reason}`)
  })
})

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = 4000
server.listen(PORT, () => {
  console.log(`\n  Sahayak Unified Server`)
  console.log(`  Emergency + Police Station API`)
  console.log(`  http://localhost:${PORT}`)
  console.log(`  Press Ctrl+C to stop\n`)
})
