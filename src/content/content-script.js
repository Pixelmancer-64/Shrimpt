/**
 * Shrimpt — content script (classic script; content scripts are not modules in all browsers).
 * Keep in sync with src/lib/constants.js (MARKER_*) and src/lib/encoding.js.
 */
const MARKER_PREFIX = "!shpt!";
const MARKER_SUFFIX = "!shpt!";

const STORAGE_KEYS = {
  SETTINGS: "settings",
  ACTIVE_PROFILE_ID: "activeProfileId"
};

/** Must match SESSION_UNLOCK_KEY in src/lib/pin.js */
const SESSION_UNLOCK_KEY = "shrimptUnlocked";

const DEFAULT_SETTINGS = {
  autoDecrypt: true,
  clickToReveal: false,
  observerDebounceMs: 250,
  scanTextLimit: 120000,
  selectedRecipientContactId: null
};

/** Must match MESSAGE_SESSION_UNLOCKED in src/lib/constants.js */
const MESSAGE_SESSION_UNLOCKED = "SHRIMPT_SESSION_UNLOCKED";

const MESSAGE_TYPES = {
  GET_SETTINGS: "GET_SETTINGS",
  DECRYPT_ENVELOPE: "DECRYPT_ENVELOPE",
  ENCRYPT_TEXT: "ENCRYPT_TEXT",
  UPDATE_SETTINGS: "UPDATE_SETTINGS",
  LIST_PROFILES: "LIST_PROFILES",
  LIST_CONTACTS: "LIST_CONTACTS",
  SET_ACTIVE_PROFILE: "SET_ACTIVE_PROFILE"
};

/**
 * Content-script debug logs (page DevTools console). Silence with:
 *   window.__SHRIMPT_DEBUG__ = false
 * (set before navigation, or run and reload the tab).
 */
function shrimptDebugEnabled() {
  try {
    if (typeof window !== "undefined" && window.__SHRIMPT_DEBUG__ === false) return false;
  } catch (_e) {
    /* cross-origin isolated or no window */
  }
  return true;
}

function shrimptLog(scope, ...args) {
  if (!shrimptDebugEnabled()) return;
  console.log(`[Shrimpt:${scope}]`, ...args);
}

function findEnvelopeMatches(text) {
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

/** Strip whitespace / invisible chars editors insert so base64 decodes reliably. */
function normalizeCompactPayload(raw) {
  return String(raw ?? "").replace(/[\s\u00a0\u200b\uFEFF]+/g, "");
}

function wrapEnvelopeCompact(compact) {
  return MARKER_PREFIX + compact + MARKER_SUFFIX;
}

const processedNodes = new WeakSet();
let observer = null;
let debounceTimer = null;
let settingsCache = null;
/** True if bootstrap fell back to DEFAULT_SETTINGS (retry when background is up). */
let settingsFallback = false;
let scanGeneration = 0;
let fieldBinding = null;
let fieldAutoBindTimer = null;
let fieldAutoBindGen = 0;

bootstrap().catch(console.error);

async function bootstrap() {
  try {
    settingsCache = await request(MESSAGE_TYPES.GET_SETTINGS);
    settingsFallback = false;
  } catch (err) {
    console.warn("[Shrimpt] GET_SETTINGS failed; using defaults until background is ready.", err);
    settingsCache = { ...DEFAULT_SETTINGS };
    settingsFallback = true;
  }
  shrimptLog("boot", "bootstrap", {
    href: typeof location !== "undefined" ? location.href : "",
    settingsFallback,
    autoDecrypt: settingsCache?.autoDecrypt,
    clickToReveal: settingsCache?.clickToReveal,
    scanTextLimit: settingsCache?.scanTextLimit,
    observerDebounceMs: settingsCache?.observerDebounceMs,
    runtimeId: typeof chrome !== "undefined" && chrome.runtime?.id ? chrome.runtime.id : null
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      const profileChanged = Boolean(changes[STORAGE_KEYS.ACTIVE_PROFILE_ID]);
      const settingsChanged = Boolean(changes[STORAGE_KEYS.SETTINGS]);
      if (profileChanged || settingsChanged) {
        onIdentityOrConversationStorageChanged().catch(console.error);
      }
    }
    if (area === "session") {
      const unlock = changes[SESSION_UNLOCK_KEY];
      if (unlock?.newValue === true) {
        refreshEnvelopesAfterSessionUnlock().catch(console.error);
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === MESSAGE_SESSION_UNLOCKED) {
      shrimptLog("boot", "session unlock message from background; refreshing envelopes");
      refreshEnvelopesAfterSessionUnlock().catch(console.error);
    }
  });

  await rescanPage();
  startObserver();
  scheduleLateRescans();
  startFieldEncryptFocusCapture();
  scheduleFieldAutoBind();
}

async function onIdentityOrConversationStorageChanged() {
  settingsCache = await request(MESSAGE_TYPES.GET_SETTINGS);
  scheduleFieldAutoBind();
  const wrappers = [...document.querySelectorAll("[data-shrimpt-compact]")];
  shrimptLog("boot", "identity/settings storage changed; rebuilding envelopes", { count: wrappers.length });
  for (const w of wrappers) {
    await rebuildEnvelopeWrapper(w);
  }
  scheduleRescan();
}

async function rebuildEnvelopeWrapper(wrapper) {
  const compact = wrapper.getAttribute("data-shrimpt-compact");
  if (!compact) return;
  const parent = wrapper.parentNode;
  if (!parent) return;
  const fresh = await buildDecryptedNode(compact);
  parent.replaceChild(fresh, wrapper);
}

/** After popup/options unlock, retry decrypt on chips that showed "Extension locked…". */
async function refreshEnvelopesAfterSessionUnlock() {
  try {
    settingsCache = await request(MESSAGE_TYPES.GET_SETTINGS);
  } catch (_e) {
    /* keep cached settings */
  }
  const wrappers = [...document.querySelectorAll("[data-shrimpt-compact]")];
  shrimptLog("boot", "session unlocked; rebuilding envelope chips", { count: wrappers.length });
  for (const w of wrappers) {
    if (!w.isConnected) continue;
    await rebuildEnvelopeWrapper(w);
  }
  await rescanPage();
}

function startObserver() {
  observer = new MutationObserver(() => scheduleRescan());

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: false
  });
}

