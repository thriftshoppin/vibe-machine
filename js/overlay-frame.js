// Fluids_MediaPlayer overlay layer, iframe side: draws the now-playing card on a transparent page.
(() => {
  const NP = { on: true, size: 100, maxW: 75, unlock: false, scrim: 45, bold: false, mirror: false, font: "" };
  const FONT_STACK = "'VM Gotham', Gotham, 'Gotham Book', Montserrat, 'Segoe UI', sans-serif"; // installed Gotham first
  const AD_TITLE = "We'll be right back.", AD_ARTIST = "Spotify", KEY = "vm_np_pos";
  const DEFAULT_POSITION = { mon: 0, px: 0.007, ax: 0.271, py: 0.649 };
  const TITLE_GAP = 0.3; // extra space between the title and the artist, as a fraction of the title's font size
  let rects = [{ x0: 0, x1: 1, y0: 0, y1: 1 }], U = 1, anim = null, hideT = null, adT = null, lastKey = "", lastThumb = null, playing = false, drag = null;
  let saved = null; try { saved = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (!saved || !Number.isFinite(saved.mon) || !Number.isFinite(saved.px) || !Number.isFinite(saved.py)) saved = { ...DEFAULT_POSITION };

  const css = document.createElement("style");
  const ff = (w, names, file) => `@font-face{font-family:'VM Gotham';font-weight:${w};src:${names.map((n) => `local("${n}")`).join(",")},url("fonts/${file}") format("opentype")}`;
  css.textContent = [ff(400, ["Gotham Book", "Gotham-Book", "Gotham"], "Gotham-Book.otf"), ff(500, ["Gotham Medium", "Gotham-Medium"], "Gotham-Medium.otf"),
    ff(700, ["Gotham Bold", "Gotham-Bold"], "Gotham-Bold.otf")].join("\n") + `
    #np{position:fixed;display:flex;align-items:center;opacity:0;transition:opacity .4s ease;color:#fff;font-weight:400;pointer-events:none;box-sizing:border-box}
    #np.on{opacity:1;transition:opacity .25s ease}
    #np.unlocked{pointer-events:auto;cursor:move;outline:2px dashed rgba(255,255,255,.8);outline-offset:6px}
    #npText{display:flex;flex-direction:column}
    #npCover{object-fit:cover;background:#333;flex:none}
    #npBox{overflow:hidden;white-space:nowrap;width:max-content}
    #npTitle{display:inline-block;line-height:1.3;color:#fff}
    #npArtist{color:#e0e0e0;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
    #npHint{position:fixed;display:none;box-sizing:border-box;color:#fff;background:rgba(0,0,0,.84);font-family:'Segoe UI',sans-serif;line-height:1.4;white-space:pre-wrap;border-radius:8px;pointer-events:none}`;
  document.head.appendChild(css);
  const customCss = document.createElement("style"); document.head.appendChild(customCss);
  const FONT_FILE = /\.(ttf|otf|woff2?)$/i; // 'Extra font' may be a file name in the wallpaper's fonts folder instead of an installed font's name
  function fontFamilyFor(f) {
    f = (f || "").trim(); customCss.textContent = "";
    if (!f || f === "Gotham, Montserrat, 'Segoe UI', sans-serif") return "";
    if (FONT_FILE.test(f)) {
      customCss.textContent = `@font-face{font-family:'VM Custom';font-weight:100 900;src:url("fonts/${encodeURI(f)}")}`;
      return "'VM Custom', ";
    }
    return f + ", ";
  }
  document.body.insertAdjacentHTML("beforeend",
    '<div id="np"><img id="npCover" alt=""><div id="npText"><div id="npBox"><span id="npTitle"></span></div><div id="npArtist"></div></div></div><div id="npHint"></div>');
  const $ = (id) => document.getElementById(id);
  const np = $("np"), cover = $("npCover"), box = $("npBox"), txt = $("npText"), title = $("npTitle"), artist = $("npArtist"), hint = $("npHint");

  // Position is saved by the host page as well as this frame so a wallpaper restart restores the last dragged spot.
  function storePos() {
    try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) {}
    parent.postMessage({ type: "save-position", position: saved }, "*");
  }
  function placeHint() { // the readout under the card, only while Unlock is ticked
    const show = NP.unlock && NP.on;
    hint.style.display = show ? "block" : "none";
    if (!show) return;
    hint.textContent = "Please set this widget where you would like to freeze it.\nAdditional options are in Settings.\nOnce in place, uncheck Unlock to lock it.";
    const fs = Math.max(11, 13 * U);
    hint.style.fontSize = fs + "px"; hint.style.padding = fs * 0.6 + "px " + fs * 0.9 + "px"; hint.style.maxWidth = Math.min(innerWidth * 0.5, 42 * fs) + "px";
    const b = np.getBoundingClientRect();
    let top = b.bottom + 10 * U;
    if (top + hint.offsetHeight > innerHeight) top = Math.max(0, b.top - 10 * U - hint.offsetHeight);
    hint.style.left = Math.min(Math.max(0, b.left), Math.max(0, innerWidth - hint.offsetWidth)) + "px"; hint.style.top = top + "px";
  }

  const mons = () => rects.length;
  function rect(m) {
    const r = rects[Math.min(m, rects.length - 1)], W = innerWidth, H = innerHeight;
    return { l: r.x0 * W, t: (1 - r.y1) * H, w: (r.x1 - r.x0) * W, h: (r.y1 - r.y0) * H };
  }
  const mime = (b) => (b.startsWith("iVBOR") ? "image/png" : b.startsWith("R0lGOD") ? "image/gif" : b.startsWith("UklGR") ? "image/webp" : "image/jpeg");

  function layout() {
    np.style.display = NP.on ? "flex" : "none";
    np.classList.toggle("unlocked", NP.unlock);
    refreshVis();
    const R = rect(saved ? saved.mon : 0);
    U = (R.h / 1080) * (NP.size / 100);
    const m = 60 * U, cs = 165 * U, gap = 35 * 0.76 * U, pad = 22 * U;
    Object.assign(np.style, { fontFamily: fontFamilyFor(NP.font) + FONT_STACK, gap: gap + "px", padding: pad + "px", borderRadius: 16 * U + "px", background: `rgba(0,0,0,${NP.scrim / 100})` });
    np.style.flexDirection = NP.mirror ? "row-reverse" : "row"; txt.style.alignItems = NP.mirror ? "flex-end" : "flex-start"; // mirror = cover on the right, text right-aligned
    cover.style.width = cover.style.height = cs + "px"; cover.style.borderRadius = 6 * U + "px";
    title.style.fontWeight = NP.bold ? 700 : 400; title.style.fontSize = 35 * U + "px";
    // Some fonts (a single-weight Spotify-style font, a font file with no bold) ignore the bold setting. Check: if 700 and 400 measure the
    // same, thicken the letters with a thin outline so the Bold tickbox always does something.
    title.style.webkitTextStroke = "0";
    if (NP.bold) {
      const pr = document.createElement("span");
      pr.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:400 ${35 * U}px ${np.style.fontFamily}`;
      pr.textContent = "Hamburgefonstiv Mmmwwwiii"; document.body.appendChild(pr);
      const w4 = pr.getBoundingClientRect().width; pr.style.fontWeight = 700; const w7 = pr.getBoundingClientRect().width; pr.remove();
      if (Math.abs(w7 - w4) < 0.5) title.style.webkitTextStroke = `${(0.03 * 35 * U).toFixed(2)}px #fff`;
    }
 artist.style.fontSize = 35 * 0.6 * U + "px";
    // A little air between the title and the artist. The artist line keeps its spot: the title box gets space below it and the text block
    // an equal negative top margin, so the block stays centred exactly where it was and only the title moves up.
    const tg = TITLE_GAP * 35 * U;
    box.style.marginBottom = tg + "px"; txt.style.marginTop = -tg + "px";
    const room = saved ? (NP.mirror && saved.ax !== undefined ? saved.ax * R.w : (1 - saved.px) * R.w) : R.w - m; // space between the card's anchored edge and the far screen edge
    // 'Overlay max width' setting: the card may take up to this % of the monitor's usable width (100 = edge to edge inside the screen margins).
    // The title gets what is left after the cover, gap and padding. A title that fits stays still; a longer one is cut there and scrolls.
    const roomW = Math.max(60 * U, room - m - cs - gap - 2 * pad), capW = Math.max(60 * U, ((R.w - 2 * m) * NP.maxW) / 100 - cs - gap - 2 * pad);
    const maxW = Math.min(roomW, capW);
    box.style.maxWidth = maxW + "px"; txt.style.maxWidth = maxW + "px"; artist.style.maxWidth = maxW + "px"; // a long artist name is cut with ... instead of stretching the card
    const nw = np.offsetWidth, nh = np.offsetHeight;
    let x, y;
    if (saved) { x = NP.mirror && saved.ax !== undefined ? saved.ax * R.w - nw : saved.px * R.w; y = saved.py * R.h; }
    else { x = m; y = R.h - nh - m; } // no saved spot yet: bottom left of the first screen
    np.style.left = Math.min(Math.max(0, R.l + x), innerWidth - nw) + "px";
    np.style.top = Math.min(Math.max(0, R.t + y), innerHeight - nh) + "px";
    placeHint();
    marquee();
  }

  function marquee() {
    if (anim) { anim.cancel(); anim = null; }
    requestAnimationFrame(() => {
      const over = title.getBoundingClientRect().width - box.getBoundingClientRect().width; // real (sub-pixel) overflow, so a title that fits never scrolls
      box.style.webkitMaskImage = box.style.maskImage = over < 2 ? "none" : `linear-gradient(90deg,#000 calc(100% - ${28 * U}px),transparent)`; // soft fade on the right edge only while scrolling
      if (over < 2) return;
      const d = over + 40 * U;
      const travel = (d / (60 * U)) * 1000, pause = 2000, total = 2 * (travel + pause), t = (x) => `translateX(${x}px)`;
      anim = title.animate([
        { transform: t(0), offset: 0 }, { transform: t(0), offset: pause / total },
        { transform: t(-d), offset: (pause + travel) / total }, { transform: t(-d), offset: (2 * pause + travel) / total },
        { transform: t(0), offset: 1 }], { duration: total, iterations: Infinity, delay: 1500 });
    });
  }

  function setText(t, a) { title.textContent = t; artist.textContent = a; layout(); }
  function refreshVis() {
    np.classList.toggle("on", playing || NP.unlock);
    if (NP.unlock && !playing && !title.textContent) { title.textContent = "Drag me"; artist.textContent = "Untick Unlock to lock"; }
  }

  function onTrack(data) {
    let o = null;
    try { o = typeof data === "string" ? JSON.parse(data) : data; } catch (e) {}
    if (!o) { // nothing playing: ignore the brief gaps between songs
      clearTimeout(adT); adT = null; clearTimeout(hideT);
      hideT = setTimeout(() => { playing = false; lastKey = ""; refreshVis(); }, 1500);
      return;
    }
    clearTimeout(hideT); playing = true;
    const t = (o.Title || "").trim(), a = (o.Artist || "").trim();
    clearTimeout(adT); adT = null;
    if (/^(advertisement|spotify)$/i.test(t)) setText(AD_TITLE, AD_ARTIST);
    else if (t.length < 2) adT = setTimeout(() => setText(AD_TITLE, AD_ARTIST), 4000); // empty title for 4s = ad
    else if (t + "|" + a !== lastKey) { lastKey = t + "|" + a; setText(t, a); }
    const th = o.Thumbnail || null;
    if (th && th !== lastThumb) { lastThumb = th; cover.src = th.startsWith("data:") ? th : "data:" + mime(th) + ";base64," + th; }
    cover.style.visibility = th || lastThumb ? "visible" : "hidden";
    refreshVis();
  }

  function onProp(name, val) {
    switch (name) {
      case "npEnabled": NP.on = !!val; break;
      case "npUnlock": NP.unlock = !!val; break;
      case "npSize": NP.size = val; break;
      case "npMaxWidth": NP.maxW = val; break;
      case "npScrim": NP.scrim = val; break;
      case "npMirror": NP.mirror = !!val; break;
      case "npBold": NP.bold = !!val; break;
      case "npFont": NP.font = (val || "").trim(); break;
      default: return;
    }
    layout();
  }

  // ---- Drag to place (only while Unlock is ticked; the parent only passes the mouse to this layer then) ----
  np.addEventListener("mousedown", (e) => {
    if (!NP.unlock) return;
    const b = np.getBoundingClientRect(); drag = { dx: e.clientX - b.left, dy: e.clientY - b.top }; e.preventDefault();
  });
  addEventListener("mousemove", (e) => {
    if (!drag) return;
    np.style.left = Math.min(Math.max(0, e.clientX - drag.dx), innerWidth - np.offsetWidth) + "px";
    np.style.top = Math.min(Math.max(0, e.clientY - drag.dy), innerHeight - np.offsetHeight) + "px";
  });
  addEventListener("mouseup", () => {
    if (!drag) return; drag = null;
    const b = np.getBoundingClientRect(), cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    let m = 0;
    for (let i = 0; i < mons(); i++) { const R = rect(i); if (cx >= R.l && cx <= R.l + R.w && cy >= R.t && cy <= R.t + R.h) { m = i; break; } }
    const R = rect(m);
    saved = { mon: m, px: (b.left - R.l) / R.w, ax: (b.right - R.l) / R.w, py: (b.top - R.t) / R.h };
    storePos();
    layout();
  });

  addEventListener("message", (e) => {
    const d = e.data; if (!d) return;
    if (d.type === "track") onTrack(d.data);
    else if (d.type === "prop") onProp(d.name, d.val);
    else if (d.type === "rects" && d.rects && d.rects.length) { rects = d.rects; layout(); }
    else if (d.type === "saved-position" && d.position && Number.isFinite(d.position.px) && Number.isFinite(d.position.py)) { saved = d.position; try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) {} layout(); }
  });
  addEventListener("resize", layout);
  if (document.fonts) { document.fonts.ready.then(layout); document.fonts.addEventListener("loadingdone", layout); } // re-measure once Gotham is in
  layout();
  parent.postMessage({ type: "ready" }, "*");
})();
