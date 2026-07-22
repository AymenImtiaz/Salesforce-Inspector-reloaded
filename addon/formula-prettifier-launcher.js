// Formula Prettifier — page launcher (content-script context).
//
// Injects the Formula Prettifier's floating action button (FAB) and its
// draggable / resizable window onto the live Salesforce page. Following the
// Inspector's design principle ("stay completely inactive until the user
// explicitly interacts"), NOTHING is shown until the user opens the Inspector:
// button.js calls FormulaPrettifierLauncher.show(sfHost) from openPopup() and
// FormulaPrettifierLauncher.hideFab() from closePopup().
//
// The window itself is an iframe hosting formula-prettifier.html, so its UI is
// fully style-isolated from Salesforce (pixel-faithful to the AppExchange app).
// This file only owns the FAB and the draggable/resizable frame around that
// iframe.

// eslint-disable-next-line no-unused-vars
let FormulaPrettifierLauncher = (function() {
  const FAB_ID = "fp-fab-root";
  const WINDOW_ID = "fp-window-root";
  const MIN_W = 660; // matches the app's min window width (see launcher css)
  const MIN_H = 300;

  let currentSfHost = null;
  let stylesInjected = false;

  function ensureStyles() {
    if (stylesInjected || document.getElementById("fp-launcher-styles")) {
      stylesInjected = true;
      return;
    }
    const link = document.createElement("link");
    link.id = "fp-launcher-styles";
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("formula-prettifier-launcher.css");
    document.head.appendChild(link);
    stylesInjected = true;
  }

  // Object API name from a Lightning record/object URL, e.g.
  // /lightning/r/Account/001.../view -> "Account". Mirrors popup.js getSobject()
  // (which is module-local there); when this is upstreamed, prefer exporting the
  // popup.js/utils.js version instead of duplicating.
  function getObjectFromUrl(href) {
    try {
      const url = new URL(href);
      const match = url.pathname.match(/\/lightning\/[r|o]\/([a-zA-Z0-9_]+)\/[a-zA-Z0-9]+/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  // Record Id from a Lightning record URL. Mirrors the Lightning branch of
  // popup.js getRecordId().
  function getRecordIdFromUrl(href) {
    try {
      const url = new URL(href);
      const match = url.pathname.match(/\/lightning\/[r|o]\/[a-zA-Z0-9_]+\/([a-zA-Z0-9]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        if (k === "className") node.className = props[k];
        else if (k === "style") node.style.cssText = props[k];
        else if (k.startsWith("on") && typeof props[k] === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), props[k]);
        } else node.setAttribute(k, props[k]);
      }
    }
    for (const c of children) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  // Salesforce utility:sparkles icon (exact path from the extension's
  // symbols.svg sprite) so the FAB matches the AppExchange app pixel-for-pixel.
  const SPARKLES_PATH
    = "M349 272l-69 34a105 105 0 00-47 47l-33 67c-5 10-19 10-24 0l-34-68a105 105 0 00-47-47l-68-34a13 13 0 010-24l68-34a105 105 0 0047-47l34-68a13 13 0 0124 0l34 68a105 105 0 0047 47l68 34c10 5 10 19 0 24zm148 150l-30-14a45 45 0 01-20-20l-14-30a6 6 0 00-10 0l-15 30a45 45 0 01-20 20l-30 15c-3 2-3 8 0 10l30 15a45 45 0 0120 20l15 29c2 4 8 4 10 0l14-30a45 45 0 0120-20l30-14c4-2 4-8 0-10zm0-335l-30-15a45 45 0 01-20-20l-14-29a6 6 0 00-10 0l-15 30a45 45 0 01-20 20l-30 14c-3 2-3 8 0 10l30 15a45 45 0 0120 20l15 29c2 4 8 4 10 0l15-30a45 45 0 0120-20l29-14c4-2 4-8 0-10z";
  // FAB uses a larger icon (medium, ~32px) to fill the 60px circle like the
  // app; the header title uses a smaller one.
  const FAB_SPARKLES_SVG = sparklesSvg(32);
  const TITLE_SPARKLES_SVG = sparklesSvg(22);

  function sparklesSvg(size) {
    return "<svg viewBox='0 0 520 520' width='" + size + "' height='" + size
      + "' aria-hidden='true'><path fill='rebeccapurple' d='"
      + SPARKLES_PATH + "'/></svg>";
  }

  // --- FAB ------------------------------------------------------------------
  function ensureFab() {
    if (document.getElementById(FAB_ID)) return;
    const fab = el("div", {id: FAB_ID, className: "fp-fab-container"});
    const btn = el("button", {
      className: "fp-fab-button",
      title: "Open Formula Prettifier",
      onclick: openWindow
    });
    btn.innerHTML = FAB_SPARKLES_SVG;
    fab.appendChild(btn);
    document.body.appendChild(fab);
    // Fade-in
    requestAnimationFrame(() => fab.classList.add("fp-visible"));
  }

  function removeFab() {
    const fab = document.getElementById(FAB_ID);
    if (fab) fab.remove();
  }

  // --- Window (draggable/resizable frame around the iframe) -----------------
  function openWindow() {
    if (document.getElementById(WINDOW_ID)) return;
    removeFab();

    const win = el("div", {
      id: WINDOW_ID,
      className: "fp-floating-window",
      style: "left:120px; top:100px; width:900px; height:640px;"
    });

    const header = el("div", {className: "fp-window-header"});
    const title = el("div", {className: "fp-window-title"});
    title.innerHTML = TITLE_SPARKLES_SVG + "<span>Salesforce Formula Prettifier</span>";

    const controls = el("div", {className: "fp-window-controls"});
    const minimizeBtn = el("button", {className: "fp-window-control-btn fp-minimize-btn", title: "Minimize", onclick: () => toggleMinimize(win)}, "−");
    const maximizeBtn = el("button", {className: "fp-window-control-btn fp-maximize-btn", title: "Maximize", onclick: () => toggleMaximize(win, maximizeBtn)}, "□");
    const closeBtn = el("button", {className: "fp-window-control-btn fp-close-btn", title: "Close", onclick: closeWindow}, "×");
    controls.appendChild(minimizeBtn);
    controls.appendChild(maximizeBtn);
    controls.appendChild(closeBtn);
    header.appendChild(title);
    header.appendChild(controls);

    // Detect the current record page's object + recordId so the Prettifier can
    // auto-select that object (and, later, evaluate against that record).
    const contextObject = getObjectFromUrl(location.href);
    const contextRecordId = getRecordIdFromUrl(location.href);
    let iframeSrc = "formula-prettifier.html?host=" + encodeURIComponent(currentSfHost || "");
    if (contextObject) iframeSrc += "&object=" + encodeURIComponent(contextObject);
    if (contextRecordId) iframeSrc += "&recordId=" + encodeURIComponent(contextRecordId);

    const body = el("div", {className: "fp-window-body"});
    const iframe = el("iframe", {
      className: "fp-window-iframe",
      title: "Formula Prettifier",
      allow: "clipboard-write",
      src: chrome.runtime.getURL(iframeSrc)
    });
    body.appendChild(iframe);

    const resizeHandle = el("div", {className: "fp-resize-handle"});

    win.appendChild(header);
    win.appendChild(body);
    win.appendChild(resizeHandle);
    document.body.appendChild(win);

    makeDraggable(win, header, iframe);
    makeResizable(win, resizeHandle, iframe);
  }

  // Minimize collapses the window to just its header bar; clicking again restores.
  function toggleMinimize(win) {
    win.classList.toggle("fp-minimized");
  }

  // Maximize fills the viewport; the saved geometry is restored on toggle back.
  function toggleMaximize(win, btn) {
    if (win.classList.contains("fp-maximized")) {
      win.classList.remove("fp-maximized");
      if (win.dataset.prevGeom) {
        const g = JSON.parse(win.dataset.prevGeom);
        win.style.left = g.left;
        win.style.top = g.top;
        win.style.width = g.width;
        win.style.height = g.height;
      }
      btn.innerHTML = "□";
      btn.title = "Maximize";
    } else {
      win.dataset.prevGeom = JSON.stringify({
        left: win.style.left,
        top: win.style.top,
        width: win.style.width,
        height: win.style.height
      });
      win.classList.add("fp-maximized");
      btn.innerHTML = "❐";
      btn.title = "Restore";
    }
  }

  function closeWindow() {
    const win = document.getElementById(WINDOW_ID);
    if (win) win.remove();
    // Re-show the FAB if the Inspector is still open.
    if (document.querySelector("#insext.insext-active")) {
      ensureFab();
    }
  }

  // Dragging via the header. While dragging we set pointer-events:none on the
  // iframe so mousemove events aren't swallowed by the cross-origin frame.
  function makeDraggable(win, handle, iframe) {
    let startX, startY, origLeft, origTop,
      dragging = false;

    function onDown(e) {
      if (e.target.closest(".fp-window-control-btn")) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = win.getBoundingClientRect();
      origLeft = rect.left;
      origTop = rect.top;
      iframe.style.pointerEvents = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    }
    function onMove(e) {
      if (!dragging) return;
      let nx = origLeft + (e.clientX - startX);
      let ny = origTop + (e.clientY - startY);
      // Keep a minimum sliver on screen.
      nx = Math.min(Math.max(nx, -(win.offsetWidth - 200)), window.innerWidth - 60);
      ny = Math.min(Math.max(ny, 0), window.innerHeight - 40);
      win.style.left = nx + "px";
      win.style.top = ny + "px";
    }
    function onUp() {
      dragging = false;
      iframe.style.pointerEvents = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    handle.addEventListener("mousedown", onDown);
  }

  function makeResizable(win, handle, iframe) {
    let startX, startY, origW, origH,
      resizing = false;
    function onDown(e) {
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      origW = win.offsetWidth;
      origH = win.offsetHeight;
      iframe.style.pointerEvents = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    }
    function onMove(e) {
      if (!resizing) return;
      const nw = Math.max(MIN_W, origW + (e.clientX - startX));
      const nh = Math.max(MIN_H, origH + (e.clientY - startY));
      win.style.width = nw + "px";
      win.style.height = nh + "px";
    }
    function onUp() {
      resizing = false;
      iframe.style.pointerEvents = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    handle.addEventListener("mousedown", onDown);
  }

  // --- Public API -----------------------------------------------------------
  return {
    // Called from button.js openPopup(): the Inspector just opened.
    show(sfHost) {
      currentSfHost = sfHost;
      ensureStyles();
      // If the window is already open, leave it; otherwise present the FAB.
      if (!document.getElementById(WINDOW_ID)) {
        ensureFab();
      }
    },
    // Called from button.js closePopup(): the Inspector popup closed. We hide
    // the FAB but leave an already-open Prettifier window in place so the user
    // can keep working with it.
    hideFab() {
      removeFab();
    }
  };
})();