/** SPAs and lazy content often mount after the first idle scan. */
function scheduleLateRescans() {
  const run = () => rescanPage().catch(console.error);
  setTimeout(run, 400);
  setTimeout(run, 1600);
  setTimeout(async () => {
    if (!settingsFallback) return;
    try {
      settingsCache = await request(MESSAGE_TYPES.GET_SETTINGS);
      settingsFallback = false;
      shrimptLog("boot", "late GET_SETTINGS succeeded; rescanning");
      await rescanPage();
    } catch (_e) {
      shrimptLog("boot", "late GET_SETTINGS still failing; keeping defaults");
    }
  }, 1200);
}

function scheduleRescan() {
  if (debounceTimer) clearTimeout(debounceTimer);
  const ms = settingsCache?.observerDebounceMs ?? 250;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    rescanPage().catch(console.error);
  }, ms);
}

function scanTextLimit() {
  return settingsCache?.scanTextLimit ?? 120000;
}

function acceptEligibleTextNode(node) {
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  const text = node.nodeValue || "";
  if (text.length > scanTextLimit()) return false;
  if (!text.trim()) return false;
  const parent = node.parentElement;
  if (!parent) return false;
  if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(parent.tagName)) return false;
  if (parent.closest("[data-shrimpt-compact]")) return false;
  return true;
}

/**
 * Browsers and editors often split one logical string into adjacent TEXT_NODE siblings.
 * Envelopes must be matched on the merged run, then we replace the whole run at once.
 */
function expandForwardTextRun(startNode) {
  const nodes = [];
  let combined = "";
  const limit = scanTextLimit();
  let cur = startNode;

  while (cur && cur.nodeType === Node.TEXT_NODE) {
    const chunk = cur.nodeValue || "";
    if (combined.length + chunk.length > limit) {
      break;
    }
    combined += chunk;
    nodes.push(cur);
    cur = cur.nextSibling;
  }

  return { nodes, combined };
}

function collectEligibleTextNodes(root) {
  const out = [];
  if (!root) return out;

  function visit(node) {
    if (!node) return;

    if (node.nodeType === Node.TEXT_NODE) {
      if (acceptEligibleTextNode(node)) {
        out.push(node);
      }
      return;
    }

    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      for (const child of node.childNodes) {
        visit(child);
      }
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const el = /** @type {Element} */ (node);
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
      return;
    }

    if (tag === "TEMPLATE") {
      const tmpl = /** @type {HTMLTemplateElement} */ (el);
      if (tmpl.content) {
        visit(tmpl.content);
      }
      return;
    }

    for (const child of el.childNodes) {
      visit(child);
    }

    if (el.shadowRoot) {
      visit(el.shadowRoot);
    }
  }

  visit(root);
  return out;
}

