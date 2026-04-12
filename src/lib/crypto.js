import { arrayBufferToBase64, base64ToArrayBuffer, fromUtf8Bytes, sha256Hex, toUtf8Bytes } from "./utils.js";

const RSA_OAEP_CIPHERTEXT_BYTES = 256;
const RSA_PSS_SIGNATURE_BYTES = 256;
/** 12-byte IV + RSA-2048 wrapped AES key */
const ENVELOPE_PREFIX_BYTES = 12 + RSA_OAEP_CIPHERTEXT_BYTES;

const RSA_ENCRYPTION_ALGO = {
  name: "RSA-OAEP",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256"
};

const RSA_SIGNATURE_ALGO = {
  name: "RSA-PSS",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256"
};

const AES_ALGO = {
  name: "AES-GCM",
  length: 256
};

export async function generateProfileKeys() {
  const encryptionKeyPair = await crypto.subtle.generateKey(
    RSA_ENCRYPTION_ALGO,
    true,
    ["encrypt", "decrypt"]
  );

  const signatureKeyPair = await crypto.subtle.generateKey(
    RSA_SIGNATURE_ALGO,
    true,
    ["sign", "verify"]
  );

  return { encryptionKeyPair, signatureKeyPair };
}

export async function exportKeyPair(profileName, encryptionKeyPair, signatureKeyPair) {
  const encryptionPublicJwk = await crypto.subtle.exportKey("jwk", encryptionKeyPair.publicKey);
  const encryptionPrivateJwk = await crypto.subtle.exportKey("jwk", encryptionKeyPair.privateKey);
  const signingPublicJwk = await crypto.subtle.exportKey("jwk", signatureKeyPair.publicKey);
  const signingPrivateJwk = await crypto.subtle.exportKey("jwk", signatureKeyPair.privateKey);

  const fingerprint = await sha256Hex(JSON.stringify(encryptionPublicJwk));

  return {
    id: `profile_${crypto.randomUUID()}`,
    name: profileName,
    createdAt: new Date().toISOString(),
    fingerprint,
    encryptionPublicJwk,
    encryptionPrivateJwk,
    signingPublicJwk,
    signingPrivateJwk
  };
}

export async function importRsaPublicEncryptionKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["encrypt"]
  );
}

export async function importRsaPrivateEncryptionKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    true,
    ["decrypt"]
  );
}

export async function importRsaPublicSigningKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSA-PSS", hash: "SHA-256" },
    true,
    ["verify"]
  );
}

export async function importRsaPrivateSigningKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSA-PSS", hash: "SHA-256" },
    true,
    ["sign"]
  );
}

/**
 * Hybrid encrypt + sign. Single binary blob, Base64 once.
 * Sender identity only inside AES-GCM plaintext as JSON {"i":profileId,"t":message}.
 */
export async function encryptTextForRecipient({ plaintext, recipientEncryptionPublicJwk, senderSigningPrivateJwk, senderProfileId }) {
  const inner = JSON.stringify({ i: senderProfileId, t: plaintext });
  const aesKey = await crypto.subtle.generateKey(AES_ALGO, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    toUtf8Bytes(inner)
  );

  const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
  const recipientPublicKey = await importRsaPublicEncryptionKey(recipientEncryptionPublicJwk);
  const wrappedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    recipientPublicKey,
    rawAesKey
  );

  if (wrappedKey.byteLength !== RSA_OAEP_CIPHERTEXT_BYTES) {
    throw new Error("Unexpected RSA-OAEP ciphertext length.");
  }

  const signedLen = ENVELOPE_PREFIX_BYTES + ciphertext.byteLength;
  const signedPart = new Uint8Array(signedLen);
  signedPart.set(iv, 0);
  signedPart.set(new Uint8Array(wrappedKey), 12);
  signedPart.set(new Uint8Array(ciphertext), ENVELOPE_PREFIX_BYTES);

  const signingPrivateKey = await importRsaPrivateSigningKey(senderSigningPrivateJwk);
  const signature = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    signingPrivateKey,
    signedPart
  );

  if (signature.byteLength !== RSA_PSS_SIGNATURE_BYTES) {
    throw new Error("Unexpected RSA-PSS signature length.");
  }

  const out = new Uint8Array(signedLen + RSA_PSS_SIGNATURE_BYTES);
  out.set(signedPart, 0);
  out.set(new Uint8Array(signature), signedLen);

  return { compact: arrayBufferToBase64(out.buffer) };
}

export function parseCompactEnvelope(base64Envelope) {
  const raw = base64ToArrayBuffer(base64Envelope);
  const view = new Uint8Array(raw);
  const minLen = ENVELOPE_PREFIX_BYTES + 16 + RSA_PSS_SIGNATURE_BYTES;
  if (view.length < minLen) {
    throw new Error("Empty or truncated envelope.");
  }
  return raw;
}

async function decryptEnvelopeBuffer(buffer, recipientEncryptionPrivateJwk, signingPublicKeyResolver) {
  const view = new Uint8Array(buffer);
  const minLen = ENVELOPE_PREFIX_BYTES + 16 + RSA_PSS_SIGNATURE_BYTES;
  if (view.length < minLen) {
    throw new Error("Truncated envelope.");
  }

  const sigStart = view.length - RSA_PSS_SIGNATURE_BYTES;
  const signedPart = view.subarray(0, sigStart);
  const signature = view.subarray(sigStart);

  const iv = view.subarray(0, 12);
  const wrappedKey = view.subarray(12, ENVELOPE_PREFIX_BYTES);
  const ciphertext = view.subarray(ENVELOPE_PREFIX_BYTES, sigStart);

  const privateKey = await importRsaPrivateEncryptionKey(recipientEncryptionPrivateJwk);

  const rawAesKey = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    wrappedKey
  );

  const aesKey = await crypto.subtle.importKey(
    "raw",
    rawAesKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  const plaintextBuffer = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(iv)
    },
    aesKey,
    ciphertext
  );

  const innerText = fromUtf8Bytes(new Uint8Array(plaintextBuffer));
  let inner;
  try {
    inner = JSON.parse(innerText);
  } catch {
    throw new Error("Invalid inner payload.");
  }
  if (!inner || typeof inner.i !== "string" || typeof inner.t !== "string") {
    throw new Error("Invalid inner payload shape.");
  }

  const senderSigningPublicJwk = signingPublicKeyResolver(inner.i);
  let verified = false;
  if (senderSigningPublicJwk) {
    const senderPublicKey = await importRsaPublicSigningKey(senderSigningPublicJwk);
    verified = await crypto.subtle.verify(
      { name: "RSA-PSS", saltLength: 32 },
      senderPublicKey,
      signature,
      signedPart
    );
  }

  return {
    plaintext: inner.t,
    verified,
    senderProfileId: inner.i
  };
}

/**
 * @param signingPublicKeyResolver {(profileId: string) => JsonWebKey | null | undefined}
 */
export async function decryptCompactEnvelope({ compactEnvelope, recipientEncryptionPrivateJwk, signingPublicKeyResolver }) {
  const buffer = parseCompactEnvelope(compactEnvelope);
  return decryptEnvelopeBuffer(buffer, recipientEncryptionPrivateJwk, signingPublicKeyResolver);
}
