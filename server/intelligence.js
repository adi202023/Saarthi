/**
 * Offline Intelligence Layer - Risk scoring, prediction, trace chain, distress detection
 * 100% local computation, no internet
 */

const geo = require("./geo");
const crypto = require("./crypto");

// Main arterial roads (approx segments in Bangalore) - offline zone metadata
const MAIN_ROADS = [
  { lat1: 12.97, lon1: 77.59, lat2: 12.98, lon2: 77.61 },   // MG Road / Brigade
  { lat1: 12.92, lon1: 77.61, lat2: 12.93, lon2: 77.63 },   // Koramangala
  { lat1: 12.96, lon1: 77.58, lat2: 12.97, lon2: 77.60 },   // Vidhana Soudha area
  { lat1: 12.84, lon1: 77.66, lat2: 12.86, lon2: 77.67 },   // Electronic City
  { lat1: 12.96, lon1: 77.74, lat2: 12.97, lon2: 77.75 },   // Whitefield
];

// Low-density / isolated zones (heuristic bounding boxes)
const ISOLATED_ZONES = [
  { latMin: 12.26, latMax: 12.28, lonMin: 76.66, lonMax: 76.68 },  // Chamundi Hill
  { latMin: 12.10, latMax: 12.35, lonMin: 76.55, lonMax: 76.75 },  // Mysuru outskirts
];

const config = {
  STOP_THRESHOLD_MINUTES: 3,
  ROUTE_DEVIATION_THRESHOLD_PCT: 40,
  RISK_CRITICAL_THRESHOLD: 75,
  HOP_ABNORMAL_COUNT: 3,
  HOP_ABNORMAL_WINDOW_MS: 120000,
  PREDICTION_HORIZON_SEC: 90,
};

/** Min distance from a main road segment (simplified point-to-segment) */
function distanceFromMainRoad(lat, lon) {
  let minDist = 999;
  for (const r of MAIN_ROADS) {
    const d = geo.haversineDistance(lat, lon, (r.lat1 + r.lat2) / 2, (r.lon1 + r.lon2) / 2);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/** Check if in isolated zone */
function isInIsolatedZone(lat, lon) {
  return ISOLATED_ZONES.some(z =>
    lat >= z.latMin && lat <= z.latMax && lon >= z.lonMin && lon <= z.lonMax
  );
}

/** Time-of-day risk: 22:00-05:00 = higher */
function timeOfDayRisk() {
  const h = new Date().getHours();
  if (h >= 22 || h <= 5) return 25;
  if (h >= 21 || h <= 6) return 15;
  return 0;
}

/** Compute live risk score 0-100 */
function computeRiskScore(cabId, movementHistory, traceChain) {
  const now = Date.now();
  const history = movementHistory.get(cabId) || [];
  const trace = traceChain.get(cabId) || [];

  let score = 0;
  const weights = { timeOfDay: 0.2, deviation: 0.25, speed: 0.25, mainRoad: 0.15, isolated: 0.15 };

  score += timeOfDayRisk() * weights.timeOfDay;

  // Route deviation (simplified: compare straight-line vs actual path)
  if (history.length >= 3) {
    const start = history[0];
    const end = history[history.length - 1];
    const straightDist = geo.haversineDistance(start.lat, start.lon, end.lat, end.lon);
    let actualDist = 0;
    for (let i = 0; i < history.length - 1; i++) {
      actualDist += geo.haversineDistance(history[i].lat, history[i].lon, history[i + 1].lat, history[i + 1].lon);
    }
    const deviationPct = straightDist > 0 ? Math.max(0, ((actualDist - straightDist) / straightDist) * 100) : 0;
    score += Math.min(30, deviationPct) * (weights.deviation * 100 / 30);
  }

  // Speed anomalies: sudden stops, zig-zag (bearing changes)
  if (history.length >= 3) {
    const recent = history.slice(-5);
    let stopScore = 0;
    let zigzagScore = 0;
    const stopThresholdMs = 60000; // 1 min no move
    for (let i = 1; i < recent.length; i++) {
      const dt = recent[i].ts - recent[i - 1].ts;
      const dist = geo.haversineDistance(recent[i - 1].lat, recent[i - 1].lon, recent[i].lat, recent[i].lon);
      if (dt > stopThresholdMs && dist < 0.05) stopScore += 15;
      if (i >= 2) {
        const b1 = bearing(recent[i - 2].lat, recent[i - 2].lon, recent[i - 1].lat, recent[i - 1].lon);
        const b2 = bearing(recent[i - 1].lat, recent[i - 1].lon, recent[i].lat, recent[i].lon);
        if (Math.abs(b2 - b1) > 90) zigzagScore += 8;
      }
    }
    score += Math.min(25, stopScore + zigzagScore);
  }

  const last = history[history.length - 1];
  if (last) {
    const roadDist = distanceFromMainRoad(last.lat, last.lon);
    if (roadDist > 5) score += 15;
    else if (roadDist > 2) score += 8;
    if (isInIsolatedZone(last.lat, last.lon)) score += 20;
  }

  return Math.min(100, Math.round(score));
}

function bearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
    Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  return Math.atan2(y, x) * 180 / Math.PI;
}

/** Predict next station 60-120s ahead */
function predictNextStation(cabId, movementHistory, stations) {
  const history = movementHistory.get(cabId) || [];
  if (history.length < 2) return null;
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  const dt = (last.ts - prev.ts) / 1000;
  if (dt <= 0) return null;
  const distLast = geo.haversineDistance(prev.lat, prev.lon, last.lat, last.lon);
  const speedKmh = distLast / (dt / 3600);
  const bearingDeg = bearing(prev.lat, prev.lon, last.lat, last.lon);
  const horizonSec = Math.min(120, Math.max(60, config.PREDICTION_HORIZON_SEC));
  const distKm = (speedKmh / 3600) * horizonSec;
  const R = 6371;
  const d = distKm / R;
  const br = bearingDeg * Math.PI / 180;
  const latRad = last.lat * Math.PI / 180;
  const predLat = Math.asin(Math.sin(latRad) * Math.cos(d) + Math.cos(latRad) * Math.sin(d) * Math.cos(br)) * 180 / Math.PI;
  const predLon = last.lon * Math.PI / 180 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(latRad), Math.cos(d) - Math.sin(latRad) * Math.sin(predLat * Math.PI / 180));
  const predLonDeg = predLon * 180 / Math.PI;

  const current = geo.getOwningStation(last.lat, last.lon);
  const predicted = geo.getOwningStation(predLat, predLonDeg);
  if (predicted.id !== current.id) return predicted;
  return null;
}