async function rescanPage() {
  const gen = ++scanGeneration;
  const root = document.body;
  if (!root) {
    shrimptLog("scan", "rescan skipped (no document.body yet)");
    return;
  }

  const snapshot = collectEligibleTextNodes(root);
  shrimptLog("scan", "rescan start", {
    gen,
    eligibleTextNodes: snapshot.length,
    href: location.href?.slice(0, 200)
  });

  const markerNodes = snapshot.filter((n) => {
    const t = n.nodeValue || "";
    if (!t.includes(MARKER_PREFIX)) return false;
    const { combined } = expandForwardTextRun(n);
    return findEnvelopeMatches(combined).length > 0;
  });

  for (const node of markerNodes) {
    if (gen !== scanGeneration) {
      shrimptLog("scan", "rescan superseded during marker processing", { gen, latestGen: scanGeneration });
      return;
    }
    await processTextNode(node);
  }

  if (gen !== scanGeneration) {
    shrimptLog("scan", "rescan superseded before final log", { gen, latestGen: scanGeneration });
    return;
  }

  const ciphertextBlocks = document.querySelectorAll("[data-shrimpt-compact]").length;

  shrimptLog("scan", "rescan done", {
    gen,
    markerJobsQueued: markerNodes.length,
    ciphertextWrappers: ciphertextBlocks
  });
}

async function processTextNode(textNode) {
  if (!textNode || !textNode.isConnected || processedNodes.has(textNode)) return;
  if (!acceptEligibleTextNode(textNode)) return;

  const { nodes, combined } = expandForwardTextRun(textNode);
  if (!combined.includes(MARKER_PREFIX)) return;

  const matches = findEnvelopeMatches(combined);
  if (!matches.length) {
    shrimptLog("scan", "prefix in run but no complete envelope (check closing marker / sibling splits)", {
      runLength: combined.length,
      siblingTextNodes: nodes.length,
      preview: combined.slice(0, 100).replace(/\s+/g, " ")
    });
    return;
  }

  shrimptLog("scan", "replacing text run with envelope chip(s)", {
    envelopes: matches.length,
    runLength: combined.length,
    siblingTextNodes: nodes.length,
    payloadLens: matches.map((m) => m.payload?.length ?? 0)
  });

  for (const n of nodes) {
    processedNodes.add(n);
  }

  try {
    const fragment = document.createDocumentFragment();
    let cursor = 0;

    for (const match of matches) {
      if (match.start > cursor) {
        fragment.appendChild(document.createTextNode(combined.slice(cursor, match.start)));
      }
      fragment.appendChild(await buildDecryptedNode(normalizeCompactPayload(match.payload)));
      cursor = match.end;
    }

    if (cursor < combined.length) {
      fragment.appendChild(document.createTextNode(combined.slice(cursor)));
    }

    const parent = nodes[0].parentNode;
    if (!parent) {
      for (const n of nodes) {
        processedNodes.delete(n);
      }
      return;
    }

    parent.insertBefore(fragment, nodes[0]);
    for (const n of nodes) {
      if (n.parentNode === parent) {
        parent.removeChild(n);
      }
    }
  } catch (err) {
    for (const n of nodes) {
      processedNodes.delete(n);
    }
    console.error("[Shrimpt] processTextNode", err);
    shrimptLog("scan", "processTextNode threw", { message: err?.message, name: err?.name });
  }
}

/** Cached CSS for closed shadow (chip + plaintext live inside shadow; page JS cannot read tree) */
let envelopeShadowCssCache = null;

async function getEnvelopeShadowCss() {
  if (envelopeShadowCssCache) return envelopeShadowCssCache;
  const url = chrome.runtime.getURL("src/content/envelope-shadow.css");
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not load envelope styles.");
  envelopeShadowCssCache = await res.text();
  return envelopeShadowCssCache;
}

/** Crypto / format failure (not LOCKED). Pre-dual-wrap envelopes only decrypt with the recipient's keys. */
const DECRYPT_FAILED_MESSAGE =
  "Could not decrypt. Unlock Shrimpt, confirm the active profile matches a recipient or sender key for this message, and try again.";

