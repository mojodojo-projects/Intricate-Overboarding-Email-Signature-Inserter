// Runs in mail.google.com tabs. Watches for compose windows and
// auto-inserts the saved signature when the user has that toggle on.
//
// Mirrors the old "Gmail Signature Inserter" extension: simple selector,
// MutationObserver on the whole body, storage check on every mutation
// (so we don't race the initial settings load).

const COMPOSE_SELECTOR = "div[aria-label='Message Body']";
const SIGNATURE_SENTINEL = "<!--mojo-signature-->";
const LEGACY_SIGNATURE_MARKER = 'font-family:verdana,sans-serif;font-size:large';
// Empty-line block inserted before the signature so it doesn't butt up
// against the previous line of typed text. Kept separate from the stored
// signature HTML so old stored values still get the blank line at insert time.
const LEADING_BLANK = "<div><br></div>";

const insertedBodies = new WeakSet();

function alreadyHasSignature(body) {
  const html = body.innerHTML || "";
  return (
    html.includes(SIGNATURE_SENTINEL) ||
    html.includes(LEGACY_SIGNATURE_MARKER)
  );
}

function tryInsertInto(body, html) {
  if (!html) return;
  if (insertedBodies.has(body)) return;
  if (alreadyHasSignature(body)) {
    insertedBodies.add(body);
    return;
  }
  body.innerHTML = body.innerHTML + LEADING_BLANK + html;
  insertedBodies.add(body);
}

function contextAlive() {
  // After the extension is reloaded/updated, chrome.runtime and
  // chrome.storage in this orphaned content script can be undefined,
  // a throwing getter, or briefly inconsistent (one gone before the
  // other). Probe both behind a try so we never propagate the error.
  try {
    return !!(chrome?.runtime?.id && chrome?.storage?.sync);
  } catch {
    return false;
  }
}

function scan() {
  // Once the extension reloads, every chrome.* binding here is invalid.
  // Gmail mutates the DOM constantly, so without this guard the
  // MutationObserver would keep retriggering scan() and spamming errors.
  if (!contextAlive()) {
    observer.disconnect();
    return;
  }
  const bodies = document.querySelectorAll(COMPOSE_SELECTOR);
  if (bodies.length === 0) return;
  try {
    chrome.storage.sync.get(["signatureHtml", "autoInsert"], (s) => {
      // Context can invalidate between the get() call and this callback
      // firing — the callback runs outside the try/catch, so guard again
      // before touching chrome.runtime.lastError or the result object.
      if (!contextAlive()) {
        observer.disconnect();
        return;
      }
      if (chrome.runtime.lastError) return;
      if (!s || s.autoInsert === false) return;
      const html = s.signatureHtml || "";
      if (!html) return;
      for (const body of bodies) tryInsertInto(body, html);
    });
  } catch {
    observer.disconnect();
  }
}

const observer = new MutationObserver(() => scan());
observer.observe(document.body, { childList: true, subtree: true });

// Catch the case where a compose is already open when the script first runs
scan();
