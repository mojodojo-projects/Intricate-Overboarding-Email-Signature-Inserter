const FIELDS_KEY = "signatureFields";
const HTML_KEY = "signatureHtml";
const AUTO_KEY = "autoInsert";

const DEFAULTS = {
  closer: "Kind regards,",
  name: "",
  position: "",
  imageUrl: "",
};

const $ = (id) => document.getElementById(id);
const closerInput = $("closer");
const nameInput = $("name");
const positionInput = $("position");
const imageUrlInput = $("imageUrl");
const autoInsertEl = $("autoInsert");
const previewEl = $("preview");
const statusEl = $("status");
const insertBtn = $("insert");

function readForm() {
  return {
    closer: closerInput.value,
    name: nameInput.value,
    position: positionInput.value,
    imageUrl: imageUrlInput.value,
  };
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isValidImageUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// Mirrors what Gmail's "Best fit" button does: scales the image to 562px wide
// (or leaves it at natural size if smaller) and stamps an explicit height
// based on the source aspect ratio. We need the natural dimensions to compute
// that height, so preload + cache them per URL.
const BEST_FIT_WIDTH = 562;
const imageDimsCache = new Map();

function loadImageDims(url) {
  if (!isValidImageUrl(url)) return Promise.resolve(null);
  if (imageDimsCache.has(url)) return Promise.resolve(imageDimsCache.get(url));
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const dims = { width: img.naturalWidth, height: img.naturalHeight };
      imageDimsCache.set(url, dims);
      resolve(dims);
    };
    img.onerror = () => {
      imageDimsCache.set(url, null);
      resolve(null);
    };
    // Bust the browser HTTP cache so reopening the popup after replacing the
    // image at the same URL picks up the new natural dimensions. The
    // cache-buster only affects this dim-probe request — the URL stored in
    // the signature HTML stays clean.
    const sep = url.includes("?") ? "&" : "?";
    img.src = `${url}${sep}_sigcb=${Date.now()}`;
  });
}

function bestFitFor(url) {
  const natural = imageDimsCache.get(url);
  if (!natural) return { width: BEST_FIT_WIDTH, height: null };
  if (natural.width <= BEST_FIT_WIDTH) return natural;
  return {
    width: BEST_FIT_WIDTH,
    height: Math.round(natural.height * (BEST_FIT_WIDTH / natural.width)),
  };
}

// Sentinel comment so the content script can detect an already-inserted
// signature and avoid duplicates.
const SIGNATURE_SENTINEL = "<!--mojo-signature-->";

function buildSignatureHtml(sig) {
  const closer = escapeHtml((sig.closer || "").trim());
  const name = escapeHtml((sig.name || "").trim());
  const position = escapeHtml((sig.position || "").trim());
  const imageUrl = (sig.imageUrl || "").trim();

  const lines = [];
  if (closer) lines.push(`<p style="margin:0">${closer}</p>`);
  if (name)
    lines.push(
      `<strong style="font-family:verdana,sans-serif;font-size:large">${name}</strong>`
    );
  if (position) lines.push(`<p style="margin:0">${position}</p>`);
  if (isValidImageUrl(imageUrl)) {
    // Match Gmail's "Best fit" output exactly: width="562", proportional
    // height attribute (when we know the natural dims), and the same inline
    // styles Gmail applies. If natural dims haven't loaded yet, ship width
    // only — the browser will compute height from the loaded image's aspect
    // ratio at render time, and a follow-up save will bake in the height once
    // the dims resolve.
    const fit = bestFitFor(imageUrl);
    const heightAttr = fit.height != null ? ` height="${fit.height}"` : "";
    lines.push(
      `<img src="${escapeHtml(imageUrl)}" alt="signature" width="${fit.width}"${heightAttr} style="display: block; margin-right: 0px;" />`
    );
  }
  if (lines.length === 0) return "";
  return `${SIGNATURE_SENTINEL}<div style="color:#000">${lines.join("")}</div>`;
}