async function buildDecryptedNode(compactEnvelope) {
  const compact = normalizeCompactPayload(compactEnvelope);
  const host = document.createElement("span");
  host.dataset.shrimptCompact = compact;
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = await getEnvelopeShadowCss();
  shadow.appendChild(style);

  const inner = document.createElement("span");
  inner.className = "shrimpt-envelope-inner";

  const reveal = document.createElement("span");
  reveal.className = "shrimpt-envelope-reveal";
  reveal.hidden = true;
  reveal.textContent = "Decrypting...";

  inner.appendChild(reveal);
  shadow.appendChild(inner);

  if (!settingsCache?.autoDecrypt) {
    shrimptLog("decrypt", "chip: autoDecrypt off — decrypt on click", { compactLen: compact.length });
    reveal.textContent = "[Shrimpt — click to decrypt]";
    reveal.hidden = false;
    inner.style.cursor = "pointer";
    inner.addEventListener("click", async () => {
      inner.style.cursor = "";
      await revealMessage(compact, reveal, { forPageScan: false });
    });
    return host;
  }

  try {
    shrimptLog("decrypt", "DECRYPT_ENVELOPE (page scan)", {
      compactLen: compact.length,
      forPageScan: true
    });
    const result = await request(MESSAGE_TYPES.DECRYPT_ENVELOPE, {
      compactEnvelope: compact,
      forPageScan: true
    });
    const ok = applyDecryptResultToUi(result, reveal);
    shrimptLog("decrypt", "decrypt result (auto)", {
      ok,
      skipped: result?.skipped,
      code: result?.code,
      verified: result?.verified,
      conversationMismatch: result?.conversationMismatch,
      plaintextLen: (result?.plaintext ?? "").length
    });
    return host;
  } catch (error) {
    const locked = error?.message === "LOCKED";
    shrimptLog("decrypt", "decrypt failed (auto)", { message: error?.message, locked });
    if (locked) {
      reveal.textContent = "Extension locked — open the Shrimpt popup and enter your unlock secret.";
    } else {
      reveal.textContent = DECRYPT_FAILED_MESSAGE;
    }
    reveal.hidden = false;
    return host;
  }
}

function applyDecryptResultToUi(result, reveal) {
  if (result?.skipped && result.code === "WRONG_CONVERSATION") {
    shrimptLog("decrypt", "UI: wrong conversation (skipped)", { code: result.code });
    reveal.textContent =
      "This message was not sent by the contact selected as Them in Shrimpt. Pick Anyone or the right person in the popup.";
    reveal.hidden = false;
    return false;
  }
  reveal.textContent = result.plaintext ?? "";
  reveal.dataset.verified = String(result.verified);
  if (result?.conversationMismatch) {
    reveal.title =
      "Sender does not match Them (Anyone or change Them in the popup). Plaintext is shown so you can still read on the page.";
  } else {
    reveal.removeAttribute("title");
  }
  reveal.hidden = false;
  return true;
}

async function revealMessage(compactEnvelope, reveal, options = {}) {
  const { forPageScan = false } = options;
  const compact = normalizeCompactPayload(compactEnvelope);
  shrimptLog("decrypt", "revealMessage (user)", { forPageScan, compactLen: compact.length });
  try {
    const result = await request(MESSAGE_TYPES.DECRYPT_ENVELOPE, {
      compactEnvelope: compact,
      forPageScan
    });
    applyDecryptResultToUi(result, reveal);
    shrimptLog("decrypt", "revealMessage ok", {
      skipped: result?.skipped,
      code: result?.code,
      verified: result?.verified,
      conversationMismatch: result?.conversationMismatch,
      plaintextLen: (result?.plaintext ?? "").length
    });
  } catch (error) {
    const locked = error?.message === "LOCKED";
    shrimptLog("decrypt", "revealMessage error", { message: error?.message, locked });
    if (locked) {
      reveal.textContent = "Extension locked — open the Shrimpt popup and enter your unlock secret.";
    } else {
      reveal.textContent = DECRYPT_FAILED_MESSAGE;
    }
    reveal.hidden = false;
  }
}

/* ─────────── Field encrypt tooltip ─────────── */

let encryptTooltipShadowCssCache = null;

async function getEncryptTooltipShadowCss() {
  if (encryptTooltipShadowCssCache) return encryptTooltipShadowCssCache;
  const url = chrome.runtime.getURL("src/content/encrypt-tooltip-shadow.css");
  const res = await fetch(url);
  if (!res.ok) throw new Error("Could not load encrypt tooltip styles.");
  encryptTooltipShadowCssCache = await res.text();
  return encryptTooltipShadowCssCache;
}

function isShrimptChromeTree(node) {
  if (!node) return false;
  let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!el?.closest) return false;
  if (el.closest(".shrimpt-field-encrypt-tooltip-host")) return true;
  const root = el.getRootNode();
  if (root instanceof ShadowRoot) {
    const host = root.host;
    if (host?.matches?.(".shrimpt-field-encrypt-tooltip-host")) return true;
  }
  return false;
}

function getContentEditableHost(fromEl) {
  if (!fromEl) return null;
  let n = fromEl;
  if (n.nodeType === Node.TEXT_NODE) n = n.parentElement;
  if (!n || n.nodeType !== Node.ELEMENT_NODE) return null;
  while (n && n !== document.documentElement) {
    if (isShrimptChromeTree(n)) return null;
    const v = n.getAttribute("contenteditable");
    if (v === "true" || v === "" || v === "plaintext-only") {
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(n.tagName)) return null;
      return n;
    }
    if (v === "false") {
      n = n.parentElement;
      continue;
    }
    n = n.parentElement;
  }
  return null;
}

