// Fluids_MediaPlayer overlay layer, parent side. Puts overlay.html in a transparent full-screen iframe ABOVE the fluids
// and forwards Lively's now-playing feed, settings and monitor layout to it. The fluid code is untouched.
(() => {
  const f = document.createElement("iframe");
  f.src = "overlay.html";
  f.setAttribute("allowtransparency", "true");
  f.style.cssText = "position:fixed;left:0;top:0;width:100%;height:100%;border:0;background:transparent;z-index:2147483000;pointer-events:none;color-scheme:normal";
  document.body.appendChild(f);
  const positionKey = "vm_np_pos";
  let ready = false; const queue = [];
  const send = (m) => { if (ready && f.contentWindow) f.contentWindow.postMessage(m, "*"); else queue.push(m); };
  function sendRects() {
    const n = MONITORS.enabled ? Math.max(1, MONITORS.count) : 1, rects = [];
    for (let i = 0; i < n; i++) rects.push(monRect(i, n));
    send({ type: "rects", rects });
  }
  addEventListener("message", (e) => {
    if (e.source !== f.contentWindow || !e.data) return;
    if (e.data.type === "ready") {
      ready = true; queue.splice(0).forEach(send);
      try { const p = JSON.parse(localStorage.getItem(positionKey)); if (p) send({ type: "saved-position", position: p }); } catch (err) {}
      sendRects();
    } else if (e.data.type === "save-position" && e.data.position) {
      try { localStorage.setItem(positionKey, JSON.stringify(e.data.position)); } catch (err) {}
    }
  });
  const origTrack = window.livelyCurrentTrack, origProp = window.livelyPropertyListener;
  window.livelyCurrentTrack = (d) => { origTrack(d); send({ type: "track", data: d }); };
  window.livelyPropertyListener = (name, val) => {
    origProp(name, val);
    if (name === "npUnlock") f.style.pointerEvents = val ? "auto" : "none"; // only catch the mouse while placing it
    if (/^np/.test(name)) send({ type: "prop", name, val });
    if (name === "monitorLayout" || name === "monitorCount" || name === "perMonitor") sendRects();
  };
  addEventListener("resize", sendRects);
})();
