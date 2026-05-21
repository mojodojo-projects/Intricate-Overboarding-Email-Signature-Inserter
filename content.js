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

function scan() {
  const bodies = document.querySelectorAll(COMPOSE_SELECTOR);
  if (bodies.length === 0) return;
  chrome.storage.sync.get(["signatureHtml", "autoInsert"], (s) => {
    if (chrome.runtime.lastError) return;
    if (s.autoInsert === false) return;
    const html = s.signatureHtml || "";
    if (!html) return;
    for (const body of bodies) tryInsertInto(body, html);
  });
}

const observer = new MutationObserver(() => scan());
observer.observe(document.body, { childList: true, subtree: true });

// Catch the case where a compose is already open when the script first runs
scan();