function getContentEditableHostFromSelection() {
  const sel = document.getSelection?.();
  if (!sel?.rangeCount) return null;
  const r = sel.getRangeAt(0);
  let node = r.commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
  return getContentEditableHost(node);
}

function fieldKind(el) {
  if (!el) return "value";
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return "value";
  return "contenteditable";
}

function getFieldPlain(el, kind) {
  if (kind === "value") return el.value || "";
  return (el.innerText ?? el.textContent ?? "").replace(/\r\n/g, "\n");
}

function setNativeFormControlValue(el, text) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc?.set) {
    desc.set.call(el, text);
  } else {
    el.value = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function setFieldPlain(el, kind, text) {
  if (kind === "value") {
    setNativeFormControlValue(el, text);
    return;
  }
  replaceContentEditableWhole(el, text);
}

function setFieldWrappedCipher(el, kind, wrapped) {
  setFieldPlain(el, kind, wrapped);
}

function rangeFullyInsideHost(range, hostEl) {
  if (!range || !hostEl) return false;
  try {
    return hostEl.contains(range.startContainer) && hostEl.contains(range.endContainer);
  } catch (_e) {
    return false;
  }
}

function firstDeepTextNode(root) {
  if (!root) return null;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  return w.nextNode();
}

function lastDeepTextNode(root) {
  if (!root) return null;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last = null;
  let n;
  while ((n = w.nextNode())) last = n;
  return last;
}

function collectEditableTextNodes(host) {
  const out = [];
  const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    let p = n.parentElement;
    let skip = false;
    while (p && p !== host) {
      if (isShrimptChromeTree(p) || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(p.tagName)) {
        skip = true;
        break;
      }
      p = p.parentElement;
    }
    if (!skip) out.push(n);
  }
  return out;
}

function isLexicalEditorContentHost(host) {
  return host?.getAttribute?.("data-lexical-editor") != null;
}

function replaceLexicalEditorHostContent(host, wrapped) {
  let block = host.querySelector(":scope > p");
  if (!block) block = host.firstElementChild;
  if (!block) {
    const p = document.createElement("p");
    p.appendChild(document.createTextNode(wrapped));
    host.replaceChildren(p);
    return;
  }
  block.replaceChildren(document.createTextNode(wrapped));
  for (const n of [...host.childNodes]) {
    if (n !== block) n.remove();
  }
}

function replaceLexicalEmptyPlaceholder(host) {
  let block = host.querySelector(":scope > p");
  if (!block) block = host.firstElementChild;
  if (!block) {
    const p = document.createElement("p");
    p.appendChild(document.createElement("br"));
    host.replaceChildren(p);
    return;
  }
  block.replaceChildren();
  block.appendChild(document.createElement("br"));
  for (const n of [...host.childNodes]) {
    if (n !== block) n.remove();
  }
}

function replaceContentEditableWhole(host, wrapped) {
  if (!host) return;
  const lexical = isLexicalEditorContentHost(host);

  if (!wrapped) {
    if (lexical) {
      replaceLexicalEmptyPlaceholder(host);
    } else {
      host.textContent = "";
    }
    host.dispatchEvent(new Event("input", { bubbles: true }));
    try { host.focus(); } catch (_e) { /* ignore */ }
    return;
  }

  if (lexical) {
    replaceLexicalEditorHostContent(host, wrapped);
  } else {
    const texts = collectEditableTextNodes(host).filter((t) => (t.nodeValue || "").length > 0);
    if (texts.length === 1) {
      texts[0].data = wrapped;
    } else if (texts.length > 1) {
      const r = document.createRange();
      r.setStart(texts[0], 0);
      const last = texts[texts.length - 1];
      r.setEnd(last, last.nodeValue.length);
      r.deleteContents();
      const tn = document.createTextNode(wrapped);
      r.insertNode(tn);
      r.setStartAfter(tn);
      r.collapse(true);
      const sel = document.getSelection?.();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(r);
      }
    } else {
      const first = host.firstElementChild;
      if (first) {
        first.replaceChildren(document.createTextNode(wrapped));
        for (const n of [...host.childNodes]) {
          if (n !== first) n.remove();
        }
      } else {
        host.textContent = wrapped;
      }
    }
  }

  host.dispatchEvent(new Event("input", { bubbles: true }));
  try { host.focus(); } catch (_e) { /* ignore */ }
}

