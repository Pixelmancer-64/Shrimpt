import { ERROR_CODES } from "../lib/constants.js";
import { isSessionUnlocked } from "../lib/pin.js";
import { throwCoded } from "./errors.js";

export async function requireUnlock() {
  if (!(await isSessionUnlocked())) {
    throwCoded(ERROR_CODES.LOCKED);
  }
}
