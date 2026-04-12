export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export function toUtf8Bytes(text) {
  return new TextEncoder().encode(text);
}

export function fromUtf8Bytes(bytes) {
  return new TextDecoder().decode(bytes);
}

export function randomId(prefix = "id") {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}_${rand[0].toString(16)}${rand[1].toString(16)}`;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function clampString(text, max) {
  if (typeof text !== "string") return "";
  return text.length > max ? text.slice(0, max) : text;
}