function textNodeRunFromCollapsedCaret(host, live, sel) {
  if (!live.collapsed || !rangeFullyInsideHost(live, host) || !sel) return null;
  const an = sel.anchorNode;
  const off = sel.anchorOffset;

  const pack = (tn) => {
    if (!tn || tn.nodeType !== Node.TEXT_NODE || !host.contains(tn)) return null;
    const raw = tn.nodeValue ?? "";
    if (!raw.length) return null;
    const range = document.createRange();
    range.selectNodeContents(tn);
    return { plain: raw.replace(/\r\n/g, "\n"), range: range.cloneRange() };
  };

  if (an.nodeType === Node.TEXT_NODE) return pack(an);

  if (an.nodeType === Node.ELEMENT_NODE && host.contains(an)) {
    if (off < an.childNodes.length) {
      const next = an.childNodes[off];
      let hit = pack(next);
      if (!hit && next?.nodeType === Node.ELEMENT_NODE) hit = pack(firstDeepTextNode(next));
      if (hit) return hit;
    }
    if (off > 0) {
      const prev = an.childNodes[off - 1];
      let hit = pack(prev);
      if (!hit && prev?.nodeType === Node.ELEMENT_NODE) hit = pack(lastDeepTextNode(prev));
      if (hit) return hit;
    }
  }
  return null;
}

function getEncryptReplaceSpec(el, kind) {
  if (kind === "value") {
    const v = el.value ?? "";
    let a = typeof el.selectionStart === "number" ? el.selectionStart : 0;
    let b = typeof el.selectionEnd === "number" ? el.selectionEnd : 0;
    if (a > b) { const t = a; a = b; b = t; }
    if (b > a) {
      return {
        plain: v.slice(a, b).replace(/\r\n/g, "\n"),
        spec: { mode: "value_slice", start: a, end: b }
      };
    }
    return {
      plain: v.replace(/\r\n/g, "\n"),
      spec: { mode: "value_all" }
    };
  }

  const host = el;
  const sel = document.getSelection?.();
  if (sel && sel.rangeCount > 0) {
    const live = sel.getRangeAt(0);
    if (rangeFullyInsideHost(live, host)) {
      if (!live.collapsed) {
        const plain = live.toString().replace(/\r\n/g, "\n");
        return { plain, spec: { mode: "ce_range", range: live.cloneRange() } };
      }
      const run = textNodeRunFromCollapsedCaret(host, live, sel);
      if (run) {
        return { plain: run.plain, spec: { mode: "ce_text_node", range: run.range } };
      }
    }
  }

  const all = (host.innerText ?? host.textContent ?? "").replace(/\r\n/g, "\n");
  return { plain: all, spec: { mode: "ce_all" } };
}

