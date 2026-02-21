import { useState, useCallback } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { Lock, Eye, EyeOff, FileText, Upload, Fingerprint, X, Copy, Check } from "lucide-react"

interface StoredProof {
  id: string
  fileName: string
  hash: string
  file: File
  addedAt: Date
}

async function generateHash(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

export function WalletSection() {
  const [file, setFile] = useState<File | null>(null)
  const [hash, setHash] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [proofs, setProofs] = useState<StoredProof[]>([])
  const [previewFile, setPreviewFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const copyHash = async (hashVal: string, id: string) => {
    await navigator.clipboard.writeText(hashVal)
    setCopiedId(id)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const handleFileChange = useCallback(async (f: File | null) => {
    if (!f) {
      setFile(null)
      setHash(null)
      return
    }
    setFile(f)
    setIsProcessing(true)
    setHash(null)
    try {
      const h = await generateHash(f)
      setHash(h)
    } finally {
      setIsProcessing(false)
    }
  }, [])

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) handleFileChange(f)
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFileChange(e.target.files?.[0] ?? null)
  }

  const addToWallet = () => {
    if (!file || !hash) return
    setProofs((p) => [...p, { id: crypto.randomUUID(), fileName: file.name, hash, file, addedAt: new Date() }])
    setFile(null)
    setHash(null)
  }

  const removeProof = (id: string) => {
    setProofs((p) => p.filter((x) => x.id !== id))
  }

  return (
    <div id="wallet" className="px-6 py-24 max-w-4xl mx-auto">
      <motion.h2 initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-3xl font-bold text-white mb-2">
        Identity Wallet
      </motion.h2>
      <motion.p initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-[#A1A1AA] mb-16">
        Store cryptographic proofs of your documents—never the documents themselves.
      </motion.p>

      <motion.section id="wallet-generate" initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="mb-24">
        <h3 className="text-xl font-semibold text-white mb-4">Generate</h3>
        <p className="text-[#A1A1AA] text-sm mb-6">Upload a document to create a cryptographic proof and store it in your wallet.</p>
        <div className="space-y-6">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`rounded-xl border-2 border-dashed p-8 flex items-center gap-4 transition-all ${
              dragOver ? "border-[#7C3AED] bg-[#7C3AED]/10" : "border-white/20 bg-white/5"
            }`}
          >
            <label htmlFor="doc-upload" className="flex-1 min-w-0 flex items-center gap-4 cursor-pointer">
              <input type="file" id="doc-upload" className="hidden" onChange={handleInputChange} accept=".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg" />
              <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-white/10 flex items-center justify-center">
                {file ? <FileText className="w-6 h-6 text-[#7C3AED]" /> : <Upload className="w-6 h-6 text-[#A1A1AA]" />}
              </div>
              <div className="flex-1 min-w-0">
                {file ? (
                  <>
                    <p className="text-white font-medium truncate">{file.name}</p>
                    <p className="text-[#A1A1AA] text-sm">{isProcessing ? "Generating hash…" : hash ? `${file.size} bytes` : ""}</p>
                  </>
                ) : (
                  <p className="text-[#A1A1AA]"><span className="text-white/80">Enter document</span> — Drag & drop or click to upload</p>
                )}
              </div>
            </label>
            {file && (
              <button type="button" onClick={() => setPreviewFile((p) => (p ? null : file))} className="flex-shrink-0 w-10 h-10 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center text-[#A1A1AA] hover:text-white" title="Preview">
                {previewFile ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            )}
          </div>

          {file && hash && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded-xl border border-white/10 bg-white/5 p-6">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <Fingerprint className="w-5 h-5 text-[#7C3AED]" />
                  <span className="text-sm font-medium text-white">Cryptographic proof</span>
                </div>
                <button onClick={() => copyHash(hash, "generate")} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-[#A1A1AA] hover:text-white hover:bg-white/10">
                  {copiedId === "generate" ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
                  {copiedId === "generate" ? "Copied!" : "Copy code"}
                </button>
              </div>
              <p className="text-[#A1A1AA] text-sm font-mono break-all mb-4">{hash}</p>
              <button onClick={addToWallet} className="px-6 py-2.5 rounded-lg font-semibold text-white bg-gradient-to-r from-[#7C3AED] to-[#2563EB] hover:shadow-[0_0_20px_rgba(124,58,237,0.4)]">
                Store in Wallet
              </button>
            </motion.div>
          )}
        </div>
      </motion.section>

      <motion.section id="wallet-proof" initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
        <h3 className="text-xl font-semibold text-white mb-4">Proof Given</h3>
        <p className="text-[#A1A1AA] text-sm mb-6">Stored cryptographic proofs. Use the eye icon to preview documents.</p>
        {proofs.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-white/5 p-12 text-center">
            <Lock className="w-12 h-12 text-[#A1A1AA]/50 mx-auto mb-4" />
            <p className="text-[#A1A1AA]">No proofs stored yet</p>
            <p className="text-[#A1A1AA]/70 text-sm mt-1">Upload a document in Generate above</p>
          </div>
        ) : (
          <div className="space-y-3">
            {proofs.map((p) => (
              <motion.div key={p.id} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-4 p-4 rounded-xl border border-white/10 bg-white/5 hover:bg-white/[0.07]">
                <FileText className="w-8 h-8 text-[#7C3AED] flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-white font-medium truncate">{p.fileName}</p>
                  <p className="text-[#A1A1AA] text-xs font-mono break-all">{p.hash}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => copyHash(p.hash, p.id)} className="p-2 rounded-lg hover:bg-white/10 text-[#A1A1AA] hover:text-white" title="Copy">
                    {copiedId === p.id ? <Check className="w-5 h-5 text-green-400" /> : <Copy className="w-5 h-5" />}
                  </button>
                  <button onClick={() => setPreviewFile((prev) => (prev ? null : p.file))} className="p-2 rounded-lg hover:bg-white/10 text-[#A1A1AA] hover:text-white" title="Preview">
                    <Eye className="w-5 h-5" />
                  </button>
                  <button onClick={() => removeProof(p.id)} className="p-2 rounded-lg hover:bg-red-500/20 text-[#A1A1AA] hover:text-red-400" title="Remove">
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </motion.section>

      <AnimatePresence>
        {previewFile && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" onClick={() => setPreviewFile(null)}>
            <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }} onClick={(e) => e.stopPropagation()} className="relative max-w-2xl w-full max-h-[80vh] bg-[#18181B] rounded-xl border border-white/10 overflow-hidden">
              <div className="flex items-center justify-between p-4 border-b border-white/10">
                <span className="text-white font-medium truncate">{previewFile.name}</span>
                <button onClick={() => setPreviewFile(null)} className="p-2 rounded-lg hover:bg-white/10 text-[#A1A1AA] hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-4 overflow-auto max-h-[60vh]">
                {previewFile.type.startsWith("image/") ? (
                  <img src={URL.createObjectURL(previewFile)} alt={previewFile.name} className="max-w-full rounded-lg" />
                ) : previewFile.type === "application/pdf" ? (
                  <iframe src={URL.createObjectURL(previewFile)} title={previewFile.name} className="w-full h-[50vh] rounded-lg border-0" />
                ) : (
                  <p className="text-[#A1A1AA] text-sm">Preview not available</p>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
