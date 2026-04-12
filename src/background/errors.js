import { ERROR_CODES } from "../lib/constants.js";

export { ERROR_CODES };

export function throwCoded(code, message = code) {
  const err = new Error(message);
  err.code = code;
  throw err;
}
