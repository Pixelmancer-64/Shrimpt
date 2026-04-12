import { arrayBufferToBase64, base64ToArrayBuffer, fromUtf8Bytes, sha256Hex, toUtf8Bytes } from "./utils.js";

const RSA_OAEP_CIPHERTEXT_BYTES = 256;
const RSA_PSS_SIGNATURE_BYTES = 256;
const IV_BYTES = 12;
/** Legacy: IV + single RSA-OAEP wrapped AES key (recipient only). */
const LEGACY_ENVELOPE_PREFIX_BYTES = IV_BYTES + RSA_OAEP_CIPHERTEXT_BYTES;
/** Current: IV + RSA wrap for recipient + RSA wrap for sender (so senders can read their own ciphertext). */
const DUAL_ENVELOPE_PREFIX_BYTES = IV_BYTES + 2 * RSA_OAEP_CIPHERTEXT_BYTES;

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
 * AES key is RSA-wrapped for the recipient and for the sender so both can decrypt later.
 */
export async function encryptTextForRecipient({
  plaintext,
  recipientEncryptionPublicJwk,
  senderEncryptionPublicJwk,
  senderSigningPrivateJwk,
  senderProfileId
}) {
  const inner = JSON.stringify({ i: senderProfileId, t: plaintext });
  const aesKey = await crypto.subtle.generateKey(AES_ALGO, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    toUtf8Bytes(inner)
  );

  const rawAesKey = await crypto.subtle.exportKey("raw", aesKey);
  const recipientPublicKey = await importRsaPublicEncryptionKey(recipientEncryptionPublicJwk);
  const senderPublicKey = await importRsaPublicEncryptionKey(senderEncryptionPublicJwk);

  const wrappedForRecipient = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    recipientPublicKey,
    rawAesKey
  );
  const wrappedForSender = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, senderPublicKey, rawAesKey);

  if (
    wrappedForRecipient.byteLength !== RSA_OAEP_CIPHERTEXT_BYTES ||
    wrappedForSender.byteLength !== RSA_OAEP_CIPHERTEXT_BYTES
  ) {
    throw new Error("Unexpected RSA-OAEP ciphertext length.");
  }

  const signedLen = DUAL_ENVELOPE_PREFIX_BYTES + ciphertext.byteLength;
  const signedPart = new Uint8Array(signedLen);
  signedPart.set(iv, 0);
  signedPart.set(new Uint8Array(wrappedForRecipient), IV_BYTES);
  signedPart.set(new Uint8Array(wrappedForSender), IV_BYTES + RSA_OAEP_CIPHERTEXT_BYTES);
  signedPart.set(new Uint8Array(ciphertext), DUAL_ENVELOPE_PREFIX_BYTES);

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
  const minLegacy = LEGACY_ENVELOPE_PREFIX_BYTES + 16 + RSA_PSS_SIGNATURE_BYTES;
  if (view.length < minLegacy) {
    throw new Error("Empty or truncated envelope.");
  }
  return raw;
}

async function tryRsaUnwrap(view, byteStart, byteEnd, privateKey) {
  try {
    return await crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      privateKey,
      view.subarray(byteStart, byteEnd)
    );
  } catch {
    return null;
  }
}

function parseValidatedInner(plaintextBuffer) {
  const innerText = fromUtf8Bytes(new Uint8Array(plaintextBuffer));
  let inner;
  try {
    inner = JSON.parse(innerText);
  } catch {
    return null;
  }
  if (!inner || typeof inner.i !== "string" || typeof inner.t !== "string") {
    return null;
  }
  return inner;
}

async function decryptEnvelopeBuffer(buffer, recipientEncryptionPrivateJwk, signingPublicKeyResolver) {
  const view = new Uint8Array(buffer);
  const minLegacy = LEGACY_ENVELOPE_PREFIX_BYTES + 16 + RSA_PSS_SIGNATURE_BYTES;
  if (view.length < minLegacy) {
    throw new Error("Truncated envelope.");
  }

  const sigStart = view.length - RSA_PSS_SIGNATURE_BYTES;
  const signedPart = view.subarray(0, sigStart);
  const signature = view.subarray(sigStart);

  const iv = view.subarray(0, IV_BYTES);
  const privateKey = await importRsaPrivateEncryptionKey(recipientEncryptionPrivateJwk);

  const decryptAes = async (rawAesKey, ctStart, ctEnd) => {
    const aesKey = await crypto.subtle.importKey(
      "raw",
      rawAesKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    return crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(iv) },
      aesKey,
      view.subarray(ctStart, ctEnd)
    );
  };

  const dualMinCt = 16;
  const hasDualLayout = sigStart >= DUAL_ENVELOPE_PREFIX_BYTES + dualMinCt;

  const tryDecryptAt = async (rawAesKey, aesCtStart) => {
    if (!rawAesKey || sigStart < aesCtStart + dualMinCt) return null;
    try {
      const plaintextBuffer = await decryptAes(rawAesKey, aesCtStart, sigStart);
      const inner = parseValidatedInner(plaintextBuffer);
      if (!inner) return null;
      return { plaintextBuffer, inner };
    } catch {
      return null;
    }
  };

  const rawFirst = await tryRsaUnwrap(view, IV_BYTES, LEGACY_ENVELOPE_PREFIX_BYTES, privateKey);
  const rawSecond = hasDualLayout
    ? await tryRsaUnwrap(view, LEGACY_ENVELOPE_PREFIX_BYTES, DUAL_ENVELOPE_PREFIX_BYTES, privateKey)
    : null;

  let found =
    (await tryDecryptAt(rawFirst, LEGACY_ENVELOPE_PREFIX_BYTES)) ||
    (hasDualLayout ? await tryDecryptAt(rawFirst, DUAL_ENVELOPE_PREFIX_BYTES) : null) ||
    (hasDualLayout ? await tryDecryptAt(rawSecond, DUAL_ENVELOPE_PREFIX_BYTES) : null);

  if (!found) {
    throw new Error("Cannot decrypt envelope.");
  }

  const { inner } = found;

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
