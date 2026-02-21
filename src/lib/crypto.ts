/**
 * Cryptographic utilities for Sahayak emergency packet signing.
 * Uses the browser-native Web Crypto API exclusively (SubtleCrypto).
 *
 * Algorithm: RSA-PSS with SHA-256
 *   - 2048-bit modulus for strong security at reasonable performance
 *   - saltLength: 32 bytes (recommended for PSS)
 *   - Keys are generated fresh for every trip and kept only in memory
 */

const KEY_ALGORITHM: RsaHashedKeyGenParams = {
  name: "RSA-PSS",
  modulusLength: 2048,
  publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
  hash: "SHA-256",
}

const SIGN_PARAMS: RsaPssParams = { name: "RSA-PSS", saltLength: 32 }

function bufToBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

function base64ToBuf(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

function objectToBytes(obj: object): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj))
}

/** Generate a fresh RSA-PSS key pair. Call once per trip — never persist the private key. */
export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"])
}

/** Sign a plain JS object with the given private key. Returns base64-encoded RSA-PSS signature. */
export async function signPayload(privateKey: CryptoKey, payload: object): Promise<string> {
  const data = objectToBytes(payload)
  const sig = await crypto.subtle.sign(SIGN_PARAMS, privateKey, data)
  return bufToBase64(sig)
}

/** Export a CryptoKey (public) to a base64-encoded SPKI string suitable for wire transport. */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  const exported = await crypto.subtle.exportKey("spki", key)
  return bufToBase64(exported)
}

/** Import a base64-encoded SPKI public key back into a CryptoKey for verification. */
export async function importPublicKey(base64: string): Promise<CryptoKey> {
  const keyBytes = base64ToBuf(base64)
  return crypto.subtle.importKey("spki", keyBytes, KEY_ALGORITHM, false, ["verify"])
}

/**
 * Verify that signatureBase64 was produced by signing payload with the matching private key.
 * Returns true → authentic and unmodified. Returns false → tampered or wrong key.
 */
export async function verifyPayload(
  publicKeyBase64: string,
  payload: object,
  signatureBase64: string
): Promise<boolean> {
  try {
    const publicKey = await importPublicKey(publicKeyBase64)
    const sigBytes = base64ToBuf(signatureBase64)
    const data = objectToBytes(payload)
    return await crypto.subtle.verify(SIGN_PARAMS, publicKey, sigBytes, data)
  } catch {
    return false
  }
}
