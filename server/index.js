/**
 * Sahayak Police Portal - Single unified server
 * Express + Socket.io + Vite (dev) or static build (prod)
 * 100% offline-first: risk scoring, prediction, trace chain, silent alerts, store & forward
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const crypto = require("./crypto");
const geo = require("./geo");
const intel = require("./intelligence");

const app = express();
const server = http.createServer(app);

const isDev = process.env.NODE_ENV !== "production";
const PORT = process.env.PORT || 3000;

const io = new Server(server, {
  cors: { origin: true },
});

const cabState = new Map();
const movementHistory = new Map();
const traceChain = new Map();
const alertBuffer = [];
const lastAlertHash = { current: "0" };

app.use(express.json());

// API routes
app.get("/api/stations", (req, res) => {
  res.json(geo.getStations());
});

app.get("/api/crypto/public-key", (req, res) => {
  res.json({ publicKey: crypto.getPublicKeyPem() });
});

app.get("/api/trace/:cabId", (req, res) => {
  const chain = traceChain.get(req.params.cabId) || [];
  res.json(chain);
});

app.get("/api/alerts/pending", (req, res) => {
  res.json(alertBuffer);
});

app.post("/api/emergency", (req, res) => {
  const { payload, signature } = req.body;
  const sigToVerify = signature || crypto.signEmergencyPayload(payload);
  const valid = crypto.verifySignature(payload, sigToVerify);
  if (!valid) return res.status(401).json({ error: "Invalid signature" });

  const alert = createAndStoreAlert(payload, "MANUAL");
  io.emit("emergency_alert", alert);
  res.json({ ok: true, alertId: alert.id });
});

function createAndStoreAlert(payload, source) {
  const alert = {
    id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ...payload,
    source,
    prevHash: lastAlertHash.current,
    timestamp: Date.now(),
  };
  alert.hash = crypto.sha256(alert);
  alert.signature = crypto.signEmergencyPayload(alert);
  lastAlertHash.current = alert.hash;
  alertBuffer.push(alert);
  return alert;
}

// Offline Store & Forward: when station joins, forward pending alerts for its area
function forwardPendingAlertsToStation(stationId) {
  const station = geo.getStations().find(s => s.id === stationId);
  if (!station) return;
  const toForward = alertBuffer.filter(a => {
    if (!a.lat || !a.lon) return false;
    const d = geo.haversineDistance(a.lat, a.lon, station.lat, station.lon);
    return d <= 2.0;
  });
  if (toForward.length > 0) {
    io.to(`station:${stationId}`).emit("alert_buffer_synced", toForward);
  }
}

// Offline map tiles (fallback)
app.get("/tiles/:z/:x/:y.png", (req, res) => {
  const fallback = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "public, max-age=86400");
  res.send(fallback);
});

// Socket.io: real-time cab tracking + intelligence
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("join_station", (stationId) => {
    socket.join(`station:${stationId}`);
    const cabs = [...cabState.entries()]
      .filter(([, s]) => s.stationId === stationId)
      .map(([id, s]) => ({ id, ...s }));
    socket.emit("station_cabs", cabs);
    for (const [cabId, chain] of traceChain.entries()) {
      const cab = cabState.get(cabId);
      if (cab && cab.stationId === stationId) {
        socket.emit("trace_chain_update", { cabId, chain });
      }
    }
    forwardPendingAlertsToStation(stationId);
  });

  socket.on("cab_position", (data) => {
    const { cabId, lat, lon } = data;
    const now = Date.now();

    // Movement history (keep last 20 points)
    let hist = movementHistory.get(cabId) || [];
    hist.push({ lat, lon, ts: now });
    if (hist.length > 20) hist = hist.slice(-20);
    movementHistory.set(cabId, hist);

    const station = geo.getOwningStation(lat, lon);
    const prevState = cabState.get(cabId);
    const prevStationId = prevState?.stationId;

    const tripToken = prevState?.tripToken || crypto.generateTripToken({ cabId, lat, lon });

    const riskScore = intel.computeRiskScore(cabId, movementHistory, traceChain);
    const predictedNext = intel.predictNextStation(cabId, movementHistory, geo.getStations());

    const newState = {
      lat,
      lon,
      stationId: station.id,
      stationName: station.name,
      tripToken,
      insideRadius: station.insideRadius,
      lastUpdate: now,
      riskScore,
      predictedNextStationId: predictedNext ? predictedNext.id : null,
      predictedNextStationName: predictedNext ? predictedNext.name : null,
      isAlert: false,
    };

    if (prevStationId && prevStationId !== station.id) {
      const entry = intel.buildTraceEntry(station.id, station.name);
      const chain = intel.chainTrace(traceChain, cabId, entry);
      io.to(`station:${prevStationId}`).emit("cab_left", cabId);
      io.to(`station:${station.id}`).emit("cab_update", { cabId, ...newState });
      io.emit("trace_chain_update", { cabId, chain });
      io.to(`station:${station.id}`).emit("predicted_incoming", { cabId, ...newState, type: "ACTUAL" });
    } else if (!prevStationId && station.insideRadius) {
      const entry = intel.buildTraceEntry(station.id, station.name);
      const chain = intel.chainTrace(traceChain, cabId, entry);
      io.emit("trace_chain_update", { cabId, chain });
    }

    if (predictedNext && predictedNext.id !== station.id) {
      io.to(`station:${predictedNext.id}`).emit("predicted_incoming", {
        cabId,
        ...newState,
        type: "PREDICTED",
        etaSeconds: 90,
      });
    }

    const distressTriggers = intel.checkSilentDistress(cabId, movementHistory, traceChain, riskScore);
    cabState.set(cabId, newState);

    if (distressTriggers.length > 0) {
      newState.isAlert = true;
      newState.distressTriggers = distressTriggers;
      cabState.set(cabId, newState);
      const alertPayload = {
        cabId,
        lat,
        lon,
        stationId: station.id,
        riskScore,
        traceChain: traceChain.get(cabId) || [],
        triggers: distressTriggers,
        type: "SILENT_DISTRESS",
        severity: riskScore >= 75 ? "CRITICAL" : riskScore >= 50 ? "HIGH" : "MEDIUM",
      };
      const alert = createAndStoreAlert(alertPayload, "AUTO");
      io.emit("silent_alert", alert);
      io.emit("cab_update", { cabId, ...newState });
    } else {
      io.to(`station:${station.id}`).emit("cab_update", { cabId, ...newState });
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

async function start() {
  if (isDev) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: { server },
      },
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "..", "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/tiles") || req.path.startsWith("/socket.io"))
        return res.status(404).send();
      const htmlPath = path.join(distPath, "index.html");
      if (fs.existsSync(htmlPath)) {
        res.sendFile(htmlPath);
      } else {
        res.status(404).send("Build the app first: npm run build");
      }
    });
  }

  let listening = false;
  const tryListen = (port) => {
    if (listening) return;

    const s = server.listen(port, () => {
      if (listening) return;
      listening = true;
      console.log(`🚀 Sahayak Police Portal: http://localhost:${port}`);
      console.log(`📍 Police Dashboard: http://localhost:${port}/police`);
      if (isDev) console.log("⚡ Dev mode: Vite HMR enabled");
    });

    s.on("error", (err) => {
      if (err.code === "EADDRINUSE" && port < 3010) {
        console.log(`Port ${port} in use, trying ${port + 1}...`);
        s.close(() => tryListen(port + 1));
      } else {
        console.error("Server error:", err);
        process.exit(1);
      }
    });
  };

  tryListen(PORT);
}

start().catch(console.error);
