import { MARKER_PREFIX, MARKER_SUFFIX } from "./constants.js";

export function wrapEnvelope(compactBase64) {
  return `${MARKER_PREFIX}${compactBase64}${MARKER_SUFFIX}`;
}

export function unwrapEnvelopeString(text) {
  if (!text || typeof text !== "string") return null;
  const start = text.indexOf(MARKER_PREFIX);
  if (start === -1) return null;

  const payloadStart = start + MARKER_PREFIX.length;
  const end = text.indexOf(MARKER_SUFFIX, payloadStart);
  if (end === -1) return null;

  return {
    start,
    end: end + MARKER_SUFFIX.length,
    payload: text.slice(payloadStart, end)
  };
}

export function findEnvelopeMatches(text) {
  if (!text || typeof text !== "string") return [];
  const matches = [];
  let cursor = 0;

  while (cursor < text.length) {
    const start = text.indexOf(MARKER_PREFIX, cursor);
    if (start === -1) break;
    const payloadStart = start + MARKER_PREFIX.length;
    const end = text.indexOf(MARKER_SUFFIX, payloadStart);
    if (end === -1) break;

    matches.push({
      start,
      end: end + MARKER_SUFFIX.length,
      payload: text.slice(payloadStart, end)
    });

    cursor = end + MARKER_SUFFIX.length;
  }

  return matches;
}