// Empty-line block inserted before the signature so it doesn't butt up
// against the previous line of typed text. Kept separate from the stored
// signature HTML so both auto-insert and manual-insert get it consistently
// even if the stored HTML pre-dates this change.
const LEADING_BLANK = "<div><br></div>";

function renderPreview() {
  const sig = readForm();
  const html = buildSignatureHtml(sig);
  if (!html) {
    previewEl.classList.add("empty");
    previewEl.textContent = "Fill the fields above to see a preview.";
    return;
  }
  previewEl.classList.remove("empty");
  previewEl.innerHTML = html;
}

function setStatus(msg, kind = "") {
  statusEl.textContent = msg || "";
  statusEl.className = "status" + (kind ? ` ${kind}` : "");
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get([FIELDS_KEY, AUTO_KEY]);
  const fields = { ...DEFAULTS, ...(stored[FIELDS_KEY] || {}) };
  closerInput.value = fields.closer || "";
  nameInput.value = fields.name || "";
  positionInput.value = fields.position || "";
  imageUrlInput.value = fields.imageUrl || "";
  autoInsertEl.checked = stored[AUTO_KEY] !== false;
  renderPreview();
  // Pre-load dimensions for any previously-stored image URL so the next save
  // upgrades the persisted HTML from width-only to width + scaled height.
  const url = (fields.imageUrl || "").trim();
  if (isValidImageUrl(url) && !imageDimsCache.has(url)) {
    loadImageDims(url).then(() => {
      renderPreview();
      scheduleSave();
    });
  }
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const fields = readForm();
    const html = buildSignatureHtml(fields);
    await chrome.storage.sync.set({
      [FIELDS_KEY]: fields,
      [HTML_KEY]: html,
    });
  }, 200);
}

for (const el of [closerInput, nameInput, positionInput, imageUrlInput]) {
  el.addEventListener("input", () => {
    renderPreview();
    scheduleSave();
  });
}

// Whenever the image URL changes, kick off a natural-dimension load so the
// next render/save can stamp a proportional height attribute (Gmail-style
// "Best fit"). The initial render/save above runs synchronously with whatever
// dims are cached (possibly none); we re-render and re-save once the load
// resolves so the persisted HTML includes the height.
imageUrlInput.addEventListener("input", () => {
  const url = imageUrlInput.value.trim();
  if (!isValidImageUrl(url) || imageDimsCache.has(url)) return;
  loadImageDims(url).then(() => {
    renderPreview();
    scheduleSave();
  });
});

autoInsertEl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ [AUTO_KEY]: autoInsertEl.checked });
});

async function insertIntoGmail() {
  setStatus("");
  const sig = readForm();
  const html = buildSignatureHtml(sig);
  if (!html) {
    setStatus("Fill at least one field first.", "err");
    return;
  }

  insertBtn.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https:\/\/mail\.google\.com\//.test(tab.url || "")) {
      setStatus("Open a Gmail tab first.", "err");
      return;
    }
    // Use chrome.scripting.executeScript — it doesn't depend on the content
    // script being loaded, so it sidesteps "receiving end does not exist"
    // errors that chrome.tabs.sendMessage can throw on older tabs.
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (signatureHtml) => {
        const composeBox = document.querySelector(
          "div[role='textbox'][aria-label='Message Body']"
        );
        if (!composeBox) return { ok: false, error: "no_compose" };
        composeBox.focus();
        const range = document.createRange();
        range.selectNodeContents(composeBox);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("insertHTML", false, signatureHtml);
        return { ok: true };
      },
      args: [LEADING_BLANK + html],
    });
    const successful = (results || []).some((r) => r?.result?.ok);
    if (successful) {
      setStatus("Inserted ✓", "ok");
      setTimeout(() => window.close(), 350);
    } else {
      setStatus(
        "Couldn't find a Gmail compose window. Open one and try again.",
        "err"
      );
    }
  } catch (e) {
    setStatus(`Couldn't reach Gmail: ${e.message}`, "err");
  } finally {
    insertBtn.disabled = false;
  }
}

insertBtn.addEventListener("click", insertIntoGmail);

loadSettings();