function applyWrappedCiphertextWithSpec(el, kind, wrapped, spec) {
  if (kind === "value") {
    if (spec.mode === "value_slice" && typeof spec.start === "number" && typeof spec.end === "number") {
      const v = el.value ?? "";
      const out = v.slice(0, spec.start) + wrapped + v.slice(spec.end);
      setNativeFormControlValue(el, out);
      const caret = spec.start + wrapped.length;
      try { el.selectionStart = el.selectionEnd = caret; } catch (_e) { /* read-only selection */ }
      return;
    }
    setNativeFormControlValue(el, wrapped);
    return;
  }

  if (spec.mode === "ce_range" && spec.range) {
    const range = spec.range;
    if (
      !range.startContainer?.isConnected ||
      !el.contains(range.startContainer) ||
      !el.contains(range.endContainer)
    ) {
      replaceContentEditableWhole(el, wrapped);
      return;
    }
    range.deleteContents();
    const tn = document.createTextNode(wrapped);
    range.insertNode(tn);
    range.setStartAfter(tn);
    range.collapse(true);
    const sel = document.getSelection?.();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    try { el.focus(); } catch (_e) { /* ignore */ }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  if (spec.mode === "ce_text_node" && spec.range) {
    const tn = spec.range.startContainer;
    if (tn?.nodeType === Node.TEXT_NODE && tn.isConnected && el.contains(tn)) {
      tn.replaceData(0, tn.length, wrapped);
      const sel = document.getSelection?.();
      if (sel) {
        const nr = document.createRange();
        const end = Math.min(wrapped.length, tn.length);
        nr.setStart(tn, end);
        nr.collapse(true);
        sel.removeAllRanges();
        sel.addRange(nr);
      }
      try { el.focus(); } catch (_e) { /* ignore */ }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    replaceContentEditableWhole(el, wrapped);
    return;
  }

  replaceContentEditableWhole(el, wrapped);
}

function resolveProtectableField(focusEl) {
  const explicitTarget = focusEl != null;
  let el = explicitTarget ? focusEl : document.activeElement;
  if (el?.nodeType === Node.TEXT_NODE) {
    const ce = getContentEditableHost(el);
    if (ce) return ce;
    el = el.parentElement;
  }
  if (!el || el.nodeType !== Node.ELEMENT_NODE) {
    return getContentEditableHostFromSelection();
  }
  if (isShrimptChromeTree(el)) return null;

  const tag = el.tagName;
  if (tag === "TEXTAREA") return !el.disabled && !el.readOnly ? el : null;
  if (tag === "INPUT") {
    const t = (el.type || "text").toLowerCase();
    if (!["text", "search", "email", "url", "tel"].includes(t) || el.disabled || el.readOnly) return null;
    return el;
  }
  const ce = getContentEditableHost(el);
  if (ce) return ce;

  if (explicitTarget) return null;
  if (el === document.body || el === document.documentElement) {
    return getContentEditableHostFromSelection();
  }
  return null;
}

function detachFieldBinding() {
  if (!fieldBinding) return;
  if (fieldBinding.encryptTooltipHost?.isConnected) {
    fieldBinding.encryptTooltipHost.remove();
  }
  if (fieldBinding.onScroll) window.removeEventListener("scroll", fieldBinding.onScroll, true);
  if (fieldBinding.onResize) window.removeEventListener("resize", fieldBinding.onResize);
  if (fieldBinding.onEscape) document.removeEventListener("keydown", fieldBinding.onEscape, true);
  fieldBinding = null;
}

function setEncryptTooltipBusy(busy) {
  const root = fieldBinding?.encryptTooltipHost?.shadowRoot;
  const btn = root?.querySelector('[data-a="encrypt-tip"]');
  if (btn) btn.disabled = busy;
}

function positionEncryptTooltip(host, el) {
  if (!el.isConnected) return;
  const r = el.getBoundingClientRect();
  const br = host.getBoundingClientRect();
  const tw = Math.max(br.width || host.offsetWidth || 0, 180);
  const th = Math.max(br.height || host.offsetHeight || 0, 32);
  const pad = 8;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.min(Math.max(pad, left), window.innerWidth - tw - pad);
  let top = r.top - th - pad;
  if (top < pad) top = r.bottom + pad;
  top = Math.min(Math.max(pad, top), window.innerHeight - th - pad);
  host.style.left = `${left}px`;
  host.style.top = `${top}px`;
}

async function createEncryptTooltipHost(targetEl, onEncryptClick) {
  const host = document.createElement("div");
  host.className = "shrimpt-field-encrypt-tooltip-host";
  host.setAttribute("data-shrimpt-chrome", "1");
  host.style.cssText =
    "position:fixed;left:0;top:0;z-index:2147483647;margin:0;padding:0;border:none;background:transparent;pointer-events:auto;box-sizing:border-box;display:block;visibility:visible;opacity:1;";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = await getEncryptTooltipShadowCss();
  shadow.appendChild(style);
  const encryptTipBtn = document.createElement("button");
  encryptTipBtn.type = "button";
  encryptTipBtn.className = "tip";
  encryptTipBtn.setAttribute("data-a", "encrypt-tip");
  encryptTipBtn.textContent = "Click to encrypt";
  shadow.appendChild(encryptTipBtn);
  const keepEditorSelection = (e) => { e.preventDefault(); };
  encryptTipBtn.addEventListener("mousedown", keepEditorSelection);
  encryptTipBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    const out = onEncryptClick();
    if (out && typeof out.then === "function") {
      out.catch((err) => console.error("[Shrimpt] encrypt click", err));
    }
  });
  host.addEventListener("mousedown", (e) => { e.preventDefault(); });
  const rootEl = document.body || document.documentElement;
  rootEl.appendChild(host);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => positionEncryptTooltip(host, targetEl));
  });
  return host;
}

