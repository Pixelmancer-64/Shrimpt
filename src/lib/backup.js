/** Full local backup / restore (no backend). */

export const SHRIMPT_BACKUP_VERSION = 1;

/**
 * @param {unknown} backup
 * @returns {asserts backup is object}
 */
export function validateFullBackup(backup) {
  if (!backup || typeof backup !== "object") {
    throw new Error("Invalid backup file.");
  }
  const o = /** @type {Record<string, unknown>} */ (backup);
  const ver = o.uwuBackupVersion ?? o.shrimptBackupVersion;
  if (ver !== SHRIMPT_BACKUP_VERSION) {
    throw new Error("This backup is from a different or unsupported Shrimpt version.");
  }
  const kr = o.keyring;
  if (!kr || typeof kr !== "object") {
    throw new Error("Backup is missing keyring data.");
  }
  const profiles = /** @type {Record<string, unknown>} */ (kr).profiles;
  const contacts = /** @type {Record<string, unknown>} */ (kr).contacts;
  if (!Array.isArray(profiles) || !Array.isArray(contacts)) {
    throw new Error("Backup keyring is malformed.");
  }
  for (const p of profiles) {
    if (!p || typeof p !== "object") throw new Error("A profile entry in the backup is invalid.");
    const pr = /** @type {Record<string, unknown>} */ (p);
    if (
      typeof pr.id !== "string" ||
      !pr.encryptionPrivateJwk ||
      !pr.signingPrivateJwk ||
      !pr.encryptionPublicJwk ||
      !pr.signingPublicJwk
    ) {
      throw new Error("A profile in the backup is missing keys.");
    }
  }
  for (const c of contacts) {
    if (!c || typeof c !== "object") throw new Error("A contact entry in the backup is invalid.");
    const ct = /** @type {Record<string, unknown>} */ (c);
    if (typeof ct.profileId !== "string" || !ct.encryptionPublicJwk || !ct.signingPublicJwk) {
      throw new Error("A contact in the backup is incomplete.");
    }
  }
}