/** Check silent distress triggers */
function checkSilentDistress(cabId, movementHistory, traceChain, riskScore) {
  const history = movementHistory.get(cabId) || [];
  const trace = traceChain.get(cabId) || [];
  const triggers = [];

  if (riskScore >= config.RISK_CRITICAL_THRESHOLD) {
    triggers.push("RISK_CRITICAL");
  }

  if (history.length >= 2) {
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    const stoppedMs = Date.now() - last.ts;
    if (stoppedMs > config.STOP_THRESHOLD_MINUTES * 60 * 1000) {
      const dist = geo.haversineDistance(prev.lat, prev.lon, last.lat, last.lon);
      if (dist < 0.05) triggers.push("STOPPED_EXTENDED");
    }

    const start = history[0];
    const straightDist = geo.haversineDistance(start.lat, start.lon, last.lat, last.lon);
    let actualDist = 0;
    for (let i = 0; i < history.length - 1; i++) {
      actualDist += geo.haversineDistance(history[i].lat, history[i].lon, history[i + 1].lat, history[i + 1].lon);
    }
    const deviationPct = straightDist > 0 ? ((actualDist - straightDist) / straightDist) * 100 : 0;
    if (deviationPct > config.ROUTE_DEVIATION_THRESHOLD_PCT) {
      triggers.push("ROUTE_DEVIATION");
    }
  }

  const recentTraces = trace.filter(t => Date.now() - t.timestamp < config.HOP_ABNORMAL_WINDOW_MS);
  if (recentTraces.length >= config.HOP_ABNORMAL_COUNT) {
    triggers.push("ABNORMAL_HOPPING");
  }

  if (history.length >= 4) {
    const recent = history.slice(-4);
    let stopStarts = 0;
    for (let i = 1; i < recent.length; i++) {
      const dist = geo.haversineDistance(recent[i - 1].lat, recent[i - 1].lon, recent[i].lat, recent[i].lon);
      if (dist < 0.02) stopStarts++;
    }
    const last = history[history.length - 1];
    if (stopStarts >= 2 && isInIsolatedZone(last.lat, last.lon)) {
      triggers.push("STOP_START_ISOLATED");
    }
  }

  return triggers;
}

/** Build hash-chained trace entry */
function buildTraceEntry(stationId, stationName) {
  return {
    stationId,
    stationName,
    timestamp: Date.now(),
    prevHash: null,
    hash: null,
  };
}

function chainTrace(traceChain, cabId, entry) {
  const chain = traceChain.get(cabId) || [];
  const prevHash = chain.length > 0 ? chain[chain.length - 1].hash : "0";
  entry.prevHash = prevHash;
  const payload = { ...entry, prevHash };
  entry.hash = crypto.sha256(payload);
  chain.push(entry);
  traceChain.set(cabId, chain);
  return chain;
}

module.exports = {
  computeRiskScore,
  predictNextStation,
  checkSilentDistress,
  buildTraceEntry,
  chainTrace,
  config,
};
