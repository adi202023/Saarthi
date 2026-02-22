# Saarthi – Privacy-First Digital Safety Infrastructure

**Cryptographic Identity. Smart Geo-Fencing. Resilient Emergency Protection.**

Saarthi (Sahayak) is a privacy-first platform that protects individuals using cryptographic proof instead of storing sensitive data—with intelligent route monitoring, real-time police jurisdiction tracking, and secure emergency escalation.

🔗 **Live Demo:** [https://saarthi-teal.vercel.app](https://saarthi-teal.vercel.app)

---

## ✨ Features

### 🏠 Landing Page
- Cinematic hero with Three.js particle effects
- Responsive, animated UI with Framer Motion
- Overview of privacy-first architecture

### 👛 Wallet
- Cryptographic identity vault
- Store only hashes—never raw IDs
- Prove identity without exposing data

### 🚕 Cab Portal
- **Real-time GPS tracking** with simulation mode for testing
- **OSRM road routing** – actual driving routes, not straight lines
- **Smart corridor** – geo-fenced safe zone around the route
- **Dynamic risk scoring** – deviation detection, corridor violation alerts
- **Police jurisdiction** – live connection to nearest station along the route
- **Source → destination sync** – route, start, and destination shared with Police Portal
- **Emergency alerts** – RSA-signed distress signals
- **Vehicle booking** – Mini, Sedan, SUV, Premium with fare estimates
- **Offline map fallback** – graceful degradation when tiles fail

### 🚔 Police Portal
- **Tactical command dashboard** – station-centric view
- **Live cab tracking** – real-time position, risk level, 2km scan radius
- **Source–destination sync** – view each cab’s trip route on the map
- **Station–cab connection lines** – dashed lines from station to cabs in jurisdiction
- **Trace chain** – cab movement history across stations
- **Predicted incoming** – cabs entering jurisdiction soon
- **Silent distress alerts** – risk-based anomaly detection
- **Emergency verification** – cryptographic signature validation
- **Grid overlay** – tactical coordinate view

---

## 🛠 Tech Stack

| Layer | Technologies |
|-------|--------------|
| **Frontend** | React 19, Vite 7, TypeScript, Tailwind CSS |
| **Maps** | Leaflet, Turf.js, OSRM (routing) |
| **Animation** | Framer Motion, GSAP, Three.js |
| **Real-time** | Socket.io |
| **Crypto** | Web Crypto API, RSA signatures |
| **Backend** | Node.js, Express, Socket.io |

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- npm or yarn

### Installation

```bash
# Clone the repository
git clone https://github.com/adi202023/Saarthi.git
cd Saarthi

# Install dependencies
npm install

# Start development server (frontend)
npm run dev

# In a separate terminal – start backend
npm run server
```

The app runs at [http://localhost:5173](http://localhost:5173) and the backend at [http://localhost:4000](http://localhost:4000).

### Build for Production

```bash
npm run build
npm run preview   # Preview production build
```

---

## 🌐 Deployment

### Frontend (Vercel)
The frontend is configured for Vercel. Push to `main` or run:

```bash
npx vercel --prod
```

### Backend
The Express + Socket.io server must be deployed separately (Vercel is serverless and does not support WebSockets). Use:

- [Render](https://render.com) (recommended)
- [Railway](https://railway.app)
- Any Node.js host

### Environment Variables

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | Backend URL (e.g. `https://saarthi-api.onrender.com`) – set in Vercel for production |

---

## 📁 Project Structure

```
Saarthi/
├── src/
│   ├── pages/          # HomePage, CabPage, PoliceDashboard, WalletPage
│   ├── components/     # UI components
│   ├── lib/            # socket, geo, crypto
│   └── context/        # Trip tracking (optional)
├── server/             # Express + Socket.io backend
│   ├── server.js       # Main server
│   ├── geo.js          # Station data, haversine
│   ├── crypto.js       # RSA signing/verification
│   └── intelligence.js # Risk scoring, trace chain, predictions
├── public/             # Static assets
├── vercel.json         # Vercel deployment config
└── package.json
```

---

## 🔐 Security & Privacy

- **No raw identity storage** – only cryptographic hashes
- **RSA-signed emergency payloads** – verifiable authenticity
- **Chained SHA-256 hashes** – tamper-evident alert history
- **Corridor-based monitoring** – route-focused, not continuous tracking

---

## 📄 License

ISC

---

## 🤝 Contributing

1. Fork the repository  
2. Create a feature branch (`git checkout -b feature/amazing`)  
3. Commit changes (`git commit -m 'Add amazing feature'`)  
4. Push to the branch (`git push origin feature/amazing`)  
5. Open a Pull Request  

---

**Saarthi** – *Your companion for safer journeys.*
