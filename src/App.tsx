import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom"
import HomePage from "./pages/HomePage"
import WalletPage from "./pages/WalletPage"
import CabPage from "./pages/CabPage"
import PoliceDashboard from "./pages/PoliceDashboard"

/** Keeps CabPage mounted when switching to Police so cab movement & sync continues in background */
function CabPoliceLayout() {
  const loc = useLocation()
  const onCab = loc.pathname === "/cab"
  const onPolice = loc.pathname === "/police"
  const showBoth = onCab || onPolice
  if (!showBoth) return null
  return (
    <div style={{ position: "relative", width: "100%", minHeight: "100vh" }}>
      <div style={{ display: onCab ? "block" : "none", height: "100%", position: "absolute", inset: 0, zIndex: onCab ? 0 : -1 }}>
        <CabPage />
      </div>
      <div style={{ display: onPolice ? "block" : "none", height: "100%", position: "absolute", inset: 0, zIndex: onPolice ? 0 : -1 }}>
        <PoliceDashboard />
      </div>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/wallet" element={<WalletPage />} />
        <Route path="/cab" element={<CabPoliceLayout />} />
        <Route path="/police" element={<CabPoliceLayout />} />
      </Routes>
    </BrowserRouter>
  )
}
