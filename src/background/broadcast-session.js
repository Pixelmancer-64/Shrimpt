import { MESSAGE_SESSION_UNLOCKED } from "../lib/constants.js";

/**
 * Content scripts do not always receive chrome.storage.session.onChanged; notify tabs explicitly.
 */
export async function broadcastSessionUnlockedToTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs.map((t) =>
        t.id != null
          ? chrome.tabs.sendMessage(t.id, { type: MESSAGE_SESSION_UNLOCKED }).catch(() => {})
          : Promise.resolve()
      )
    );
  } catch (_e) {
    /* ignore */
  }
}