async function onFieldToolbarEncryptNow() {
  shrimptLog("encrypt", "tooltip clicked", {
    hasBinding: Boolean(fieldBinding),
    mode: fieldBinding?.mode,
    targetConnected: fieldBinding?.target?.isConnected
  });
  if (!fieldBinding || fieldBinding.mode !== "button_replace") return;
  const el = fieldBinding.target;
  if (!el?.isConnected) {
    detachFieldBinding();
    return;
  }
  const fk = fieldBinding.fieldKind || fieldKind(el);
  const { plain, spec } = getEncryptReplaceSpec(el, fk);
  shrimptLog("encrypt", "field content", {
    kind: fk,
    plainLen: plain.length,
    specMode: spec.mode,
    hasRecipient: Boolean(settingsCache?.selectedRecipientContactId)
  });
  if (!plain.trim()) {
    setEncryptTooltipLabel("Nothing to encrypt — type something first.");
    return;
  }
  const rid = settingsCache?.selectedRecipientContactId;
  if (!rid) {
    setEncryptTooltipLabel("Choose Them in the popup first.");
    return;
  }
  try {
    setEncryptTooltipBusy(true);
    setEncryptTooltipLabel("Encrypting…");
    const { compact } = await request(MESSAGE_TYPES.ENCRYPT_TEXT, {
      plaintext: plain,
      recipientContactId: rid
    });
    if (!el.isConnected) return;
    applyWrappedCiphertextWithSpec(el, fk, wrapEnvelopeCompact(compact), spec);
    setEncryptTooltipLabel("Click to encrypt");
    shrimptLog("encrypt", "field encrypted ok", { specMode: spec.mode });
  } catch (e) {
    const msg = e?.message === "LOCKED"
      ? "Locked — unlock in popup."
      : (e?.message || "Encrypt failed.");
    setEncryptTooltipLabel(msg);
    shrimptLog("encrypt", "field encrypt failed", { message: e?.message });
  } finally {
    setEncryptTooltipBusy(false);
  }
}

function setEncryptTooltipLabel(text) {
  const root = fieldBinding?.encryptTooltipHost?.shadowRoot;
  const btn = root?.querySelector('[data-a="encrypt-tip"]');
  if (btn) btn.textContent = text;
}

async function startButtonReplaceBinding(el, fk) {
  const kind = fk || fieldKind(el);
  const encryptTooltipHost = await createEncryptTooltipHost(el, () => onFieldToolbarEncryptNow());

  const reposition = () => {
    if (!el.isConnected) return;
    positionEncryptTooltip(encryptTooltipHost, el);
  };
  reposition();

  const onScroll = () => reposition();
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", reposition, { passive: true });

  const onEscape = (ev) => {
    if (ev.key === "Escape" && fieldBinding) {
      ev.stopPropagation();
      detachFieldBinding();
    }
  };
  document.addEventListener("keydown", onEscape, true);

  fieldBinding = {
    target: el,
    mode: "button_replace",
    fieldKind: kind,
    encryptTooltipHost,
    onScroll,
    onResize: reposition,
    onEscape
  };
}

function scheduleFieldAutoBind(expectedField) {
  clearTimeout(fieldAutoBindTimer);
  const gen = ++fieldAutoBindGen;
  fieldAutoBindTimer = setTimeout(() => {
    fieldAutoBindTimer = null;
    if (gen !== fieldAutoBindGen) return;
    tryBindFocusedProtectableField(expectedField);
  }, 120);
}

function tryBindFocusedProtectableField(expectedField) {
  let el = null;
  if (expectedField?.isConnected) {
    const ae = document.activeElement;
    if (fieldKind(expectedField) === "value") {
      if (ae === expectedField) el = expectedField;
    } else if (expectedField.contains(ae) || ae === expectedField) {
      el = expectedField;
    }
  }

  if (!el) {
    const cur = document.activeElement;
    if (!cur || cur.nodeType !== Node.ELEMENT_NODE || isShrimptChromeTree(cur)) return;
    el = resolveProtectableField(cur);
  }
  if (!el) return;
  if (fieldBinding?.target === el) return;
  void bindFieldEncryptToElement(el).catch((err) => console.error("[Shrimpt] bind field encrypt", err));
}

async function bindFieldEncryptToElement(el) {
  if (!el) return;
  detachFieldBinding();
  const fk = fieldKind(el);
  await startButtonReplaceBinding(el, fk);
}

function startFieldEncryptFocusCapture() {
  document.addEventListener(
    "focusin",
    (ev) => {
      const t = ev.target;
      if (!t || t.nodeType !== Node.ELEMENT_NODE) return;
      if (isShrimptChromeTree(t)) return;
      const el = resolveProtectableField(t);
      if (!el) return;
      if (fieldBinding?.target === el) return;
      scheduleFieldAutoBind(el);
    },
    true
  );
}

function request(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        const msg = chrome.runtime.lastError.message;
        shrimptLog("msg", "sendMessage failed (service worker / channel)", { type, message: msg });
        reject(new Error(msg));
        return;
      }

      if (!response?.ok) {
        const msg = response?.error || "Unknown extension error.";
        shrimptLog("msg", "background returned error", { type, message: msg });
        reject(new Error(msg));
        return;
      }

      if (type === MESSAGE_TYPES.DECRYPT_ENVELOPE || type === MESSAGE_TYPES.ENCRYPT_TEXT) {
        shrimptLog("msg", "background ok", type);
      }

      resolve(response.result);
    });
  });
}
