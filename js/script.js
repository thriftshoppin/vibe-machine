/*
MIT License

Copyright (c) 2017 Pavel Dobryakov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

"use strict";

const canvas = document.getElementsByTagName("canvas")[0];

// ============================================================
// ROOM OFF-SCREEN (overscan)
// The fluid fills a canvas that is larger than the visible screen by this share on every side, so waves can drift off
// the edges instead of piling up against a wall. Everything that places things on screen still works in visible
// coordinates (0..1 = the screen); splat() converts them. Sim / dye resolution grow with it so the detail stays the same.
// ============================================================
const OS = { o: 0.15, s: 1.3, k: 1 / 1.3, x0: 0.15 / 1.3, dirty: false, css: "" };
function setOverscan(o) {
  o = Math.max(0, Math.min(0.5, o));
  OS.o = o; OS.s = 1 + 2 * o; OS.k = 1 / OS.s; OS.x0 = o / OS.s; OS.dirty = true;
  applyOverscanStyle();
}
function applyOverscanStyle() {
  const o = OS.o * 100, css = "position:absolute;left:" + -o + "%;top:" + -o + "%;width:" + (100 + 2 * o) + "%;height:" + (100 + 2 * o) + "%";
  if (css !== OS.css) { OS.css = css; canvas.style.cssText = css; }
}
resizeCanvas();

let config = {
  SIM_RESOLUTION: 128,
  DYE_RESOLUTION: 1024,
  CAPTURE_RESOLUTION: 512,
  DENSITY_DISSIPATION: 1,
  VELOCITY_DISSIPATION: 0.2,
  PRESSURE: 0.8,
  PRESSURE_ITERATIONS: 20,
  CURL: 30,
  SPLAT_RADIUS: 0.25,
  SPLAT_FORCE: 6000,
  SHADING: true,
  COLOR_UPDATE_SPEED: 10,
  PAUSED: false,
  BACK_COLOR: { r: 0, g: 0, b: 0 },
  TRANSPARENT: false,
  BLOOM: true,
  BLOOM_ITERATIONS: 8,
  BLOOM_RESOLUTION: 256,
  BLOOM_INTENSITY: 0.8,
  BLOOM_THRESHOLD: 0.6,
  BLOOM_SOFT_KNEE: 0.7,
  SUNRAYS: true,
  SUNRAYS_RESOLUTION: 196,
  SUNRAYS_WEIGHT: 1.0,
  SOUND_SENSITIVITY: 0.25,
  FREQ_RANGE: 40,
  FREQ_MULTI: 0.1,
  ART_COLORS: true,
  PULSE_MULT: 2,          // pulses per low note (stock bass mode); worked out automatically from the song's pace, see autoPulseMult()
  PULSE_BRIGHT: 1,        // dye brightness multiplier for stock pulses (dimmer when the song is quiet)
  QUIET_FADE: 1,          // extra dye fade while the song is quiet
  CURSOR_AMOUNT: 0.2      // 0..1, how much the mouse cursor stirs the fluid (0 = not at all), set by the slider
};


// ============================================================
// ALBUM ART COLORS
// Reads the now-playing thumbnail from Lively (--system-nowplaying),
// picks up to 8 colors from it (black excluded), and eases the fluid
// toward them. Falls back to red + rose when nothing usable is playing,
// or when the art is basically black & white (nothing survives the grayscale mask, see MIN_SAT).
// ============================================================
// ============================================================
// WAVES PER MONITOR
// With Lively set to span both monitors, each audio hit comes from one monitor, the other, or
// several at once (a random non-empty mix). Every monitor that fires does its own thing: its own
// spot on its own screen, its own color and push. The fluid is still one continuous space, so
// the waves spill across the seam and affect each other.
// ============================================================
const MONITORS = {
  enabled: true,
  count: 2,
  rects: null,    // per-monitor on-screen areas (0..1 of the canvas, y up) from the layout setting, null = equal full-height columns
  sourceMode: 1,    // where waves start: 0 = every monitor, 1 = first (left) monitor, 2 = last (right) monitor; the others receive them, set by the dropdown
  SIZE_FOLLOW: 1.0, // 0..1, how much wave size (and trail travel) follows each monitor's own height (0 = same size everywhere), set by the slider
  CROSS_PUSH: 150 // small sideways push toward the neighboring monitor so waves just reach the seam (0 = off)
};

// ============================================================
// INSTRUMENT TRACKING
// The audio is split into 5 pitch bands (bass -> highs). Each band listens for *hits* using spectral
// flux (how much new energy just appeared) against its own adaptive threshold, so quiet synths and
// soft hits register just like loud ones. Every band has its own personality:
//   - size:  bass is a big soft bloom, highs are small sharp sparks
//   - spot:  bass blooms from the bottom of the screen, highs flicker near the top
//   - push:  bass shoves the fluid up, highs flick it sideways
//   - color: each band keeps its own slot of the album palette, so an instrument keeps its color
//   - power: how hard the hit was decides how many splats fire and how hard they push
// ============================================================
// BEGIN INSTR
const INSTR = {
  enabled: true,
  sensitivity: 0.5,   // 0.1..1, set by the slider
  MIN_LEVEL: 0.0012,  // ignore a band below this absolute level (silence / noise floor)
  MIN_FLUX: 0.0004,   // ignore hits smaller than this no matter how quiet the song is
  VOL_AMOUNT: 1.0,    // 0..1, how much volume controls wave size (0 = every wave is its normal size), set by the slider
  VOL_MIN: 0.35,      // size multiplier at the quietest the song gets
  VOL_MAX: 1.0,       // size multiplier at the loudest pulses (1.0 = normal size, never bigger)
  VOL_FLOOR: 0.02,    // the loudness reference never drops below this, so a quiet intro isn't treated as 'full volume'
  globalPeak: 0,
  env: 0,             // fast-moving loudness (0..1), makes trails throb with the beat
  // --- song intensity: how big the current section of the song is compared with the rest of it ---
  INT_AMOUNT: 0.7,    // 0..1, how strongly intensity changes the visuals (0 = off), set by the slider
  intensity: 0.5,     // 0 (sparse / quiet) .. 1 (climax / drop), smoothed
  eff: 0.5,           // intensity actually used: held at neutral for the first seconds of a song while it learns the song's range
  _warm: 0,           // ms of song heard so far
  WARM_TIME: 12000,
  _med: 0,            // loudness smoothed over about a second
  _t: 0,              // time of the last intensity update
  _ring: [],          // loudness sampled every 250 ms over the last ~30 s
  _ringT: 0,
  densHits: [],       // timestamps of recent hits (for how busy the song is)
  densMax: 6,         // busiest the song has been lately (hits per 2 s)
  lastDrop: 0,
  DROP_FROM: 0.35,    // a drop is: loudness was below this share of the song's loudest...
  DROP_TO: 0.7,       // ...and jumps above this share within about a second
  DROP_COOLDOWN: 6000,
  dropBoost: 1,
  // --- false-positive filters: a hit must pass every one of these ---
  GATE_REL: 0.05,        // band must be at least this fraction of its own recent peak (ignores bleed / noise floor; low enough that a song's quiet tail still reacts)
  PROMINENCE: 0.20,      // at least this share of the band's energy must be brand new (a real onset, not a wobble)
  CONFIRM_RATIO: 0.6,    // one frame later the band must still be at least this fraction of the hit level (kills single-frame glitches)
  MAX_HITS_PER_SEC: 12,  // weaker hits are dropped when more than this many fire in a second
  // --- who is playing? (best guess from the spectrum; Lively only gives 128 frequency bins, so this is a heuristic) ---
  TONAL_FLAT: 0.55,      // spectral flatness below this = tonal / pitched (voice, guitar, synth); above = noisy (drums, hats)
  KICK_SHARP: 0.35,      // bass hit whose energy is at least this share brand-new = kick drum, otherwise sustained bass
  // Each role keeps its own color. Roles take the album palette in this order (most prominent album color first).
  // When the album has fewer colors than roles, the extra roles share the "track" color.
  ROLE_ORDER: ["vocals", "track", "drums", "bass", "guitar"],
  hits: [],
  lastDrum: 0,
  DRUM_MERGE: 90,        // ms: one drum hit lights several bands at once, so drum hits inside this window count as one
  PEAK_PROMINENCE: 0.30, // a pitched note must add at least this share to its loudest bin (a real note start, not a wobble)
  CALM: 0.35,          // 0.05..1, how fast and forceful the waves are in instrument mode (1 = the original, very energetic; low = slow and soft), set by the slider
  TRAVEL_AMOUNT: 1.0, // 0..1, how strongly pitch controls travel (0 = no trails, waves just bloom in place), set by the slider
  MAX_EMITTERS: 16,   // cap on trails alive at once
  bands: [
    // lo / hi = audio bins (0..127, low -> high pitch). y = [min, max] height on screen (0 bottom, 1 top).
    // angle = direction of travel in degrees (90 = up), spread = how far it can stray from that angle.
    // The lower the note: the SLOWER it travels (speed, in screen-heights per second) and the LONGER it keeps going (life, seconds).
    // force = how hard the first shove is, trailForce = the gentle push it keeps applying while it travels,
    // trailEvery = ms between trail puffs.
    { name: "bass",    lo: 0,  hi: 4,   size: 1.9,  y: [0.06, 0.40], angle: 90, spread: 40,  force: 0.5,  slot: 0, cooldown: 120, maxSplats: 2, speed: 0.11, life: 2.0,  trailForce: 110, trailEvery: 90 },
    { name: "lowmid",  lo: 5,  hi: 14,  size: 1.35, y: [0.15, 0.60], angle: 90, spread: 80,  force: 0.7,  slot: 1, cooldown: 100, maxSplats: 2, speed: 0.15, life: 1.5,  trailForce: 150, trailEvery: 70 },
    { name: "mid",     lo: 15, hi: 32,  size: 1.0,  y: [0.30, 0.80], angle: 90, spread: 180, force: 0.95, slot: 2, cooldown: 90,  maxSplats: 2, speed: 0.20, life: 0.9,  trailForce: 220, trailEvery: 55 },
    { name: "highmid", lo: 33, hi: 60,  size: 0.7,  y: [0.45, 0.92], angle: 0,  spread: 180, force: 1.3,  slot: 3, cooldown: 80,  maxSplats: 2, speed: 0.32, life: 0.5, trailForce: 320, trailEvery: 45 },
    { name: "high",    lo: 61, hi: 100, size: 0.45, y: [0.60, 1.00], angle: 0,  spread: 30,  force: 1.7,  slot: 4, cooldown: 70,  maxSplats: 2, speed: 0.55, life: 0.25, trailForce: 480, trailEvery: 35 }
  ],
  // --- fireworks: bursts that spread out and clear the way for the next one instead of piling up into a swirl ---
  FW: {
    amount: 0.6,        // 0..1, set by the slider (0 = old behaviour)
    recent: {},         // per monitor: where the last few bursts landed
    MEMORY_MS: 1500,    // how long a burst's spot counts as 'taken'
    CHAIN_MIN: 0.16, CHAIN_MAX: 0.36, // next burst lands this far (in monitor heights) from the last one
    RING: 6,            // little outward pushes around a strong hit, so it opens up like a firework
    RING_MIN: 0.40,     // hit strength needed before it blooms into a ring
    RING_SIZE: 0.42, RING_FORCE: 0.5, RING_DYE: 0.45, RING_OFFSET: 0.045,
    SIZE_CUT: 0.30,     // in intense sections each burst is this much smaller (at amount 1) so they have room
    TRAIL_CUT: 0.55,    // ...and trails live this much shorter and push less
    CLEAR: 0.9          // ...and old dye fades this much faster (extra), freeing space for the next burst
  },
  // --- delivery -> impact: when waves start on one monitor, each hit is a tight streak that crosses to the other monitor
  //     and only opens up (big bloom + ring) when it lands there ---
  SHOT: {
    T: { bass: 1.5, lowmid: 1.15, mid: 0.9, highmid: 0.7, high: 0.5 }, // seconds to cross (low notes cross slowly, high ones dart)
    MUZZLE: 0.55,       // size of the small bloom where the hit starts, relative to a normal wave
    STREAK_SIZE: 0.4,   // how thick the streak is while crossing (small = tight, not spread out)
    STREAK_DYE: 0.45,   // how bright the streak is while crossing
    PUFFS: 14,          // puffs along one crossing
    IMPACT_SIZE: 1.5,   // size of the bloom where it lands, relative to a normal wave on that monitor
    IMPACT_FORCE: 1.2,  // how hard it shoves the fluid where it lands
    RING: 8,            // outward pushes around the landing spot (the spread happens here)
    INSET: 0.05,        // lands this far into the receiving monitor (0..1 of its width)
    MAX: 22             // cap on streaks in flight; the oldest lands early instead of vanishing
  },
  shots: [],
  emitters: [],
  prev: null,
  state: null
};

// Cleans the raw spectrum before the tracker sees it:
//  1) If Lively sends two 64-bin halves (left channel then right channel) instead of one 128-bin low->high spectrum,
//     fold them together, otherwise the right channel's bass would be mistaken for treble. This is detected automatically.
//  2) Light smoothing across neighbouring bins so a single noisy bin can't fake a note.
const SPEC = { stereoVotes: 0, monoVotes: 0, stereo: false, out: null, tmp: null };
function instrPrepare(a) {
  const n = a.length;
  if (!SPEC.out || SPEC.out.length !== n) { SPEC.out = new Float32Array(n); SPEC.tmp = new Float32Array(n); }
  if (n >= 128) {
    // in a split layout bin 64 is the right channel's BASS, so it is far louder than bin 63 (the left channel's top treble)
    const hi = a[64] + a[65] + a[66], lo = a[61] + a[62] + a[63];
    if (hi + lo > 0.02) {
      if (hi > 3 * lo) SPEC.stereoVotes++; else SPEC.monoVotes++;
      SPEC.stereoVotes *= 0.998; SPEC.monoVotes *= 0.998;
      SPEC.stereo = SPEC.stereoVotes + SPEC.monoVotes > 30 && SPEC.stereoVotes > SPEC.monoVotes * 1.5;
    }
  }
  const t = SPEC.tmp, o = SPEC.out;
  if (SPEC.stereo) {
    const half = n >> 1;
    for (let j = 0; j < n; j++) { const i = Math.min(half - 1, j >> 1); t[j] = Math.max(a[i], a[i + half]); }
  } else {
    for (let j = 0; j < n; j++) t[j] = a[j];
  }
  for (let j = 0; j < n; j++) {
    const l = t[j > 0 ? j - 1 : 0], r = t[j < n - 1 ? j + 1 : n - 1];
    o[j] = 0.25 * l + 0.5 * t[j] + 0.25 * r;
  }
  return o;
}

function instrInit() {
  INSTR.prev = new Float32Array(128);
  INSTR.state = INSTR.bands.map(() => ({ m: 0, d: 0, mp: 0, dp: 0, peak: 0, last: 0, warm: 0, pending: null }));
}

// ---- Display layout ----
// Lively's Span layout stretches one canvas over the bounding box of all monitors. When monitors differ in
// size, part of that canvas is not on any screen, so nothing should spawn (or travel) there.
// Setting format, one entry per monitor, left to right:  WIDTHxHEIGHT@SCALE+TOP
//   e.g.  2560x1440@125, 1920x1080@100+200   (@SCALE = Windows display scale %, default 100;
//   +TOP = pixels down from the top of the canvas, default = vertically centered)
function parseMonitorLayout(text) {
  const items = [];
  for (const part of String(text || "").split(/[;,\n]+/)) {
    const m = /^\s*(\d+)\s*[x×]\s*(\d+)\s*(?:@\s*(\d+(?:\.\d+)?)\s*%?)?\s*(?:\+\s*(-?\d+))?\s*$/i.exec(part);
    if (!m) continue;
    items.push({ w: parseInt(m[1], 10), h: parseInt(m[2], 10), k: (parseFloat(m[3]) || 100) / 100, top: m[4] === undefined ? null : parseInt(m[4], 10) });
  }
  if (items.length < 2) return null;
  // Lively might hand the page a canvas measured in real pixels or in Windows-scaled units, and the page can't tell which.
  // So build the layout both ways and keep the one whose overall shape matches the canvas we actually got.
  const build = (scaled) => {
    const its = items.map((c) => ({ w: scaled ? c.w / c.k : c.w, h: scaled ? c.h / c.k : c.h, top: c.top === null ? null : scaled ? c.top / c.k : c.top }));
    const totalW = its.reduce((a, c) => a + c.w, 0);
    const totalH = Math.max(...its.map((c) => c.h));
    let x = 0;
    const rects = its.map((c) => {
      const top = c.top === null ? (totalH - c.h) / 2 : c.top;
      const r = { x0: x / totalW, x1: (x + c.w) / totalW, y1: 1 - top / totalH, y0: 1 - (top + c.h) / totalH };
      r.y0 = Math.max(0, r.y0); r.y1 = Math.min(1, r.y1);
      x += c.w;
      return r;
    });
    const tallest = Math.max(...rects.map((r) => r.y1 - r.y0));
    rects.forEach((r) => { r.s = (r.y1 - r.y0) / tallest; }); // 1 for the tallest monitor, smaller for shorter ones
    return { rects, aspect: totalW / totalH };
  };
  const scaledL = build(true), physL = build(false);
  const canvasAspect = innerWidth / Math.max(1, innerHeight);
  if (!(canvasAspect > 0) || !isFinite(canvasAspect)) return scaledL.rects;
  const err = (L) => Math.abs(Math.log(L.aspect / canvasAspect));
  return err(physL) < err(scaledL) - 0.02 ? physL.rects : scaledL.rects;
}

// On-screen rectangle of monitor m out of n (normalised canvas coordinates, y up).
function monRect(m, n) {
  if (MONITORS.rects && MONITORS.rects.length === n && n > 1) return MONITORS.rects[m];
  return { x0: m / n, x1: (m + 1) / n, y0: 0, y1: 1 };
}

// How big waves should be on monitor m, relative to the tallest monitor (1 = same as the tallest).
// Waves are sized against the whole spanned canvas, so on a shorter monitor they would look too big for that screen.
function monScale(m, n) {
  if (!(MONITORS.rects && MONITORS.rects.length === n && n > 1)) return 1;
  const s = MONITORS.rects[m].s || 1;
  return 1 + (s - 1) * MONITORS.SIZE_FOLLOW;
}

// Which monitors a hit comes from: one, another, or several at once (same idea as the per-monitor waves).
function srcMonitor(n) { // the monitor waves start on, or -1 when every monitor makes its own
  if (!MONITORS.enabled || n <= 1) return -1;
  return MONITORS.sourceMode === 1 ? 0 : MONITORS.sourceMode === 2 ? n - 1 : -1;
}
function instrSources() {
  const n = MONITORS.enabled ? MONITORS.count : 1;
  if (n <= 1) return [{ m: 0, n: 1, toward: 0 }];
  const sm = srcMonitor(n);
  if (sm >= 0) { // one starting monitor, aimed at one of the others
    let t = Math.floor(Math.random() * (n - 1)); if (t >= sm) t++;
    return [{ m: sm, n, toward: t > sm ? 1 : -1, target: t }];
  }
  const out = [];
  for (let m = 0; m < n; m++) {
    if (Math.random() < 0.5) continue;
    out.push({ m, n, toward: m === 0 ? 1 : m === n - 1 ? -1 : Math.random() < 0.5 ? -1 : 1 });
  }
  if (out.length === 0) {
    const m = Math.floor(Math.random() * n);
    out.push({ m, n, toward: m === 0 ? 1 : m === n - 1 ? -1 : Math.random() < 0.5 ? -1 : 1 });
  }
  return out;
}

// The color for a band: its own slot of the album palette (so an instrument keeps its color).
function instrRoleSlot(role, n) {
  const idx = INSTR.ROLE_ORDER.indexOf(role);
  if (idx >= 0 && idx < n) return idx;
  return Math.min(1, n - 1); // no spare color for this role: it joins the "track"
}

function instrColor(band, role, forceIdx, age, heat0, strength) { // fire mode: heat0 = heat the wave was born at, age = 0 (just born) .. 1 (end of its life)
  const pair = twoTonePair();
  if (pair) return twoToneColor(pair, forceIdx === 0 || forceIdx === 1 ? forceIdx : twoToneNextIndex());
  const active = paletteCurrent.filter((c) => c.w > 0);
  if (active.length > 2 && active[0].fire) return fireColor(active, (heat0 === undefined ? fireBirthHeat() : heat0) + (age || 0) * fireCool(band, strength)); // fire: born at the drifting heat, cooling toward red as the wave ages
  if (active.length > 2 && active[0].rotate) { // 3+ color art: primary, secondary, next of the rest
    const rc = rotationColor(active), jr = 0.85 + Math.random() * 0.15;
    return { r: rc.r * jr * 0.15, g: rc.g * jr * 0.15, b: rc.b * jr * 0.15 };
  }
  let pick = active.length ? active[instrRoleSlot(role || "track", active.length)] : paletteCurrent[0];
  const multi = active.length > 2;
  const flag = active.some((c) => c.america); // flag palette: every instrument keeps its own flag color (see americaAdjust), no weighted picks, no primary lean
  if (flag) { // each instrument plays its own flag color (AMERICA.ROLE_COLOR); anything unlisted plays red
    const slot = AMERICA.SLOT[AMERICA.ROLE_COLOR[role || "track"] || "red"];
    pick = active[Math.min(slot, active.length - 1)];
    if (AMERICA.WHITE_SUB > 0 && AMERICA.WHITE_SUB_ROLES.indexOf(role) >= 0 && Math.random() < AMERICA.WHITE_SUB) {
      pick = active[Math.min(AMERICA.SLOT.white, active.length - 1)]; // white takes over this drum / bass hit
    }
  }
  if (multi && !flag && Math.random() >= ART.MULTI_ROLE_SHARE) { // multi-color art: most hits pick from the whole palette by weight, so every color shows (roles only have 5 slots)
    let total = 0; for (const c of active) total += c.w;
    let rand = Math.random() * total;
    for (const c of active) { rand -= c.w; if (rand <= 0) { pick = c; break; } }
  }
  // Primary color: a fixed extra share of hits from every role (much smaller on multi-color art, where its palette weight already leads)
  const lean = multi ? ART.PRIMARY_BIAS * ART.MULTI_PRIMARY_BIAS : ART.PRIMARY_BIAS;
  if (!flag && ART.PRIMARY_ENABLED && Math.random() < lean) {
    const primary = active.find((c) => c.primary);
    if (primary) pick = primary;
  }
  const j = 0.85 + Math.random() * 0.15;
  return { r: pick.r * j * 0.15, g: pick.g * j * 0.15, b: pick.b * j * 0.15 };
}

// Best guess at who made this hit, from the band it landed in plus how pitched / sharp it was.
function instrClassify(band, flat, sharp) {
  const tonal = flat < INSTR.TONAL_FLAT;
  switch (band.name) {
    case "bass": return sharp > INSTR.KICK_SHARP ? "drums" : "bass";
    case "lowmid":
    case "mid": return tonal ? "vocals" : "drums";
    case "highmid": return tonal ? "guitar" : "drums";
    default: return tonal ? "track" : "drums";
  }
}

// Volume -> wave size: quiet moments give small waves, loud moments give big ones.
// The loudest / hardest hits are the normal size; softer hits are smaller, down to VOL_MIN.
// "level" blends how loud the song is right now with how hard this particular hit was.
function instrVolumeScale(vol, strength) {
  const level = Math.min(1, (0.5 * Math.max(0, Math.min(1, vol)) + 0.5 * Math.max(0, Math.min(1, strength))) / 0.9);
  const f = INSTR.VOL_MIN + (INSTR.VOL_MAX - INSTR.VOL_MIN) * Math.pow(level, 1.5);
  return 1 + (f - 1) * INSTR.VOL_AMOUNT;
}

// Song intensity -> how hard everything hits. At the song's sparse moments waves are smaller, fewer and shorter;
// at a climax or drop they are bigger, more numerous and carry further. 0.5 intensity is roughly "normal".
function instrIntensityScale() {
  const a = INSTR.INT_AMOUNT, x = INSTR.eff;
  const f = (lo, hi) => 1 + (lo + (hi - lo) * x - 1) * a;
  return { size: f(0.65, 1.3) * INSTR.dropBoost, force: f(0.75, 1.3), bright: f(0.75, 1.25), count: f(0.6, 1.5), life: f(0.6, 1.3) };
}

// Called every audio frame. Intensity blends how loud this moment is against the loudest part of the last ~30 s
// with how busy it is (how many instruments are hitting). It rises quickly and falls slowly, so builds feel like
// they grow and sparse parts feel like they shrink away. A sudden jump from quiet to loud fires a drop burst.
function instrUpdateIntensity(overall, now) {
  let dt = INSTR._t ? now - INSTR._t : 33;
  INSTR._t = now;
  dt = Math.max(5, Math.min(200, dt));
  INSTR._med += (overall - INSTR._med) * (1 - Math.exp(-dt / 1000));
  if (now - INSTR._ringT >= 250) {
    INSTR._ringT = now;
    INSTR._ring.push(INSTR._med);
    if (INSTR._ring.length > 120) INSTR._ring.shift();
  }
  let ref = INSTR.VOL_FLOOR;
  for (let i = 0; i < INSTR._ring.length; i++) if (INSTR._ring[i] > ref) ref = INSTR._ring[i];
  const loud = Math.min(1, INSTR._med / ref);

  while (INSTR.densHits.length && now - INSTR.densHits[0] > 2000) INSTR.densHits.shift();
  const n = INSTR.densHits.length;
  INSTR.densMax = Math.max(6, n, INSTR.densMax * 0.9995);
  const busy = Math.min(1, n / INSTR.densMax);

  const target = Math.pow(0.65 * Math.pow(loud, 1.4) + 0.35 * busy, 1.1);
  const tau = target > INSTR.intensity ? 250 : 1100; // grow fast, shrink slowly
  INSTR.intensity += (target - INSTR.intensity) * (1 - Math.exp(-dt / tau));
  // a new song has no history yet, so everything looks like its loudest moment: stay neutral until the range is known
  INSTR._warm += dt;
  const wk = Math.min(1, INSTR._warm / INSTR.WARM_TIME);
  INSTR.eff = 0.5 + (INSTR.intensity - 0.5) * wk;

  // drop: it was quiet about a second ago and is suddenly loud
  if (INSTR.INT_AMOUNT > 0 && INSTR._ring.length >= 6 && INSTR._warm > 4000 && now - INSTR.lastDrop > INSTR.DROP_COOLDOWN) {
    const before = INSTR._ring[INSTR._ring.length - 5] / ref; // roughly 1 s ago
    if (before < INSTR.DROP_FROM && loud > INSTR.DROP_TO) {
      INSTR.lastDrop = now;
      INSTR.intensity = Math.max(INSTR.intensity, 0.9);
      INSTR.eff = Math.max(INSTR.eff, 0.9);
      INSTR.dropBoost = 1.3;
      for (let b = 0; b < 4; b++) instrFire(INSTR.bands[b], 1, 1, b === 0 ? "drums" : "track");
      INSTR.dropBoost = 1;
    }
  }
}

// New song: forget the old song's range.
function instrResetIntensity() {
  autoPulseReset();
  INSTR._ring = [];
  INSTR._med = 0;
  INSTR._t = 0;
  INSTR._warm = 0;
  INSTR.intensity = 0.5;
  INSTR.eff = 0.5;
  INSTR.densHits = [];
  INSTR.densMax = 6;
}

// How far into an intense section we are, 0 (calm / neutral) .. 1 (climax), scaled by the fireworks slider.
function fwIntense() {
  const FW = INSTR.FW;
  if (!INSTR.enabled || FW.amount <= 0) return 0;
  return Math.max(0, Math.min(1, (INSTR.eff - 0.5) * 2)) * FW.amount;
}

// Picks where a hit lands on its monitor. It tries a few spots, some chained off the last burst on that monitor and some
// random, and takes the one furthest from every recent burst, so bursts spread across the screen like fireworks.
function instrPlace(band, rc, m) {
  const FW = INSTR.FW, h = rc.y1 - rc.y0, w = rc.x1 - rc.x0;
  const yLo = rc.y0 + band.y[0] * h, yHi = rc.y0 + band.y[1] * h;
  const xLo = rc.x0 + 0.08 * w, xHi = rc.x0 + 0.92 * w;
  const randSpot = () => ({ x: xLo + Math.random() * (xHi - xLo), y: yLo + Math.random() * (yHi - yLo) });
  if (FW.amount <= 0) return randSpot();
  const now = performance.now();
  const list = (FW.recent[m] = (FW.recent[m] || []).filter((p) => now - p.t < FW.MEMORY_MS));
  const aspect = canvas.width / canvas.height;
  const last = list.length ? list[list.length - 1] : null;
  const tries = 3 + Math.round(6 * FW.amount);
  let best = null, bestScore = -1;
  for (let i = 0; i < tries; i++) {
    let c;
    if (last && i % 2 === 0) {
      const d = (FW.CHAIN_MIN + Math.random() * (FW.CHAIN_MAX - FW.CHAIN_MIN)) * h, a = Math.random() * Math.PI * 2;
      c = { x: Math.min(xHi, Math.max(xLo, last.x + (Math.cos(a) * d) / aspect)), y: Math.min(yHi, Math.max(yLo, last.y + Math.sin(a) * d)) };
    } else c = randSpot();
    let score = 9;
    for (const p of list) score = Math.min(score, Math.hypot((c.x - p.x) * aspect, c.y - p.y));
    if (score > bestScore) { bestScore = score; best = c; }
  }
  list.push({ x: best.x, y: best.y, t: now });
  if (list.length > 10) list.shift();
  return best;
}

// Delivery -> impact. The hit starts as a small bloom on the starting monitor and a tight streak carries it across;
// where it lands on the receiving monitor it opens up into a big bloom and a ring, so the spread happens on impact.
function instrShoot(band, src, spot, rc, color, strength, volScale, msFrom, I) {
  const SH = INSTR.SHOT, aspect = canvas.width / canvas.height;
  const rt = monRect(src.target, src.n), msTo = monScale(src.target, src.n);
  const frac = (spot.y - rc.y0) / Math.max(1e-6, rc.y1 - rc.y0); // keep its height on screen: low notes land low, high notes land high
  const ty = rt.y0 + Math.min(0.94, Math.max(0.06, frac + (Math.random() - 0.5) * 0.2)) * (rt.y1 - rt.y0);
  const tx = src.toward > 0 ? rt.x0 + SH.INSET * (rt.x1 - rt.x0) : rt.x1 - SH.INSET * (rt.x1 - rt.x0);
  const T = (SH.T[band.name] || 0.9) / (0.5 + INSTR.CALM) * (0.85 + 0.3 * Math.random());
  const hx = (tx - spot.x) * aspect, hy = ty - spot.y, hl = Math.max(1e-6, Math.hypot(hx, hy));
  const dirx = hx / hl, diry = hy / hl; // direction in screen-height units
  const mag = (500 + 1500 * strength) * band.force * I.force * INSTR.CALM;
  // the starting bloom: small, pushed toward the other monitor
  splat(spot.x, spot.y, dirx * mag, diry * mag, color, band.size * volScale * msFrom * SH.MUZZLE);
  if (INSTR.shots.length >= SH.MAX) instrLand(INSTR.shots.shift());
  INSTR.shots.push({
    band, color, strength, mag, dirx, diry, x: spot.x, y: spot.y, tx, ty, toward: src.toward,
    vx: (tx - spot.x) / T, vy: (ty - spot.y) / T, age: 0, life: T * 1.35, next: 0, every: (T * 1000) / SH.PUFFS,
    vol: volScale, msFrom, msTo
  });
}

function instrLand(e) {
  const SH = INSTR.SHOT, band = e.band, scale = e.vol * e.msTo;
  const c = { r: e.color.r, g: e.color.g, b: e.color.b };
  const f = e.mag * SH.IMPACT_FORCE;
  splat(e.tx, e.ty, e.dirx * f, e.diry * f, c, band.size * scale * SH.IMPACT_SIZE);
  instrRing(band, e.tx, e.ty, e.mag, Math.max(e.strength, 0.6), scale * 1.2, c, true);
}

function instrShotsTick(dt) {
  const list = INSTR.shots;
  if (!list.length) return;
  const SH = INSTR.SHOT;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    e.age += dt;
    e.x += e.vx * dt; e.y += e.vy * dt;
    const arrived = e.toward > 0 ? e.x >= e.tx : e.x <= e.tx;
    if (arrived || e.age >= e.life) { list.splice(i, 1); instrLand(e); continue; }
    e.next -= dt * 1000;
    if (e.next > 0) continue;
    e.next = e.every;
    const t = e.age / (e.life / 1.35), band = e.band;
    const k = SH.STREAK_DYE * (0.5 + 0.5 * (1 - t));
    const c = { r: e.color.r * k, g: e.color.g * k, b: e.color.b * k };
    const f = band.trailForce * (0.6 + 0.4 * e.strength) * (0.5 + 0.5 * INSTR.CALM);
    splat(e.x, e.y, e.dirx * f, e.diry * f, c, band.size * 0.6 * e.vol * e.msFrom * SH.STREAK_SIZE);
  }
}

// A strong hit also opens outward in a ring of small pushes (the "firework" look) instead of only shoving one way.
function instrRing(band, x, y, mag, strength, scale, color, full) {
  const FW = INSTR.FW;
  if (!full && (FW.amount <= 0 || strength < FW.RING_MIN)) return;
  const amt = full ? 1 : FW.amount;
  const n = full ? INSTR.SHOT.RING : Math.max(3, Math.round(FW.RING * (0.5 + 0.5 * FW.amount)));
  const aspect = canvas.width / canvas.height;
  const off = FW.RING_OFFSET * Math.sqrt(band.size) * scale;
  const a0 = Math.random() * Math.PI * 2, k = FW.RING_DYE * amt;
  const c = { r: color.r * k, g: color.g * k, b: color.b * k };
  for (let i = 0; i < n; i++) {
    const a = a0 + (i * Math.PI * 2) / n;
    const f = mag * FW.RING_FORCE * amt;
    splat(x + (Math.cos(a) * off) / aspect, y + Math.sin(a) * off, Math.cos(a) * f, Math.sin(a) * f, c, band.size * scale * FW.RING_SIZE);
  }
}

function instrFire(band, strength, vol, role) {
  const I = instrIntensityScale();
  const fwI = fwIntense();
  const volScale = instrVolumeScale(vol, strength) * I.size * (1 - INSTR.FW.SIZE_CUT * fwI);
  const count = Math.max(1, Math.round(1 + strength * (band.maxSplats - 1) * I.count));
  for (let i = 0; i < count; i++) {
    for (const src of instrSources()) {
      const ci = twoTonePair() ? twoToneNextIndex() : -1; // two-color songs: this blip (and its trail) takes the next color in the sequence
      const fh = fireBirthHeat(); // fire mode: the heat this wave (and its trail) is born at
      const color = instrColor(band, role, ci, 0, fh);
      const bright = 10.0 * (0.6 + 0.4 * strength) * I.bright * (0.35 + 0.65 * Math.pow(INSTR.CALM, 0.7)) * config.PULSE_BRIGHT; // calmer / quieter = less dye
      color.r *= bright; color.g *= bright; color.b *= bright;
      const rc = monRect(src.m, src.n);
      const ms = monScale(src.m, src.n); // smaller monitor, smaller waves
      const spot = instrPlace(band, rc, src.m);
      const x = spot.x, y = spot.y;
      if (src.target !== undefined) { instrShoot(band, src, spot, rc, color, strength, volScale, ms, I); continue; }
      // direction: centered on the band's angle, strays by up to its spread; highs also randomly flip left / right
      let angle = band.angle + (Math.random() * 2 - 1) * band.spread;
      if (band.name === "high" && Math.random() < 0.5) angle += 180;
      const rad = (angle * Math.PI) / 180;
      const mag = (500 + 1500 * strength) * band.force * I.force * INSTR.CALM;
      const dx = Math.cos(rad) * mag + src.toward * MONITORS.CROSS_PUSH * strength;
      const dy = Math.sin(rad) * mag;
      splat(x, y, dx, dy, color, band.size * volScale * ms);
      instrRing(band, x, y, mag, strength, volScale * ms, color);
      instrSpawnTrail(band, x, y, angle, strength, volScale * ms, src.toward, role, src, ci, ms, fh);
    }
  }
}

// A hit leaves a moving source behind it: low notes drift slowly and keep going for a long time,
// high notes dart off fast and die quickly. The source keeps puffing dye and a gentle push as it goes.
function instrSpawnTrail(band, x, y, angleDeg, strength, volScale, toward, role, src, ci, ms, fh) {
  if (INSTR.TRAVEL_AMOUNT <= 0) return;
  if (INSTR.emitters.length >= Math.max(3, Math.round(INSTR.MAX_EMITTERS * (0.25 + 0.75 * INSTR.CALM)))) INSTR.emitters.shift(); // calmer = fewer trails alive at once
  const life = band.life * (0.65 + 0.35 * strength) * (0.4 + 0.6 * INSTR.TRAVEL_AMOUNT) * instrIntensityScale().life * (1 - INSTR.FW.TRAIL_CUT * fwIntense());
  INSTR.emitters.push({
    band, role, x, y, angle: (angleDeg * Math.PI) / 180, strength, volScale, toward, ci, fh, ms: ms || 1, fw: 1 - INSTR.FW.TRAIL_CUT * 0.6 * fwIntense(),
    // the trail dies at the edge of the monitor it was born on, so each monitor keeps its own waves
    homeLo: src && src.n > 1 ? monRect(src.m, src.n).x0 : -OS.o,
    homeHi: src && src.n > 1 ? monRect(src.m, src.n).x1 : 1 + OS.o,
    homeBot: src && src.n > 1 ? monRect(src.m, src.n).y0 : -OS.o,
    homeTop: src && src.n > 1 ? monRect(src.m, src.n).y1 : 1 + OS.o,
    age: 0, life, next: 0
  });
}

function instrTick(dt) {
  instrShotsTick(dt);
  const list = INSTR.emitters;
  if (!list.length) return;
  const aspect = canvas.width / canvas.height;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i], band = e.band;
    e.age += dt;
    if (e.age >= e.life) { list.splice(i, 1); continue; }
    const fade = 1 - e.age / e.life;
    // move in screen-height units so a distance means the same thing sideways and up
    const step = band.speed * dt * (0.35 + 0.65 * INSTR.CALM) * (e.ms || 1);
    e.x += (Math.cos(e.angle) * step) / aspect;
    e.y += Math.sin(e.angle) * step;
    if (e.x < e.homeLo || e.x > e.homeHi || e.y < e.homeBot || e.y > e.homeTop) { list.splice(i, 1); continue; }
    e.next -= dt * 1000;
    if (e.next > 0) continue;
    e.next = band.trailEvery / INSTR.CALM; // calmer = fewer puffs
    const color = instrColor(band, e.role, e.ci, e.age / e.life, e.fh, e.strength);
    const bright = 10.0 * 0.4 * fade * fade * (0.6 + 0.4 * e.strength) * (0.25 + 0.75 * INSTR.env) * (0.5 + 0.5 * Math.sqrt(INSTR.CALM)) * config.PULSE_BRIGHT;
    color.r *= bright; color.g *= bright; color.b *= bright;
    const f = band.trailForce * fade * (0.6 + 0.4 * e.strength) * INSTR.CALM * (e.fw || 1);
    const dx = Math.cos(e.angle) * f;
    const dy = Math.sin(e.angle) * f;
    splat(e.x, e.y, dx, dy, color, band.size * 0.6 * e.volScale);
  }
}

function instrumentPulse(audio) {
  if (!INSTR.prev) instrInit();
  const sens = INSTR.sensitivity;
  const k = 3.6 - 2.0 * sens; // how far above its normal wiggle a band must jump (sensitive = smaller jump)
  const now = Date.now();
  // overall volume right now versus this song's recent loudest moment
  let overall = 0;
  for (let i = 0; i < audio.length; i++) overall += audio[i];
  overall /= Math.max(1, audio.length);
  INSTR.globalPeak = Math.max(overall, INSTR.globalPeak * 0.9998, INSTR.VOL_FLOOR); // slow-fading record of the loudest moment
  const overallNorm = INSTR.globalPeak > 0 ? overall / INSTR.globalPeak : 0;
  INSTR.env = Math.max(overallNorm * overallNorm, INSTR.env * 0.88); // quick attack, fast fall: follows each beat
  instrUpdateIntensity(overall, now);
  quietUpdate(audio); // quiet passages: dimmer dye that fades faster, same as the stock mode
  while (INSTR.hits.length && now - INSTR.hits[0] > 1000) INSTR.hits.shift();
  for (let b = 0; b < INSTR.bands.length; b++) {
    const band = INSTR.bands[b], st = INSTR.state[b];
    const hi = Math.min(band.hi, audio.length - 1);
    let flux = 0, level = 0, logSum = 0, cnt = 0, peakFlux = 0, peakBin = 0;
    for (let i = band.lo; i <= hi; i++) {
      const v = audio[i];
      const up = v - INSTR.prev[i];
      if (up > 0) {
        flux += up;
        if (up > peakFlux) { peakFlux = up; peakBin = v; }
      }
      level += v;
      logSum += Math.log(v + 1e-5);
      cnt++;
      INSTR.prev[i] = v;
    }
    if (cnt === 0) continue;
    flux /= cnt; level /= cnt;
    const flat = level > 0 ? Math.min(1, Math.exp(logSum / cnt) / level) : 1; // 0 = one clean pitch, 1 = flat noise
    st.peak = Math.max(level, st.peak * 0.997);
    if (st.warm < 20) { st.warm++; st.m = st.m * 0.5 + flux * 0.5; st.mp = st.mp * 0.5 + peakFlux * 0.5; continue; } // learn this song's normal level first

    // A hit spotted last frame fires now only if the band is still going: single-frame glitches die here.
    if (st.pending) {
      const p = st.pending;
      st.pending = null;
      const recentHits = INSTR.hits.length;
      const mergedDrum = p.role === "drums" && now - INSTR.lastDrum < INSTR.DRUM_MERGE;
      if (!mergedDrum && level >= INSTR.CONFIRM_RATIO * p.level && (recentHits < INSTR.MAX_HITS_PER_SEC || p.strength > 0.85)) {
        INSTR.hits.push(now);
        INSTR.densHits.push(now);
        if (p.role === "drums") INSTR.lastDrum = now;
        instrFire(band, p.strength, overallNorm, p.role);
      }
    }

    const thr = st.m + k * st.d + INSTR.MIN_FLUX;
    const thrP = st.mp + k * st.dp + INSTR.MIN_FLUX;
    // Two ways to be a hit: lots of the band jumped at once (drums, noisy hits), or one pitch inside it
    // jumped sharply (a sung / played note, even when other sounds in the same band are louder).
    const broad = flux > thr && flux >= INSTR.PROMINENCE * level;
    const pitched = !broad && peakFlux > thrP && peakBin > 0 && peakFlux >= INSTR.PEAK_PROMINENCE * peakBin;
    if (
      !st.pending &&
      (broad || pitched) &&
      level > INSTR.MIN_LEVEL &&
      level >= INSTR.GATE_REL * st.peak &&   // not just bleed from a louder moment
      now - st.last > band.cooldown
    ) {
      st.last = now;
      const ref = broad ? thr : thrP, amt = broad ? flux : peakFlux;
      const over = (amt - ref) / ref;                 // how far past the threshold
      const loud = st.peak > 0 ? level / st.peak : 1; // how loud versus this band's recent best
      const strength = Math.max(0.3, Math.min(1, 0.35 + 0.45 * over + 0.3 * loud));
      const sharp = level > 0 ? flux / level : 0;     // how much of the band's energy is brand new
      // a pitched-only hit is tonal by definition; a broad one is judged by how flat its spectrum is
      const role = instrClassify(band, pitched ? 0 : flat, sharp);
      st.pending = { level, strength, role };
    }
    // adaptive stats updated after the check, so the hit itself doesn't hide from its own threshold
    st.d = st.d * 0.94 + Math.abs(flux - st.m) * 0.06;
    st.m = st.m * 0.94 + flux * 0.06;
    st.dp = st.dp * 0.94 + Math.abs(peakFlux - st.mp) * 0.06;
    st.mp = st.mp * 0.94 + peakFlux * 0.06;
  }
}
// END INSTR

const ART = {
  SAMPLE_SIZE: 128,       // art is downscaled to this many pixels square before sampling (bigger = thin accents like a rainbow beam keep their true color)
  BLACK_MAX: 45,          // a pixel whose brightest channel is below this counts as black and is ignored
  MIN_SAT: 0.10,          // MASK: a pixel below this saturation is grayscale (black / gray / white) and is thrown away completely, it never takes part in any decision. Anything with even a slight tint (cream, beige, sepia, warm / cool grays) stays and simply scores low, so it only matters when nothing stronger is around
  WHITE_MIN_VAL: 0.80,    // MASK: a pixel at least this bright AND at most WHITE_MAX_SAT saturated is closer to white than to any color, so it is dismissed as white (off-white / cream icons, anti-aliased fringes around a white shape)
  WHITE_MAX_SAT: 0.20,    // ...for any hue
  WARM_WHITE_MAX_SAT: 0.30, // ...and for warm cream / ivory hues (WARM_HUE) up to this, so off-white never turns into a vivid yellow
  WARM_HUE: [20, 70],     // degrees
  PARTNER_VAL: 0.45,      // single-color art: its partner is the same hue at this brightness (a darker tone for contrast)
  BLEND_MIN_DIST: 0.43,   // anti-aliasing mask: a pixel whose two opposite neighbors differ by more than this (0-1 RGB distance) and which sits on the straight line between them is just the blur where two colors meet (yellow meeting blue makes a green fringe), not a color of the art, so it is ignored
  BLEND_TOLERANCE: 0.30,  // how close to that line (as a share of the neighbors' distance) counts as "on the line"
  BLEND_MUDDY: 0.85,      // ...and a real blend is also muddier than its parents: its saturation must be below this fraction of the more saturated neighbor (so a thin, vivid band of the art, like a blue stripe between cyan and violet, is kept)
  MIN_AREA_SHARE: 0.005,  // a hue must cover at least this share of the colored pixels to become a wave color; smaller slivers hand their area to the nearest picked hue
  MIN_COLOR_SHARE: 0.002, // noise floor: if fewer than this share of the art's pixels survive the mask (a speck / compression noise on a black & white cover), the art counts as black & white and your two colors are used. Set 0 to turn off
  BUCKETS: 36,            // hue buckets (10 degrees each)
  MIN_HUE_GAP: 25,        // picked colors must differ in hue by at least this many degrees
  SCORE_POWER: 0.5,       // colors are ranked by (area x vividness) to this power; below 1 stops a big orange border from drowning out small blue / red accents
  MIN_SCORE_RATIO: 0.04,  // ignore colors ranking below this fraction of the best one (low = small accents still count)
  YELLOW_HUE: [45, 70],   // degrees: a picked color in this range is yellow. Yellow is never the primary (first) color; if it is in the art it takes the secondary slot
  ROTATE_MIN_COLORS: 3,   // art with at least this many colors uses the primary / secondary / rest rotation instead of weighted random picks
  MAX_COLORS: 8,          // the fluid gets up to this many of the album's colors
  MULTI_PRIMARY_EXTRA: 0.10, // 3+ colors: how far the primary color's share rises above a fair 1/n share (scaled by the 'Primary color strength' slider)
  MULTI_PRIMARY_BIAS: 0.15,  // 3+ colors: only this fraction of the normal primary hit bias is applied to instruments
  MULTI_ROLE_SHARE: 0.35,    // 3+ colors: share of instrument hits that use their own role color; the rest pick from the whole palette by weight, so all colors (up to 8) show up
  SAT_MIN: 0.85,          // every picked color is pushed to at least this saturation, so colors pop
  VAL_MIN: 0.95,          // ...and at least this brightness
  EASE_TIME: 0.3,         // seconds, roughly 1s to settle when easing (track changes snap instead)
  // --- primary color: the color covering the most of the art leads the palette (other colors stay, just quieter) ---
  PRIMARY_ENABLED: true,   // master switch (also a checkbox in the wallpaper properties)
  PRIMARY_MIN_SAT: 0.25,   // a pixel only counts toward the primary color at/above this saturation (white, gray and tinted-white never count)
  PRIMARY_MIN_VAL: 0.20,   // ...and this brightness (black and near-black never count)
  PRIMARY_MIN_SHARE: 0.02, // the primary color must cover at least this share of the art, otherwise there is no primary and colors work as before
  PRIMARY_WEIGHT: 0.60,    // share of random splats (ambient / cursor / bursts) that use the primary color; the other album colors share the rest
  PRIMARY_BIAS: 0.54,      // share of instrument hits (drums, bass, guitar, vocals...) that use the primary color whatever their role (also a slider)
  // --- music start / stop / track change detection ---
  SOUND_THRESHOLD: 0.005, // audio level that counts as "music is playing"
  STOP_DELAY: 4500,       // ms of silence before music counts as stopped (fluid returns to the default colors); set by the 'End-of-song fade hold' slider
  LINGER_MUL: 0.5,        // once music has stopped, the dye fades at this fraction of its normal speed so the tail stays on screen (1 = no hold); set by the same slider
  TRACK_GONE_DELAY: 1200, // ms with no track reported before it counts as gone (players blip between songs)
  NEW_ART_WAIT: 900,      // max ms to wait for the new song's art after a track change
  FLUSH_DISSIPATION: 3.5, // how fast the old song's color is washed out on a track change (stock is 1)
  FLUSH_TIME: 800,        // ms the wash-out lasts
  BURST_SPLATS: 20        // splats fired in the new colors once the new art is in (the album 'explosion')
};

// Default colors, used in silence / with no track / with black & white or non-vibrant art.
// Set with the two color pickers in the wallpaper properties (defaults: red #FF0000 and rose #FF9494).
const FALLBACK_PALETTE = [
  { r: 1.0, g: 0.0, b: 0.0, w: 0.55 },
  { r: 1.0, g: 148 / 255, b: 148 / 255, w: 0.45 },
  { r: 1.0, g: 148 / 255, b: 148 / 255, w: 0.0 }
];

function setDefaultColor(index, hex) {
  const c = hexToRgb(hex);
  if (!c) return;
  const k = 1 / 255; // hexToRgb gives 0..255
  FALLBACK_PALETTE[index].r = c.r * k;
  FALLBACK_PALETTE[index].g = c.g * k;
  FALLBACK_PALETTE[index].b = c.b * k;
  if (index === 0) { // third slot is just a padding copy of the second
    FALLBACK_PALETTE[2].r = FALLBACK_PALETTE[1].r; FALLBACK_PALETTE[2].g = FALLBACK_PALETTE[1].g; FALLBACK_PALETTE[2].b = FALLBACK_PALETTE[1].b;
  } else {
    FALLBACK_PALETTE[2].r = c.r * k; FALLBACK_PALETTE[2].g = c.g * k; FALLBACK_PALETTE[2].b = c.b * k;
  }
  if (typeof refreshTarget === "function" && typeof _hasTrack !== "undefined") refreshTarget(false);
}

// Palettes always hold MAX_COLORS slots so blending between them lines up; unused slots have weight 0.
function padSlots(slots) {
  const out = slots.map((c) => Object.assign({}, c));
  while (out.length < ART.MAX_COLORS) out.push(Object.assign({}, out[out.length - 1], { w: 0 }));
  return out;
}

let paletteCurrent = padSlots(FALLBACK_PALETTE);
let paletteTarget = padSlots(FALLBACK_PALETTE);
let _artToken = 0;
let _lastThumb = null;        // art of the current track
let _trackKey = null;         // identity of the current track (title | artist | album)
let _hasTrack = false;
let _thumbSeen = false;       // any art reported for the current track yet
let _artSlots = null;         // palette built from the current track's art, null if none usable
let _waitingArt = false;      // a track change happened and the new art has not arrived yet
let _holdSplats = false;      // no splats while waiting, so the old song's color doesn't bleed in
let _waitTimer = null;
let _goneTimer = null;
let _flushTimer = null;
let _flushEnd = 0;
let _baseDensity = null;
let _lastSoundTime = Date.now();
let _soundActive = true;
let _lingerMul = 1;           // eased multiplier on dye fade speed (below 1 while music is stopped)
let _colorOverride = false;   // true = ignore the album and use the two chosen colors
let _duoMode = true;          // two-color (duo) splat logic. ON only for: your own colors (override, no art, black & white art) or art with just 1-2 detected colors. OFF for multi-color art so all of its colors are used

function artRgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

// px = RGBA byte array. Returns up to MAX_COLORS colors (0..1 rgb) sorted best first, or null if nothing usable.
function extractArtColors(px) {
  const B = ART.BUCKETS;
  const newBucket = () => ({ w: 0, r: 0, g: 0, b: 0, score: 0, n: 0 });
  const buckets = [];
  for (let i = 0; i < B; i++) buckets.push(newBucket());
  const primB = [];
  for (let i = 0; i < B; i++) primB.push({ n: 0, r: 0, g: 0, b: 0 });
  let opaque = 0, colorPx = 0;

  // Mark anti-aliasing blends (see ART.BLEND_*): checked along 4 directions through every pixel
  const NPX = px.length / 4, SIDE = Math.round(Math.sqrt(NPX));
  const blend = new Uint8Array(NPX);
  if (SIDE * SIDE === NPX) {
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (let y = 1; y < SIDE - 1; y++) {
      for (let x = 1; x < SIDE - 1; x++) {
        const k = (y * SIDE + x) * 4;
        for (const [dx, dy] of dirs) {
          const l = ((y - dy) * SIDE + (x - dx)) * 4, r2 = ((y + dy) * SIDE + (x + dx)) * 4;
          let dLR = 0, dPM = 0;
          for (let c = 0; c < 3; c++) {
            const lr = px[l + c] - px[r2 + c], pm = px[k + c] - (px[l + c] + px[r2 + c]) / 2;
            dLR += lr * lr; dPM += pm * pm;
          }
          dLR = Math.sqrt(dLR) / 255; dPM = Math.sqrt(dPM) / 255;
          if (dLR > ART.BLEND_MIN_DIST && dPM < ART.BLEND_TOLERANCE * dLR) {
            const sat = (q) => { const mx = Math.max(px[q], px[q + 1], px[q + 2]), mn = Math.min(px[q], px[q + 1], px[q + 2]); return mx > 0 ? (mx - mn) / mx : 0; };
            if (sat(k) < ART.BLEND_MUDDY * Math.max(sat(l), sat(r2))) { blend[y * SIDE + x] = 1; break; }
          }
        }
      }
    }
  }

  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    opaque++;
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    if (Math.max(r, g, b) * 255 < ART.BLACK_MAX) continue; // black is masked out
    const hsv = artRgbToHsv(r, g, b);
    if (hsv.s < ART.MIN_SAT) continue; // grayscale (gray / white) is masked out: from here on only real, even slightly tinted, color exists
    if (hsv.v >= ART.WHITE_MIN_VAL) { // off-white: bright and barely saturated counts as white and is dismissed too
      const hd = hsv.h * 360;
      const warm = hd >= ART.WARM_HUE[0] && hd <= ART.WARM_HUE[1];
      if (hsv.s <= (warm ? ART.WARM_WHITE_MAX_SAT : ART.WHITE_MAX_SAT)) continue;
    }
    if (blend[i / 4]) continue; // blur between two colors, not a color of its own
    colorPx++;
    if (hsv.s >= ART.PRIMARY_MIN_SAT && hsv.v >= ART.PRIMARY_MIN_VAL) { // a clearly colored pixel: counted by area for the primary vote
      const pb = primB[Math.min(B - 1, Math.floor(hsv.h * B))];
      pb.n++; pb.r += r; pb.g += g; pb.b += b;
    }
    const t = buckets[Math.min(B - 1, Math.floor(hsv.h * B))];
    const w = hsv.s * hsv.v; // faint tints (cream etc.) weigh little, so they rank last
    t.score += w;
    t.n++; // area: how many surviving pixels fell in this hue
    t.w += w; t.r += r * w; t.g += g * w; t.b += b * w;
  }
  if (opaque === 0 || colorPx === 0 || colorPx / opaque < ART.MIN_COLOR_SHARE) return null; // nothing but black / white / gray

  const cands = [];
  buckets.forEach((t) => {
    if (t.w <= 0) return;
    const r = t.r / t.w, g = t.g / t.w, b = t.b / t.w;
    cands.push({ r, g, b, n: t.n, score: t.score, rank: Math.pow(t.score, ART.SCORE_POWER), h: artRgbToHsv(r, g, b).h });
  });
  if (cands.length === 0) return null;

  cands.sort((a, b) => b.rank - a.rank);
  const best = cands[0].rank;
  const picked = [];
  for (const c of cands) {
    if (picked.length >= ART.MAX_COLORS) break;
    if (c.rank < best * ART.MIN_SCORE_RATIO) continue;
    if (c.n < colorPx * ART.MIN_AREA_SHARE) continue; // too small a sliver of the art
    const clash = picked.some((p) => {
      const d = Math.abs(p.h - c.h);
      return Math.min(d, 1 - d) * 360 < ART.MIN_HUE_GAP;
    });
    if (!clash) picked.push(c);
  }
  // Area share of every picked color = its share of ALL the pixels that survived the mask. Hues that were not picked
  // (too close to a picked one, too small, or past MAX_COLORS) hand their area to the nearest picked hue, so the shares add up to 1.
  const hueDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 1 - d); };
  picked.forEach((c) => { c.area = c.n; });
  for (const c of cands) {
    if (picked.includes(c) || picked.length === 0) continue;
    let near = picked[0];
    for (const p of picked) if (hueDist(p.h, c.h) < hueDist(near.h, c.h)) near = p;
    near.area += c.n;
  }
  const areaTotal = picked.reduce((sum, c) => sum + c.area, 0) || 1;
  picked.forEach((c) => { c.area /= areaTotal; });
  picked.primary = ART.PRIMARY_ENABLED ? findPrimaryColor(primB, colorPx) : null; // share is of the colored pixels only
  return picked;
}

// The primary color is the hue family that covers the most of the art, counting only real colors
// (grayscale and black are masked out before this). A color sitting on a bucket edge
// (e.g. yellow at 59 degrees) still counts as one color, so each hue is voted with its two neighbours.
// Returns { r, g, b } (0..1, the average of that family's pixels) or null if no color covers enough of the art.
function findPrimaryColor(primB, opaque) {
  if (opaque <= 0) return null;
  const B = ART.BUCKETS;
  let bestI = -1, bestN = 0;
  for (let i = 0; i < B; i++) {
    const n = primB[(i + B - 1) % B].n + primB[i].n + primB[(i + 1) % B].n;
    if (n > bestN) { bestN = n; bestI = i; }
  }
  if (bestI < 0 || bestN / opaque < ART.PRIMARY_MIN_SHARE) return null;
  let n = 0, r = 0, g = 0, b = 0;
  for (const j of [(bestI + B - 1) % B, bestI, (bestI + 1) % B]) {
    const q = primB[j];
    n += q.n; r += q.r; g += q.g; b += q.b;
  }
  return { r: r / n, g: g / n, b: b / n };
}

// Puts the primary color first in the palette (so it takes the first role) and gives it most of the weight.
// It replaces the palette color nearest in hue (that was just another version of it); the other colors stay,
// sharing what is left, so the mood leans to the primary without losing the rest of the cover.
function applyPrimaryColor(slots, primary) {
  if (!primary) return slots;
  const hueDist = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 1 - d) * 360; };
  const hsv = artRgbToHsv(primary.r, primary.g, primary.b);
  const rest = slots.map((c) => Object.assign({}, c));
  let best = -1, bestD = 1e9;
  rest.forEach((c, i) => {
    if (c.white) return; // white has no hue, never swap it for the primary color
    const d = hueDist(artRgbToHsv(c.r, c.g, c.b).h, hsv.h);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best >= 0 && bestD < ART.MIN_HUE_GAP * 1.6) rest.splice(best, 1);
  while (1 + rest.length > ART.MAX_COLORS) rest.pop(); // keep the palette length the fluid blends between
  const lead = Object.assign(artVivid(hsv.h, hsv.s, hsv.v), { primary: true, fromArt: !!slots[0].fromArt });
  const restTotal = rest.reduce((sum, c) => sum + c.w, 0);
  const n = 1 + rest.length;
  // 2 colors: full primary lean. 3+ colors: a fair 1/n share plus a modest extra, so the cover's other colors stay visible
  const leadW = rest.length && restTotal > 0 ? (n > 2 ? 1 / n + ART.MULTI_PRIMARY_EXTRA * (ART.PRIMARY_WEIGHT / 0.6) * (1 - 1 / n) : ART.PRIMARY_WEIGHT) : 1;
  lead.w = leadW;
  rest.forEach((c) => { c.w = (1 - leadW) * (c.w / restTotal); });
  return [lead].concat(rest);
}

function artLuma(c) {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

function artHsvColor(h, s, v) {
  return HSVtoRGB(h, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, v)));
}

// Keeps the hue of a color but pushes it to a vivid shade, so washed-out or dull art still pops.
function artVivid(h, s, v) {
  return artHsvColor(h, Math.max(s, ART.SAT_MIN), Math.max(v, ART.VAL_MIN));
}

// Contrast partner for a single color: the same hue, one darker tone.
function artPartner(h) {
  return artHsvColor(h, ART.SAT_MIN, ART.PARTNER_VAL); // same hue, darker tone, always (never a lighter or different color)
}

// ============================================================
// AMERICA MODE
// Red + blue art (flags, patriotic covers) is rebuilt as a flag: red, white and blue in the proportions of the
// real U.S. flag. Faded flag stripes read as cream / pale yellow, and the usual "push every color to a vivid
// shade" step would turn that into a bright yellow, so on art whose real colors are only red and blue, any
// cream / pale-yellow becomes white, and if there is none, white is added anyway.
// Art with a true yellow (yellow + black covers, or red + yellow + blue) is left alone.
//
// Proportions come from the flag itself (Executive Order 10834): 13 equal stripes, and a blue canton that is
// 7 stripes tall and 0.76 / 1.9 = 40% of the flag's width. The stars are NOT counted, so the canton is solid
// blue (counting them would turn ~1/6 of the blue white and wash the fluid out). In stripe-units (flag width = 1):
//   total 13 | canton (blue) 7 x 0.4 = 2.8 | red 7 stripes - 4 x 0.4 covered by the canton = 5.4 | white 6 - 3 x 0.4 = 4.8
//   -> red 41.5%, white 36.9%, blue 21.5%
// All red hues in the art merge into one red, all blue hues into one blue, so these shares are exact.
// ============================================================
const AMERICA = {
  enabled: true,
  CREAM_SAT: 0.55,     // a warm (yellow / tan) color at or below this saturation counts as a cream / faded white, above it it is a real yellow
  CREAM_HUE: [25, 75], // degrees
  RED_HUE: [345, 25],  // degrees, wraps through 0
  BLUE_HUE: [195, 270],
  RED_OUT: 0,          // degrees: the red used in the fluid (art tints like orange or cyan text don't shift it off flag red)
  BLUE_OUT: 230,       // degrees: the blue used in the fluid (Old Glory navy-ish blue rather than sky blue)
  WHITE_LEVEL: 0.9,    // brightness of the white (1 = pure white, a little lower keeps it from blowing out next to the colors)
  STRIPES: 13,         // flag geometry (see above)
  CANTON_STRIPES: 7,   // stripes the canton is tall
  CANTON_WIDTH: 0.4,   // canton width as a share of the flag width (0.76 / 1.9)
  // Which flag color each instrument plays (drums and bass fire the most, so they carry red; white and blue are the lighter accents)
  ROLE_COLOR: { drums: "red", bass: "red", vocals: "white", track: "blue", guitar: "blue" },
  SLOT: { white: 0, red: 1, blue: 2 }, // the flag palette's slot order (see americaAdjust)
  WHITE_SUB: 0.20,       // share of drum and bass hits that play white instead of red (0 = never, 1 = always); the "America white on drums + bass" slider
  WHITE_SUB_ROLES: ["drums", "bass"] // the instruments white can take over from red
};
// { red, white, blue } shares of the flag, summing to 1, stars ignored
function americaShares() {
  const A = AMERICA;
  const redRows = Math.ceil(A.CANTON_STRIPES / 2);          // red stripes that run under the canton (1, 3, 5, 7)
  const whiteRows = Math.floor(A.CANTON_STRIPES / 2);       // white stripes that run under the canton (2, 4, 6)
  const totalRed = Math.ceil(A.STRIPES / 2), totalWhite = Math.floor(A.STRIPES / 2);
  const blue = A.CANTON_STRIPES * A.CANTON_WIDTH;
  const red = totalRed - redRows * A.CANTON_WIDTH;
  const white = totalWhite - whiteRows * A.CANTON_WIDTH;
  const sum = red + white + blue; // = STRIPES
  return { red: red / sum, white: white / sum, blue: blue / sum };
}
function americaAdjust(colors) {
  if (!AMERICA.enabled) return colors;
  const A = AMERICA;
  const deg = (c) => artRgbToHsv(c.r, c.g, c.b).h * 360;
  const isCream = (c) => { const h = artRgbToHsv(c.r, c.g, c.b); const d = h.h * 360; return d >= A.CREAM_HUE[0] && d <= A.CREAM_HUE[1] && h.s <= A.CREAM_SAT; };
  const isRed = (c) => { const d = deg(c); return d >= A.RED_HUE[0] || d <= A.RED_HUE[1]; };
  const isBlue = (c) => { const d = deg(c); return d >= A.BLUE_HUE[0] && d <= A.BLUE_HUE[1]; };
  const chroma = colors;
  const rest = chroma.filter((c) => !isCream(c));
  // only flag colors: at least one red, at least one blue, and nothing else
  if (rest.length < 2 || !rest.some(isRed) || !rest.some(isBlue) || !rest.every((c) => isRed(c) || isBlue(c))) return colors;
  // merge every red into one red, every blue into one blue (score-weighted average), so the flag shares below are exact
  const merge = (list) => {
    const t = list.reduce((sum, c) => sum + c.score, 0) || 1;
    const r = list.reduce((sum, c) => sum + c.r * c.score, 0) / t;
    const g = list.reduce((sum, c) => sum + c.g * c.score, 0) / t;
    const b = list.reduce((sum, c) => sum + c.b * c.score, 0) / t;
    return { r, g, b, score: t, rank: Math.pow(t, ART.SCORE_POWER), h: artRgbToHsv(r, g, b).h };
  };
  const red = merge(rest.filter(isRed)); red.kind = "red";
  const blue = merge(rest.filter(isBlue)); blue.kind = "blue";
  const white = { r: A.WHITE_LEVEL, g: A.WHITE_LEVEL, b: A.WHITE_LEVEL, score: 1, rank: 1, white: true, kind: "white", h: 0 };
  const out = [white, red, blue]; // order must match AMERICA.SLOT
  out.america = true;
  out.primary = null; // the flag proportions decide the mix, no primary-color lean
  return out;
}

// ============================================================
// FIREPLACE MODE
// Art whose only real colors are red, orange and / or yellow becomes fire, and whichever of the three the art is missing is added.
// Waves then run on a "heat" scale: 0 = hot yellow, 0.5 = orange, 1 = red. The heat a wave is BORN at drifts slowly back and forth
// over time (with some spread, so all three colors are always around), and each wave cools toward red as it travels. The fire adapts in
// real time instead of staying on one color. (Art with blue, green... is not fire; America mode is checked first.)
// ============================================================
const FIRE = {
  enabled: true,
  HUE: [345, 70],     // degrees (wraps through 0): every color of the art must fall in here (red .. orange .. yellow) for the art to count as fire
  MIN_SAT: 0.70,      // and every color must be at least this vivid...
  MIN_VAL: 0.70,      // ...and this bright: fire is bright, so brown / rust / wood tones (a dull orange) are NOT fire and use the normal palette
  ORANGE_FROM: 15,    // degrees: below this (or above 345) a color is the red, from here up to SPLIT the orange
  SPLIT: 45,          // degrees: from here up the yellow
  HOT_HUE: 54,        // the hot yellow used when the art has none
  MID_HUE: 28,        // the orange used when the art has none
  TIP_HUE: 6,         // the red used when the art has none
  TIP_VAL: 0.75,      // brightness of that stock red (a little darker, like cooling embers)
  PERIOD: 30,         // seconds for the birth heat to drift yellow -> red -> yellow
  SPREAD: 0.7,        // how far (0-1 of the heat scale) a wave's birth heat strays from the drift, so yellow, orange and red always mix
  COOL_SLOW: 0.20,    // the slowest waves (low bass) cool this much of the heat scale over their life: a slow burn that stays warm
  COOL_FAST: 1.00,    // the fastest waves (highs) cool this much (1 = the whole way, yellow to red): sparks that flash through every color
  SPEED_LO: 0.09,     // wave speed (screen-heights / second) that counts as the slowest...
  SPEED_HI: 0.66,     // ...and the fastest, to place a wave between COOL_SLOW and COOL_FAST
  // --- yellow gate: yellow is the brightest of the three and the fluid adds colors together, so a little yellow washes the fire out.
  //     These keep the fire warm (orange / red / amber) with yellow as a spark, not the main color. Set by the "Fireplace: yellow limit" slider. ---
  GATE: 0.7,          // 0..1, how hard the yellow is held back (0 = off, the old look)
  FLOOR: 0.22,        // the hottest heat that is allowed at full gate (0 = pure lemon yellow, 0.22 = amber gold)
  CURVE: 0.45,        // pushes births toward orange / red (at full gate)
  YELLOW_T: 0.34,     // heat below this counts as "yellow" for the cap
  YELLOW_CAP: 0.10,   // at most about this share of the recent colors may be yellow, so the drift can't flood the screen with it
  EMA: 0.03,          // how fast that recent-share tracker moves (per color handed out)
  HOT_DIM: 0.30       // the yellow end is this much dimmer at full gate
};
let _fireY = 0; // recent share of yellow colors handed out
// Holds the heat back from yellow: raises the floor, bends births toward red, caps how much yellow is out at once.
function fireGate(t) {
  const F = FIRE, g = F.GATE;
  if (g <= 0) return t;
  let u = F.FLOOR * g + (1 - F.FLOOR * g) * Math.pow(t, 1 - F.CURVE * g);
  if (u < F.YELLOW_T && _fireY > F.YELLOW_CAP * g + (1 - g) * 0.5) u = F.YELLOW_T + Math.random() * 0.25; // too much yellow lately: this one goes orange
  _fireY += ((u < F.YELLOW_T ? 1 : 0) - _fireY) * F.EMA;
  return u;
}
function fireAdjust(colors) {
  if (!FIRE.enabled || colors.america || colors.length === 0) return colors;
  const hsv = (c) => artRgbToHsv(c.r, c.g, c.b);
  const hot = (c) => { const h = hsv(c), d = h.h * 360; return (d >= FIRE.HUE[0] || d <= FIRE.HUE[1]) && h.s >= FIRE.MIN_SAT && h.v >= FIRE.MIN_VAL; };
  if (!colors.every(hot)) return colors;
  const mk = (h, s, v) => { const c = artHsvColor(h / 360, s, v); return Object.assign(c, { score: 1, rank: 1, h: h / 360 }); };
  const viv = (c) => { const hv = hsv(c); return Object.assign(artVivid(hv.h, hv.s, hv.v), { score: c.score, rank: c.rank, h: hv.h }); };
  const band = (c) => { const d = hsv(c).h * 360; return d >= FIRE.SPLIT ? "yellow" : d >= FIRE.ORANGE_FROM && d < FIRE.SPLIT ? "orange" : "red"; };
  const yellow = colors.find((c) => band(c) === "yellow"), orange = colors.find((c) => band(c) === "orange"), red = colors.find((c) => band(c) === "red");
  const out = [yellow ? viv(yellow) : mk(FIRE.HOT_HUE, ART.SAT_MIN, 1), orange ? viv(orange) : mk(FIRE.MID_HUE, ART.SAT_MIN, 1), red ? viv(red) : mk(FIRE.TIP_HUE, 1, FIRE.TIP_VAL)];
  out.fire = true;
  out.primary = null;
  return out;
}
// Heat a new wave is born at: a slow drift over time plus a random spread (0 = hot yellow ... 1 = red)
function fireBirthHeat() {
  const drift = 0.5 - 0.5 * Math.cos((2 * Math.PI * (Date.now() / 1000)) / FIRE.PERIOD);
  return Math.max(0, Math.min(1, drift + (Math.random() - 0.5) * FIRE.SPREAD));
}
// How much of the heat scale a wave cools over its life, from its speed: slow waves (bass) smolder, fast waves (highs, hard hits) are sparks
function fireCool(band, strength) {
  const sp = ((band && band.speed) || 0.2) * (0.8 + 0.4 * (strength === undefined ? 0.5 : strength));
  const k = Math.max(0, Math.min(1, (sp - FIRE.SPEED_LO) / (FIRE.SPEED_HI - FIRE.SPEED_LO)));
  return FIRE.COOL_SLOW + (FIRE.COOL_FAST - FIRE.COOL_SLOW) * k;
}
// Color of one wave puff at heat t (0 = hot yellow, 0.5 = orange, 1 = red)
function fireColor(st, t) {
  t = fireGate(Math.max(0, Math.min(1, t || 0)));
  const a = t < 0.5 ? st[0] : st[1], b = t < 0.5 ? st[1] : st[2], k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const j = (0.85 + Math.random() * 0.15) * (1 - FIRE.HOT_DIM * FIRE.GATE * Math.max(0, 1 - t * 2));
  return { r: (a.r + (b.r - a.r) * k) * j * 0.15, g: (a.g + (b.g - a.g) * k) * j * 0.15, b: (a.b + (b.b - a.b) * k) * j * 0.15 };
}

// ============================================================
// COLOR ROTATION (art with 3+ colors)
// Colors are ranked by importance (area x vividness, so a big faint cream area doesn't outrank a vivid accent).
// Every splat then takes the next color from this loop:
//   primary, secondary, next of the remaining colors, primary, secondary, next of the remaining, ...
// so primary and secondary each get 1/3 of the splats and the rest share the last 1/3, walking down their list in order.
// ============================================================
const ROT = { step: 0, rest: 0 };
function rotationColor(active) {
  const rest = active.slice(2);
  const i = ROT.step++ % 3;
  if (i === 0 || rest.length === 0) return active[0];
  if (i === 1) return active[1];
  return rest[ROT.rest++ % rest.length];
}

// Turns extracted colors into the 3 weighted palette slots the fluid blends toward.
// ============================================================
// NEON BOOST
// Neon art (fluorescent yellow, hot cyan / pink...) loses its punch in the fluid for three reasons: a thin film of dye looks like
// dark khaki, colors that overlap add up toward gray / white, and the glow (bloom) pushes bright cores toward white. When most of the
// album's color is neon, the display shader (see neon in displayShaderSource) crushes the faint haze of bright hues (yellow, cyan) so they
// glow on a dark ground instead of fogging, restores saturation, and keeps overexposed cores in their color instead of clipping to white.
// Red / blue haze is left alone. Ordinary art is not touched (neon stays 0).
// ============================================================
const NEON = {
  strength: 0.7,   // 0..1, set by the "Neon boost" slider (0 = off)
  SAT: 0.75,       // a picked color counts as neon at or above this saturation...
  VAL: 0.85,       // ...and this brightness (before the palette makes everything vivid)
  FROM: 0.25,      // share of the art's color that is neon where the boost starts...
  TO: 0.75,        // ...and where it is at full strength
  target: 0,       // what the current song asks for (0..1)
  cur: 0           // eased value the shader uses
};
function neonAmount(colors) {
  let all = 0, hot = 0;
  for (const c of colors) {
    const h = artRgbToHsv(c.r, c.g, c.b), w = c.rank || c.score || 1;
    all += w;
    if (h.s >= NEON.SAT && h.v >= NEON.VAL) hot += w;
  }
  if (all <= 0) return 0;
  return Math.max(0, Math.min(1, (hot / all - NEON.FROM) / (NEON.TO - NEON.FROM)));
}

// Wrapper: builds the palette and tags how neon the art is (fire and flag palettes have their own look, so they stay at 0).
function buildArtPalette(colors) {
  const amount = neonAmount(colors);
  const slots = buildArtPaletteCore(colors);
  slots.neon = slots.some((c) => c.fire || c.america) ? 0 : amount;
  return slots;
}

function buildArtPaletteCore(colors) {
  colors = americaAdjust(colors);
  colors = fireAdjust(colors);
  let pool = colors; // the grayscale mask already ran in extractArtColors, nothing neutral is left here
  const noColor = pool.length === 0;
  // Yellow is never the main color: it takes the secondary slot (best non-yellow first, yellow second, the rest follow in rank order).
  const isYellow = (c) => { const d = artRgbToHsv(c.r, c.g, c.b).h * 360; return d >= ART.YELLOW_HUE[0] && d <= ART.YELLOW_HUE[1]; };
  if (!colors.america && !colors.fire && pool.length >= 2) {
    const y = pool.find(isYellow);
    if (y) { const others = pool.filter((c) => c !== y); pool = [others[0], y].concat(others.slice(1)); }
  }
  // ...and a yellow primary (the biggest hue family) must not lead either
  if (colors.primary && isYellow(colors.primary)) colors.primary = null;
  let slots;
  if (noColor) {
    // Black / white / gray / barely-tinted art: nothing vivid to pull, so use your own colors (red + rose)
    slots = FALLBACK_PALETTE.map((c) => Object.assign({}, c));
  } else if (colors.america) {
    // Flag: red / white / blue in the proportions of the real flag (see AMERICA), weights used as-is
    const sh = americaShares();
    const w = [sh.white, sh.red, sh.blue];
    slots = colors.map((c, i) => {
      const hsv = artRgbToHsv(c.r, c.g, c.b);
      const hue = c.white ? 0 : (c.kind === "red" ? AMERICA.RED_OUT : AMERICA.BLUE_OUT) / 360;
      const rgb = c.white ? { r: c.r, g: c.g, b: c.b } : artVivid(hue, hsv.s, hsv.v);
      return Object.assign(rgb, { w: w[i], white: !!c.white, america: true });
    });
  } else if (colors.fire) {
    // Fire: three stops (hot yellow, orange, cooled red) that every wave walks through as it ages (see fireColor)
    slots = colors.map((c, i) => Object.assign({ r: c.r, g: c.g, b: c.b }, { w: i === 0 ? 0.34 : 0.33, fire: true, fromArt: true }));
  } else if (pool.length >= ART.ROTATE_MIN_COLORS) {
    // 3+ colors: ranked by importance (pool is already sorted best first), played back by the rotation loop (see rotationColor).
    // Weights are only the loop's own shares (1/3, 1/3, and 1/3 split across the rest).
    const restW = 1 / 3 / (pool.length - 2);
    slots = pool.map((c, i) => {
      const hsv = artRgbToHsv(c.r, c.g, c.b);
      return Object.assign(artVivid(hsv.h, hsv.s, hsv.v), { w: i < 2 ? 1 / 3 : restW, rotate: true, fromArt: true });
    });
  } else if (pool.length === 1) {
    // One color found: vivid version of it plus a darker / lighter partner
    const c = pool[0];
    const hsv = artRgbToHsv(c.r, c.g, c.b);
    slots = [
      Object.assign(artVivid(hsv.h, hsv.s, hsv.v), { w: 0.6 }),
      Object.assign(artPartner(hsv.h), { w: 0.4 })
    ];
  } else {
    // Several colors: every one goes in, weighted by its share of the art's colored pixels (the grayscale mask already removed
    // black / gray / white), so the waves carry the colors in the same ratio as the cover.
    const weights = pool.map((c) => c.area);
    const total = weights.reduce((sum, w) => sum + w, 0);
    slots = pool.map((c, i) => {
      const hsv = artRgbToHsv(c.r, c.g, c.b);
      const rgb = artVivid(hsv.h, hsv.s, hsv.v);
      return Object.assign(rgb, { w: weights[i] / total, white: !!c.white, fromArt: true });
    });
  }
  // Duo logic is for: black & white art (your colors), or art with only one or two detected colors.
  const duo = noColor || (!colors.america && !colors.fire && pool.length <= 2);
  if (!noColor && !colors.america && !colors.fire && !slots[0].rotate) slots = applyPrimaryColor(slots, colors.primary);
  if (duo && slots.length > 2) { // the primary lean must never turn a 2-color cover into 3 slots
    slots = slots.slice(0, 2);
    const t = slots.reduce((sum, c) => sum + c.w, 0) || 1;
    slots.forEach((c) => { c.w /= t; });
  }
  slots.duo = duo;
  return slots;
}

function setPaletteTarget(slots, snap) {
  paletteTarget = padSlots(slots);
  if (snap) paletteCurrent = padSlots(slots);
}

// Decides what the fluid should be showing right now: the song's colors while music plays,
// red + rose when there is no track, no usable art, or the music has stopped.
function refreshTarget(snap) {
  const useArt = _hasTrack && _artSlots && _soundActive && !_colorOverride;
  _duoMode = useArt ? !!_artSlots.duo : true; // override / no art / silence = your two colors = duo; album art = duo only if it has 1-2 colors
  NEON.target = useArt ? _artSlots.neon || 0 : 0;
  setPaletteTarget(useArt ? _artSlots : FALLBACK_PALETTE, snap);
}

// Washes the old song's dye out of the fluid so it does not hang around into the next song.
function startFlush() {
  if (_baseDensity === null) _baseDensity = config.DENSITY_DISSIPATION;
  config.DENSITY_DISSIPATION = ART.FLUSH_DISSIPATION;
  _flushEnd = Date.now() + ART.FLUSH_TIME;
  clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    config.DENSITY_DISSIPATION = _baseDensity;
    _baseDensity = null;
  }, ART.FLUSH_TIME);
}

// The new song's art is in (or we gave up waiting): release the hold and announce the new colors.
function finishArtWait() {
  clearTimeout(_waitTimer);
  const wasWaiting = _waitingArt;
  _waitingArt = false;
  _holdSplats = false;
  refreshTarget(wasWaiting); // snap on a track change, ease otherwise
  if (wasWaiting) {
    setTimeout(() => splatStack.push(ART.BURST_SPLATS), Math.max(0, _flushEnd - Date.now()));
  }
}

function startTrackChange() {
  instrResetIntensity();
  if (!config.ART_COLORS) return;
  INSTR.emitters.length = 0; // the old song's trails stop with it
  _waitingArt = true;
  _holdSplats = true;
  startFlush();
  clearTimeout(_waitTimer);
  _waitTimer = setTimeout(() => {
    // No different art showed up. Consecutive tracks on one album share art, so that art is kept;
    // if the player never reported any art for this track, fall back to red + rose.
    if (!_thumbSeen) {
      _artSlots = null;
      _lastThumb = null; // so the next track's art is processed fresh, even if it matches an older song's
    }
    finishArtWait();
  }, ART.NEW_ART_WAIT);
}

function applyArt(slots) {
  _artSlots = slots;
  if (_waitingArt) finishArtWait();
  else refreshTarget(false);
}

function artMime(b64) {
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("UklGR")) return "image/webp";
  if (b64.startsWith("R0lGOD")) return "image/gif";
  return "image/png";
}

function loadArtColors(thumb) {
  const token = ++_artToken;
  const img = new Image();
  img.onload = () => {
    if (token !== _artToken) return;
    try {
      const n = ART.SAMPLE_SIZE;
      const cv = document.createElement("canvas");
      cv.width = cv.height = n;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, n, n);
      const colors = extractArtColors(ctx.getImageData(0, 0, n, n).data);
      applyArt(colors && colors.length > 0 ? buildArtPalette(colors) : null); // null = all black / transparent
    } catch (e) {
      console.log("Album art color pick failed", e);
      applyArt(null);
    }
  };
  img.onerror = () => {
    if (token === _artToken) applyArt(null);
  };
  img.src = thumb.startsWith("data:") ? thumb : "data:" + artMime(thumb) + ";base64," + thumb;
}

// Called by Lively on track change, and again when the thumbnail finishes loading.
// data is null when nothing is playing.
function livelyCurrentTrack(data) {
  let obj = null;
  try {
    obj = typeof data === "string" ? JSON.parse(data) : data;
  } catch (e) {
    obj = null;
  }

  if (!obj) {
    // Nothing playing. Wait briefly, since players report nothing for a moment between songs.
    clearTimeout(_goneTimer);
    _goneTimer = setTimeout(() => {
      _hasTrack = false;
      _trackKey = null;
      _lastThumb = null;
      _artSlots = null;
      _artToken++; // drop any image still loading
      clearTimeout(_waitTimer);
      _waitingArt = false;
      _holdSplats = false;
      refreshTarget(false);
    }, ART.TRACK_GONE_DELAY);
    return;
  }

  clearTimeout(_goneTimer);
  _hasTrack = true;

  const key = (obj.Title || "") + "|" + (obj.Artist || "") + "|" + (obj.AlbumTitle || "");
  if (key !== _trackKey) {
    // New song: wash out the old colors and hold splats until its art arrives
    _trackKey = key;
    _thumbSeen = false;
    startTrackChange();
  }

  const thumb = obj.Thumbnail || null;
  if (!thumb) return;
  _thumbSeen = true;
  // Right after a change Lively can still report the previous song's art. A thumbnail identical
  // to the last one is ignored here and either replaced by the real one or accepted when the wait ends.
  if (thumb === _lastThumb) return;
  _lastThumb = thumb;
  loadArtColors(thumb);
}

// Eases the live palette toward the target. Called every frame.
function updatePalette(dt) {
  if (!config.ART_COLORS) return;
  // Music stopped / started, judged from the system audio level
  const now = Date.now();
  if (_isSleep) _lastSoundTime = now;
  const active = now - _lastSoundTime < ART.STOP_DELAY;
  if (active !== _soundActive) {
    _soundActive = active;
    refreshTarget(false);
  }
  const k = 1 - Math.exp(-dt / ART.EASE_TIME);
  _lingerMul += ((_soundActive ? 1 : ART.LINGER_MUL) - _lingerMul) * (1 - Math.exp(-dt / 0.8));
  for (let i = 0; i < paletteCurrent.length; i++) {
    const c = paletteCurrent[i], t = paletteTarget[i];
    c.r += (t.r - c.r) * k;
    c.g += (t.g - c.g) * k;
    c.b += (t.b - c.b) * k;
    c.w += (t.w - c.w) * k;
    c.primary = t.primary; // which slot is the primary color (used by instrColor)
    c.america = t.america; // flag palette marker (used by instrColor)
    c.fire = t.fire; // fire palette marker (used by instrColor / paletteColor)
    c.rotate = t.rotate; // rotation palette marker (used by instrColor / paletteColor)
    c.fromArt = t.fromArt; // weights are the art's own color ratio (used by the two-color logic)
  }
}

// ---- Two-color songs: single-color albums, the color override, or no usable album art ----
// The palette has exactly two colors. Instead of each instrument owning a color (which left one color waiting on a
// rare instrument), every splat takes the next color from a low-discrepancy sequence: over time the first color
// gets exactly BALANCE of the splats, but the two interleave evenly, so neither goes missing for long.
const TWO_TONE = {
  BALANCE: 0.5,           // share of splats using the first color, set by the 'Two-color balance' slider
  RICH_LUMA: 0.4,         // pale colors (rose) are dimmed a little and deep colors (red) lifted a little (limited to about +/-15-20%) so overlaps don't clip to white but neither color is drowned out
  STEP: 0.6180339887498949, // golden ratio: spreads picks evenly without a repeating pattern that could line up with the beat
  u: Math.random()
};
function twoTonePair() {
  return _duoMode ? [paletteCurrent[0], paletteCurrent[1]] : null;
}
// Share of splats for the first color: the cover's own ratio when both colors come from the art, otherwise the slider.
function twoToneBalance() {
  const a = paletteCurrent[0], b = paletteCurrent[1];
  if (a && b && a.fromArt && a.w + b.w > 0) return a.w / (a.w + b.w);
  return TWO_TONE.BALANCE;
}
function twoToneNextIndex() {
  TWO_TONE.u = (TWO_TONE.u + TWO_TONE.STEP) % 1;
  return TWO_TONE.u < twoToneBalance() ? 0 : 1;
}
// Color for one splat. The color leaned toward is also a little stronger, the other a little softer.
function twoToneColor(pair, idx) {
  const c = pair[idx];
  const bal = twoToneBalance();
  const share = idx === 0 ? bal : 1 - bal;
  const luma = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const rich = Math.max(0.8, Math.min(1.15, TWO_TONE.RICH_LUMA / Math.max(luma, 0.05)));
  const k = rich * (0.8 + 0.4 * share);
  const j = 0.85 + Math.random() * 0.15;
  return { r: c.r * j * 0.15 * k, g: c.g * j * 0.15 * k, b: c.b * j * 0.15 * k };
}

function paletteColor() {
  const pair = twoTonePair();
  if (pair) return twoToneColor(pair, twoToneNextIndex());
  const act = paletteCurrent.filter((c) => c.w > 0);
  if (act.length > 2 && act[0].fire) return fireColor(act, Math.random()); // random splats sit anywhere along the heat range
  if (act.length > 2 && act[0].rotate) { // 3+ color art: same rotation as the instrument hits
    const rc = rotationColor(act), jr = 0.85 + Math.random() * 0.15;
    return { r: rc.r * jr * 0.15, g: rc.g * jr * 0.15, b: rc.b * jr * 0.15 };
  }
  let total = 0;
  for (const c of paletteCurrent) total += c.w;
  let pick = paletteCurrent[0];
  if (total > 0) {
    let rand = Math.random() * total;
    for (const c of paletteCurrent) {
      rand -= c.w;
      if (rand <= 0) { pick = c; break; }
    }
  }
  const j = 0.85 + Math.random() * 0.15; // slight brightness variation, same 0.15 scale as stock colors
  return { r: pick.r * j * 0.15, g: pick.g * j * 0.15, b: pick.b * j * 0.15 };
}

var timer = setInterval(randomSplat, 3500);
var _runRandom = true;
var _isSleep = false;
function randomSplat() {
  if (_runRandom == true && _isSleep == false && _randomSplats) splatStack.push(parseInt(Math.random() * 20) + 5);
}

function livelyWallpaperPlaybackChanged(data) {
  var obj = JSON.parse(data);
  _isSleep = obj.IsPaused;
  pauseVideoBackground(obj.IsPaused);
}

let timeout;
let timeoutBool = true;
let lastBass = 0;

// Automatic pulse amplify: slow songs get ~1 pulse per low note, fast / busy songs up to PULSE_MAX.
// The song's pace is how many separate low-note hits landed over the last few seconds.
const AUTO_PULSE = {
  MIN: 0.6,      // slow songs (below 1 = some notes make no pulse at all)
  MAX: 5,        // never more than 5x
  SLOW_RATE: 2.0, // low-note hits per second at or below this = slow song (MIN). A 112 bpm song that feels like 56 has about 2 hits/s
  FAST_RATE: 3.6, // at or above this = fast song (MAX), roughly a 140+ bpm song hitting on every beat
  WINDOW: 8000,  // ms of history
  MERGE: 180,    // ms: hits closer than this count as one note (a long note or its tail isn't counted twice)
  EASE: 0.03,    // how quickly the multiplier follows the pace (per hit check)
  hits: [],
  last: 0,
  start: 0,
  mult: 2
};
function autoPulseMult(now, hit) {
  const A = AUTO_PULSE;
  if (!A.start) A.start = now;
  if (hit && now - A.last > A.MERGE) { A.hits.push(now); A.last = now; }
  while (A.hits.length && now - A.hits[0] > A.WINDOW) A.hits.shift();
  const span = Math.min(A.WINDOW, now - A.start);
  let target = 2; // neutral until a few seconds of the song have been heard
  if (span > 3000) {
    const rate = A.hits.length / (span / 1000);
    const t = Math.max(0, Math.min(1, (rate - A.SLOW_RATE) / (A.FAST_RATE - A.SLOW_RATE)));
    target = A.MIN + (A.MAX - A.MIN) * t * t * (3 - 2 * t);
  }
  A.mult += (target - A.mult) * A.EASE;
  return Math.min(A.MAX, Math.max(A.MIN, A.mult));
}
// How loud the song is right now versus its loudest recent moment (0..1). Quiet passages (a barely
// sung verse before the rise) get fewer, dimmer pulses and fade faster so the screen doesn't fill with color.
const QUIET = { peak: 0.01, avg: 0, loud: 0.5, MIN_PULSE: 0.4, MIN_BRIGHT: 0.5, EXTRA_FADE: 1.5 };
function quietUpdate(audio) {
  let sum = 0;
  for (let i = 0; i < audio.length; i++) sum += audio[i];
  const overall = sum / Math.max(1, audio.length);
  QUIET.avg += (overall - QUIET.avg) * 0.03;                         // ~1 s average, so single beats don't count as 'quiet'
  QUIET.peak = Math.max(QUIET.avg, QUIET.peak * 0.9998, 0.004);      // loudest recent stretch (fades over ~minute)
  QUIET.loud += (Math.min(1, QUIET.avg / QUIET.peak) - QUIET.loud) * 0.02;
  config.PULSE_BRIGHT = QUIET.MIN_BRIGHT + (1 - QUIET.MIN_BRIGHT) * QUIET.loud;
  config.QUIET_FADE = 1 + QUIET.EXTRA_FADE * (1 - QUIET.loud);
  return QUIET.MIN_PULSE + (1 - QUIET.MIN_PULSE) * QUIET.loud;
}
function autoPulseReset() { QUIET.peak = 0.01; QUIET.avg = 0; QUIET.loud = 0.5; config.PULSE_BRIGHT = 1; config.QUIET_FADE = 1; AUTO_PULSE.hits.length = 0; AUTO_PULSE.start = 0; AUTO_PULSE.last = 0; AUTO_PULSE.mult = 2; }
function livelyAudioListener(audioArray) {
  let peak = 0;
  for (let i = 0; i < audioArray.length; i++) if (audioArray[i] > peak) peak = audioArray[i];
  if (peak > ART.SOUND_THRESHOLD) _lastSoundTime = Date.now();
  if (_holdSplats && config.ART_COLORS) return; // track just changed, wait for its colors

  if (peak === 0 || _isSleep == true) { // peak (not bin 0): some outputs report an empty first bin while the rest has sound
    _runRandom = true;
    return;
  }
  if (!_audioReact) {
    return;
  }

  if (peak >= 0.001 && _runRandom) {
    _runRandom = false;
    clearTimeout(timeout);
    timeoutBool = true;
  } else {
    if (!_runRandom && timeoutBool) {
      timeoutBool = false;
      timeout = setTimeout(() => (_runRandom = timeoutBool = true), 1500);
    }
  }

  // Instrument tracking replaces the stock bass-only reaction (turn it off in settings to get the stock one back)
  if (INSTR.enabled) {
    instrumentPulse(instrPrepare(audioArray));
    return;
  }

  let bass = 0.0;

  for (let i = 0; i <= config.FREQ_RANGE; i++) bass += audioArray[i] * 2;

  bass /= config.FREQ_RANGE * 2 * config.FREQ_MULTI;

  // Frequency filter: only bins 0..FREQ_RANGE are listened to (the cutoff slider), and every pulse
  // that low note causes is multiplied by PULSE_MULT so one note puts several waves on screen.
  const bassAmount = Math.floor(bass * config.SOUND_SENSITIVITY * 10) - lastBass;
  const quiet = quietUpdate(audioArray);
  config.PULSE_MULT = autoPulseMult(Date.now(), bassAmount > 0) * quiet;
  if (bassAmount > 0) {
    const want = Math.min(16, bassAmount * config.PULSE_MULT);
    multipleSplats(Math.floor(want) + (Math.random() < want - Math.floor(want) ? 1 : 0)); // fractions fire some of the time
  }
  lastBass = (bass, Math.floor(bass * config.SOUND_SENSITIVITY * 10));
}

function multipleSplats(amount) {
  for (let i = 0; i < amount; i++) {
    const color = generateColor();
    color.r *= 10.0;
    color.g *= 10.0;
    color.b *= 10.0;
    const x = canvas.width * Math.random();
    const y = canvas.height * Math.random();
    const dx = 1000 * (Math.random() - 0.5);
    const dy = 1000 * (Math.random() - 0.5);
    splat(x, y, dx, dy, color);
  }
}

let _randomSplats = false;
let _audioReact = false;
let splatRadiusModulationEnabled = false;
let baseRadius = config.SPLAT_RADIUS;
let backgroundSrc = null;
let isBackground = false;
let _monitorCountSetting = 0, _monitorLayoutText = ""; // 0 = auto-detect, blank layout = equal columns
// Lively only tells a web wallpaper the size of the whole spanned canvas, not where each monitor is, so the monitor count is
// worked out from the canvas shape: roughly one 16:9 screen's worth of width per monitor (1 -> 16:9, 2 -> ~32:9, 3 -> ~48:9, 4).
// Mixed sizes / odd arrangements can't be read from the page: type them into 'Monitor layout' and that wins.
function autoMonitorCount() {
  const aspect = innerWidth / Math.max(1, innerHeight);
  return Math.max(1, Math.min(4, Math.round(aspect / (16 / 9))));
}
function applyMonitorLayout() {
  const rects = parseMonitorLayout(_monitorLayoutText);
  MONITORS.rects = rects;
  MONITORS.count = rects ? rects.length : _monitorCountSetting > 0 ? _monitorCountSetting : autoMonitorCount(); // a valid layout decides the monitor count
  INSTR.emitters.length = 0;
  INSTR.shots.length = 0;
}
addEventListener("resize", applyMonitorLayout); // monitors plugged / unplugged, resolution changed
applyMonitorLayout();
function livelyPropertyListener(name, val) {
  switch (name) {
    case "quality":
      config.DYE_RESOLUTION = [1024, 512, 256, 128][val];
      initFramebuffers();
      break;
    case "simResolution":
      config.SIM_RESOLUTION = [32, 64, 128, 256][val];
      initFramebuffers();
      break;
    case "densityDiffusion":
      config.DENSITY_DISSIPATION = val / 10;
      break;
    case "velocityDiffusion":
      config.VELOCITY_DISSIPATION = val / 100;
      break;
    case "pressure":
      config.PRESSURE = val / 100;
      break;
    case "vorticity":
      config.CURL = val;
      break;
    case "splatRadius":
      config.SPLAT_RADIUS = val / 100;
      break;
    case "shading":
      config.SHADING = val;
      updateKeywords();
      break;
    case "bloomEnable":
      config.BLOOM = val;
      updateKeywords();
      break;
    case "bloomIntensity":
      config.BLOOM_INTENSITY = val / 100;
      break;
    case "bloomThreshold":
      config.BLOOM_THRESHOLD = val / 100;
      break;
    case "sunRaysEnable":
      config.SUNRAYS = val;
      updateKeywords();
      break;
    case "sunRaysWeight":
      config.SUNRAYS_WEIGHT = val / 100;
      break;
    case "backgroundColor":
      setBackgroundColor(val);
      break;
    case "backgroundSrc":
      backgroundSrc = val;
      if (isBackground)
        setBackground(val);
      break;
    case "backgroundFit":
      setBackgroundFit(val);
      break;
    case "backgroundEnabled":
      isBackground = val;
      if (isBackground)
      {
        config.TRANSPARENT = true;
        setBackground(backgroundSrc);
      }
      else
      {
        config.TRANSPARENT = false;
        disposeBackgrounds();
      }
      break;
    case "overlaySrc":
      setOverlay(val);
      break;
    case "overlaySize":
      setOverlaySize(val);
      break;
    case "overlayEnabled":
      toggleOverlay(val);
      break;    
    case "randomSplats":
      _randomSplats = val;
      break;
    case "audioReact":
      _audioReact = val;
      break;
    case "synthPulse":
        INSTR.sensitivity = val / 100;
        break;
    case "noteTravel":
        INSTR.TRAVEL_AMOUNT = val / 100;
        break;
    case "volumeSize":
        INSTR.VOL_AMOUNT = val / 100;
        break;
    case "waveSpeed":
        INSTR.CALM = Math.max(0.05, val / 100);
        break;
    case "intensityImpact":
        INSTR.INT_AMOUNT = val / 100;
        break;
    case "instrumentTrack":
        INSTR.enabled = val;
        break;
    case "perMonitor":
        MONITORS.enabled = val;
        break;
    case "overscan":
        setOverscan(val / 100);
        break;
    case "wavesFrom":
        MONITORS.sourceMode = val;
        INSTR.shots.length = 0;
        break;
    case "monSizeFollow":
        MONITORS.SIZE_FOLLOW = Math.max(0, Math.min(1, val / 100));
        break;
    case "fireworks":
        INSTR.FW.amount = Math.max(0, Math.min(1, val / 100));
        break;
    case "monitorCount":
        _monitorCountSetting = val === 0 ? 0 : val + 1; // 0 = auto-detect, then 2 / 3 / 4
        applyMonitorLayout();
        break;
    case "monitorLayout":
        _monitorLayoutText = val;
        applyMonitorLayout();
        break;
    case "defaultColor1":
        setDefaultColor(0, val);
        break;
    case "defaultColor2":
        setDefaultColor(1, val);
        break;
    case "bassCutoff":
        config.FREQ_RANGE = Math.round(2 + (val / 100) * 125); // audio bins 0..127, low -> high pitch
        break;
    case "cursorInfluence":
        config.CURSOR_AMOUNT = val / 100;
        break;
    case "colorOverride":
        _colorOverride = val;
        refreshTarget(false);
        break;
    case "twoToneBalance":
        TWO_TONE.BALANCE = Math.max(0.03, Math.min(0.97, val / 100));
        break;
    case "fadeHold":
        ART.STOP_DELAY = 2500 + 40 * val;
        ART.LINGER_MUL = Math.max(0.2, 1 - val / 100);
        break;
    case "neonBoost":
        NEON.strength = Math.max(0, Math.min(1, val / 100));
        break;
    case "fireYellow":
        FIRE.GATE = Math.max(0, Math.min(1, val / 100));
        break;
    case "fireMode":
        FIRE.enabled = val;
        if (_lastThumb) loadArtColors(_lastThumb);
        break;
    case "americaWhiteRate":
        AMERICA.WHITE_SUB = Math.max(0, Math.min(1, val / 100));
        break;
    case "americaMode":
        AMERICA.enabled = val;
        if (_lastThumb) loadArtColors(_lastThumb); // rebuild the current song's palette
        break;
    case "primaryLean":
        ART.PRIMARY_ENABLED = val;
        if (_lastThumb) loadArtColors(_lastThumb); // rebuild the current song's palette with / without the primary lean
        break;
    case "primaryStrength":
        ART.PRIMARY_BIAS = val / 100 * 0.9;           // 0 -> 0, 100 -> 0.9 of instrument hits
        ART.PRIMARY_WEIGHT = 0.30 + val / 100 * 0.50; // 0 -> 0.30, 100 -> 0.80 of random splats
        if (_lastThumb) loadArtColors(_lastThumb);
        break;
  }
}

function setBackgroundColor(hex)
{
  const tmp = hexToRgb(hex);
  config.BACK_COLOR.r = tmp.r;
  config.BACK_COLOR.g = tmp.g;
  config.BACK_COLOR.b = tmp.b;
  document.body.style.backgroundColor = hex;
}

function setOverlay(srcPath)
{
  if (srcPath == undefined || srcPath == null ) 
    return;

  let src = srcPath.replace("\\", "/");
  document.getElementById('overlay').style.backgroundImage = `url('${src}')`;
}

function setOverlaySize(size)
{
  let overlay = document.getElementById('overlay');
  overlay.style.width = `${size}%`;
  overlay.style.height = `${size}%`;
}

function toggleOverlay(val)
{
  document.getElementById('overlay').style.visibility = !val ? "hidden" : "visible";
}

function pauseVideoBackground(isPaused)
{
  let videoElement = document.getElementById('videoBackground');
  if (videoElement != null && videoElement.hasAttribute("src"))
  {
    if (isPaused)
      videoElement.pause();
    else
      videoElement.play();
  }
}

function setBackground(srcPath)
{
  if (srcPath == undefined || srcPath == null ) 
    return;

  let ext = getExtension(srcPath);
  let src = srcPath.replace("\\", "/");
  let videoElement = document.getElementById('videoBackground');

  if (ext == "jpg" || ext == "jpeg" || ext == "png" || ext == "webp")
  {
    disposeVideoElement(videoElement);
    document.body.style.backgroundImage = `url('${src}')`;
  }
  else if (ext == "webm")
  {
    document.body.style.backgroundImage = '';
    videoElement.src = src;
    videoElement.play();
  }
}

function disposeBackgrounds()
{
  document.body.style.backgroundImage = '';
  disposeVideoElement(document.getElementById('videoBackground'));
}

function setBackgroundFit(index)
{
  document.getElementById('videoBackground').style.objectFit = ["contain", "cover", "fill", "none"][index];
  document.body.style.backgroundSize = ["contain", "cover", "100% 100%", "auto"][index];
}

function getExtension(filePath) {
  return filePath.substring(filePath.lastIndexOf(".") + 1, filePath.length) || filePath;
}

function hexToRgb(hex) {
  let result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

//ref: https://stackoverflow.com/questions/3258587/how-to-properly-unload-destroy-a-video-element
function disposeVideoElement(element) {
  if (element != null && element.hasAttribute("src")) {
    element.pause();
    element.removeAttribute("src"); // empty source
    element.load();
  }
}

function RGBtoHSV(r, g, b) {
    if (arguments.length === 1) {
        g = r.g, b = r.b, r = r.r;
    }
    var max = Math.max(r, g, b), min = Math.min(r, g, b),
        d = max - min,
        h,
        s = (max === 0 ? 0 : d / max),
        v = max / 255;

    switch (max) {
        case min: h = 0; break;
        case r: h = (g - b) + d * (g < b ? 6: 0); h /= 6 * d; break;
        case g: h = (b - r) + d * 2; h /= 6 * d; break;
        case b: h = (r - g) + d * 4; h /= 6 * d; break;
    }

    return {
        h: h,
        s: s,
        v: v
    };
}

function pointerPrototype() {
  this.id = -1;
  this.texcoordX = 0;
  this.texcoordY = 0;
  this.prevTexcoordX = 0;
  this.prevTexcoordY = 0;
  this.deltaX = 0;
  this.deltaY = 0;
  this.down = false;
  this.moved = false;
  this.color = [30, 0, 300];
}

let pointers = [];
let splatStack = [];
pointers.push(new pointerPrototype());

const { gl, ext } = getWebGLContext(canvas);

if (isMobile()) {
  config.DYE_RESOLUTION = 512;
}
if (!ext.supportLinearFiltering) {
  config.DYE_RESOLUTION = 512;
  config.SHADING = false;
  config.BLOOM = false;
  config.SUNRAYS = false;
}

function getWebGLContext(canvas) {
  const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };

  let gl = canvas.getContext("webgl2", params);
  const isWebGL2 = !!gl;
  if (!isWebGL2) gl = canvas.getContext("webgl", params) || canvas.getContext("experimental-webgl", params);

  let halfFloat;
  let supportLinearFiltering;
  if (isWebGL2) {
    gl.getExtension("EXT_color_buffer_float");
    supportLinearFiltering = gl.getExtension("OES_texture_float_linear");
  } else {
    halfFloat = gl.getExtension("OES_texture_half_float");
    supportLinearFiltering = gl.getExtension("OES_texture_half_float_linear");
  }

  gl.clearColor(0.0, 0.0, 0.0, 1.0);

  const halfFloatTexType = isWebGL2 ? gl.HALF_FLOAT : halfFloat.HALF_FLOAT_OES;
  let formatRGBA;
  let formatRG;
  let formatR;

  if (isWebGL2) {
    formatRGBA = getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, halfFloatTexType);
    formatRG = getSupportedFormat(gl, gl.RG16F, gl.RG, halfFloatTexType);
    formatR = getSupportedFormat(gl, gl.R16F, gl.RED, halfFloatTexType);
  } else {
    formatRGBA = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    formatRG = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
    formatR = getSupportedFormat(gl, gl.RGBA, gl.RGBA, halfFloatTexType);
  }

  return {
    gl,
    ext: {
      formatRGBA,
      formatRG,
      formatR,
      halfFloatTexType,
      supportLinearFiltering,
    },
  };
}

function getSupportedFormat(gl, internalFormat, format, type) {
  if (!supportRenderTextureFormat(gl, internalFormat, format, type)) {
    switch (internalFormat) {
      case gl.R16F:
        return getSupportedFormat(gl, gl.RG16F, gl.RG, type);
      case gl.RG16F:
        return getSupportedFormat(gl, gl.RGBA16F, gl.RGBA, type);
      default:
        return null;
    }
  }

  return {
    internalFormat,
    format,
  };
}

function supportRenderTextureFormat(gl, internalFormat, format, type) {
  let texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, 4, 4, 0, format, type, null);

  let fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  return status == gl.FRAMEBUFFER_COMPLETE;
}

function isMobile() {
  return /Mobi|Android/i.test(navigator.userAgent);
}

function captureScreenshot() {
  let res = getResolution(config.CAPTURE_RESOLUTION);
  let target = createFBO(
    res.width,
    res.height,
    ext.formatRGBA.internalFormat,
    ext.formatRGBA.format,
    ext.halfFloatTexType,
    gl.NEAREST
  );
  render(target);

  let texture = framebufferToTexture(target);
  texture = normalizeTexture(texture, target.width, target.height);

  let captureCanvas = textureToCanvas(texture, target.width, target.height);
  let datauri = captureCanvas.toDataURL();
  downloadURI("fluid.png", datauri);
  URL.revokeObjectURL(datauri);
}

function framebufferToTexture(target) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
  let length = target.width * target.height * 4;
  let texture = new Float32Array(length);
  gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.FLOAT, texture);
  return texture;
}

function normalizeTexture(texture, width, height) {
  let result = new Uint8Array(texture.length);
  let id = 0;
  for (let i = height - 1; i >= 0; i--) {
    for (let j = 0; j < width; j++) {
      let nid = i * width * 4 + j * 4;
      result[nid + 0] = clamp01(texture[id + 0]) * 255;
      result[nid + 1] = clamp01(texture[id + 1]) * 255;
      result[nid + 2] = clamp01(texture[id + 2]) * 255;
      result[nid + 3] = clamp01(texture[id + 3]) * 255;
      id += 4;
    }
  }
  return result;
}

function clamp01(input) {
  return Math.min(Math.max(input, 0), 1);
}

function textureToCanvas(texture, width, height) {
  let captureCanvas = document.createElement("canvas");
  let ctx = captureCanvas.getContext("2d");
  captureCanvas.width = width;
  captureCanvas.height = height;

  let imageData = ctx.createImageData(width, height);
  imageData.data.set(texture);
  ctx.putImageData(imageData, 0, 0);

  return captureCanvas;
}

function downloadURI(filename, uri) {
  let link = document.createElement("a");
  link.download = filename;
  link.href = uri;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

class Material {
  constructor(vertexShader, fragmentShaderSource) {
    this.vertexShader = vertexShader;
    this.fragmentShaderSource = fragmentShaderSource;
    this.programs = [];
    this.activeProgram = null;
    this.uniforms = [];
  }

  setKeywords(keywords) {
    let hash = 0;
    for (let i = 0; i < keywords.length; i++) hash += hashCode(keywords[i]);

    let program = this.programs[hash];
    if (program == null) {
      let fragmentShader = compileShader(gl.FRAGMENT_SHADER, this.fragmentShaderSource, keywords);
      program = createProgram(this.vertexShader, fragmentShader);
      this.programs[hash] = program;
    }

    if (program == this.activeProgram) return;

    this.uniforms = getUniforms(program);
    this.activeProgram = program;
  }

  bind() {
    gl.useProgram(this.activeProgram);
  }
}

class Program {
  constructor(vertexShader, fragmentShader) {
    this.uniforms = {};
    this.program = createProgram(vertexShader, fragmentShader);
    this.uniforms = getUniforms(this.program);
  }

  bind() {
    gl.useProgram(this.program);
  }
}

function createProgram(vertexShader, fragmentShader) {
  let program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw gl.getProgramInfoLog(program);

  return program;
}

function getUniforms(program) {
  let uniforms = [];
  let uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < uniformCount; i++) {
    let uniformName = gl.getActiveUniform(program, i).name;
    uniforms[uniformName] = gl.getUniformLocation(program, uniformName);
  }
  return uniforms;
}

function compileShader(type, source, keywords) {
  source = addKeywords(source, keywords);

  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw gl.getShaderInfoLog(shader);

  return shader;
}

function addKeywords(source, keywords) {
  if (keywords == null) return source;
  let keywordsString = "";
  keywords.forEach((keyword) => {
    keywordsString += "#define " + keyword + "\n";
  });
  return keywordsString + source;
}

const baseVertexShader = compileShader(
  gl.VERTEX_SHADER,
  `
    precision highp float;

    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform vec2 texelSize;

    void main () {
        vUv = aPosition * 0.5 + 0.5;
        vL = vUv - vec2(texelSize.x, 0.0);
        vR = vUv + vec2(texelSize.x, 0.0);
        vT = vUv + vec2(0.0, texelSize.y);
        vB = vUv - vec2(0.0, texelSize.y);
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`
);

const blurVertexShader = compileShader(
  gl.VERTEX_SHADER,
  `
    precision highp float;

    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    uniform vec2 texelSize;

    void main () {
        vUv = aPosition * 0.5 + 0.5;
        float offset = 1.33333333;
        vL = vUv - texelSize * offset;
        vR = vUv + texelSize * offset;
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`
);

const blurShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    uniform sampler2D uTexture;

    void main () {
        vec4 sum = texture2D(uTexture, vUv) * 0.29411764;
        sum += texture2D(uTexture, vL) * 0.35294117;
        sum += texture2D(uTexture, vR) * 0.35294117;
        gl_FragColor = sum;
    }
`
);

const copyShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    uniform sampler2D uTexture;

    void main () {
        gl_FragColor = texture2D(uTexture, vUv);
    }
`
);

const clearShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    uniform sampler2D uTexture;
    uniform float value;

    void main () {
        gl_FragColor = value * texture2D(uTexture, vUv);
    }
`
);

const colorShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision mediump float;

    uniform vec4 color;

    void main () {
        gl_FragColor = color;
    }
`
);

const checkerboardShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float aspectRatio;

    #define SCALE 25.0

    void main () {
        vec2 uv = floor(vUv * SCALE * vec2(aspectRatio, 1.0));
        float v = mod(uv.x + uv.y, 2.0);
        v = v * 0.1 + 0.8;
        gl_FragColor = vec4(vec3(v), 1.0);
    }
`
);

const displayShaderSource = `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;
    uniform sampler2D uBloom;
    uniform sampler2D uSunrays;
    uniform sampler2D uDithering;
    uniform vec2 ditherScale;
    uniform vec2 texelSize;
    uniform float neon;

    vec3 linearToGamma (vec3 color) {
        color = max(color, vec3(0));
        return max(1.055 * pow(color, vec3(0.416666667)) - 0.055, vec3(0));
    }

    void main () {
        vec3 c = texture2D(uTexture, vUv).rgb;

    #ifdef SHADING
        vec3 lc = texture2D(uTexture, vL).rgb;
        vec3 rc = texture2D(uTexture, vR).rgb;
        vec3 tc = texture2D(uTexture, vT).rgb;
        vec3 bc = texture2D(uTexture, vB).rgb;

        float dx = length(rc) - length(lc);
        float dy = length(tc) - length(bc);

        vec3 n = normalize(vec3(dx, dy, length(texelSize)));
        vec3 l = vec3(0.0, 0.0, 1.0);

        float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
        c *= diffuse;
    #endif

    #ifdef BLOOM
        vec3 bloom = texture2D(uBloom, vUv).rgb;
    #endif

    #ifdef SUNRAYS
        float sunrays = texture2D(uSunrays, vUv).r;
        c *= sunrays;
    #ifdef BLOOM
        bloom *= sunrays;
    #endif
    #endif

    #ifdef BLOOM
        float noise = texture2D(uDithering, vUv * ditherScale).r;
        noise = noise * 2.0 - 1.0;
        bloom += noise / 255.0;
        bloom = linearToGamma(bloom);
        c += bloom;
    #endif

    if (neon > 0.0) {
        // Runs on the finished picture (dye + glow). A dim yellow or cyan is a dirty mustard / gray fog, while a dim red or blue is just a deeper red / blue,
        // because yellow and cyan carry far more brightness per bit of dye. So the faint haze of BRIGHT hues (brightness-to-value ratio high) is crushed
        // toward dark, leaving them as glowing shapes on a dark ground; red and blue haze is left alone.
        vec3 lw = vec3(0.299, 0.587, 0.114);
        float m = max(c.r, max(c.g, c.b));
        float rr = dot(c, lw) / max(m, 0.0001);
        float faint = 1.0 - smoothstep(0.05, 0.80, m);
        c *= 1.0 - 0.90 * neon * faint * smoothstep(0.35, 0.90, rr);
        // a little general fade of the thinnest dye, then win back saturation (extra for washed-out pixels)
        c *= mix(1.0, 0.45 + 0.55 * smoothstep(0.04, 0.5, dot(c, lw)), neon * 0.20);
        float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
        float sat = mx > 0.0 ? (mx - mn) / mx : 0.0;
        float L1 = dot(c, lw);
        c = max(vec3(L1) + (c - vec3(L1)) * (1.0 + neon * (0.25 + 0.25 * (1.0 - sat))), vec3(0.0));
        // keep overexposed cores in their color instead of clipping to white
        float m2 = max(c.r, max(c.g, c.b));
        c /= pow(max(m2, 1.0), min(1.0, neon * 1.4));
    }

        float a = max(c.r, max(c.g, c.b));
        gl_FragColor = vec4(c, a);
    }
`;

const bloomPrefilterShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform vec3 curve;
    uniform float threshold;

    void main () {
        vec3 c = texture2D(uTexture, vUv).rgb;
        float br = max(c.r, max(c.g, c.b));
        float rq = clamp(br - curve.x, 0.0, curve.y);
        rq = curve.z * rq * rq;
        c *= max(rq, br - threshold) / max(br, 0.0001);
        gl_FragColor = vec4(c, 0.0);
    }
`
);

const bloomBlurShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;

    void main () {
        vec4 sum = vec4(0.0);
        sum += texture2D(uTexture, vL);
        sum += texture2D(uTexture, vR);
        sum += texture2D(uTexture, vT);
        sum += texture2D(uTexture, vB);
        sum *= 0.25;
        gl_FragColor = sum;
    }
`
);

const bloomFinalShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision mediump float;
    precision mediump sampler2D;

    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uTexture;
    uniform float intensity;

    void main () {
        vec4 sum = vec4(0.0);
        sum += texture2D(uTexture, vL);
        sum += texture2D(uTexture, vR);
        sum += texture2D(uTexture, vT);
        sum += texture2D(uTexture, vB);
        sum *= 0.25;
        gl_FragColor = sum * intensity;
    }
`
);

const sunraysMaskShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;

    void main () {
        vec4 c = texture2D(uTexture, vUv);
        float br = max(c.r, max(c.g, c.b));
        c.a = 1.0 - min(max(br * 20.0, 0.0), 0.8);
        gl_FragColor = c;
    }
`
);

const sunraysShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTexture;
    uniform float weight;

    #define ITERATIONS 16

    void main () {
        float Density = 0.3;
        float Decay = 0.95;
        float Exposure = 0.7;

        vec2 coord = vUv;
        vec2 dir = vUv - 0.5;

        dir *= 1.0 / float(ITERATIONS) * Density;
        float illuminationDecay = 1.0;

        float color = texture2D(uTexture, vUv).a;

        for (int i = 0; i < ITERATIONS; i++)
        {
            coord -= dir;
            float col = texture2D(uTexture, coord).a;
            color += col * illuminationDecay * weight;
            illuminationDecay *= Decay;
        }

        gl_FragColor = vec4(color * Exposure, 0.0, 0.0, 1.0);
    }
`
);

const splatShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uTarget;
    uniform float aspectRatio;
    uniform vec3 color;
    uniform vec2 point;
    uniform float radius;

    void main () {
        vec2 p = vUv - point.xy;
        p.x *= aspectRatio;
        vec3 splat = exp(-dot(p, p) / radius) * color;
        vec3 base = texture2D(uTarget, vUv).xyz;
        gl_FragColor = vec4(base + splat, 1.0);
    }
`
);

const advectionShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 texelSize;
    uniform vec2 dyeTexelSize;
    uniform float dt;
    uniform float dissipation;

    vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
        vec2 st = uv / tsize - 0.5;

        vec2 iuv = floor(st);
        vec2 fuv = fract(st);

        vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
        vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
        vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
        vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);

        return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
    }

    void main () {
    #ifdef MANUAL_FILTERING
        vec2 coord = vUv - dt * bilerp(uVelocity, vUv, texelSize).xy * texelSize;
        vec4 result = bilerp(uSource, coord, dyeTexelSize);
    #else
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        vec4 result = texture2D(uSource, coord);
    #endif
        float decay = 1.0 + dissipation * dt;
        gl_FragColor = result / decay;
    }`,
  ext.supportLinearFiltering ? null : ["MANUAL_FILTERING"]
);

const divergenceShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uVelocity, vL).x;
        float R = texture2D(uVelocity, vR).x;
        float T = texture2D(uVelocity, vT).y;
        float B = texture2D(uVelocity, vB).y;

        vec2 C = texture2D(uVelocity, vUv).xy;
        if (vL.x < 0.0) { L = -C.x; }
        if (vR.x > 1.0) { R = -C.x; }
        if (vT.y > 1.0) { T = -C.y; }
        if (vB.y < 0.0) { B = -C.y; }

        float div = 0.5 * (R - L + T - B);
        gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
    }
`
);

const curlShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uVelocity, vL).y;
        float R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x;
        float B = texture2D(uVelocity, vB).x;
        float vorticity = R - L - T + B;
        gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
    }
`
);

const vorticityShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision highp float;
    precision highp sampler2D;

    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform float curl;
    uniform float dt;

    void main () {
        float L = texture2D(uCurl, vL).x;
        float R = texture2D(uCurl, vR).x;
        float T = texture2D(uCurl, vT).x;
        float B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;

        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= curl * C;
        force.y *= -1.0;

        vec2 vel = texture2D(uVelocity, vUv).xy;
        gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);
    }
`
);

const pressureShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;

    void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        float C = texture2D(uPressure, vUv).x;
        float divergence = texture2D(uDivergence, vUv).x;
        float pressure = (L + R + B + T - divergence) * 0.25;
        gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
    }
`
);

const gradientSubtractShader = compileShader(
  gl.FRAGMENT_SHADER,
  `
    precision mediump float;
    precision mediump sampler2D;

    varying highp vec2 vUv;
    varying highp vec2 vL;
    varying highp vec2 vR;
    varying highp vec2 vT;
    varying highp vec2 vB;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;

    void main () {
        float L = texture2D(uPressure, vL).x;
        float R = texture2D(uPressure, vR).x;
        float T = texture2D(uPressure, vT).x;
        float B = texture2D(uPressure, vB).x;
        vec2 velocity = texture2D(uVelocity, vUv).xy;
        velocity.xy -= vec2(R - L, T - B);
        gl_FragColor = vec4(velocity, 0.0, 1.0);
    }
`
);

const blit = (() => {
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  return (destination) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  };
})();

let dye;
let velocity;
let divergence;
let curl;
let pressure;
let bloom;
let bloomFramebuffers = [];
let sunrays;
let sunraysTemp;

let ditheringTexture = createTextureAsync("LDR_LLL1_0.png");

const blurProgram = new Program(blurVertexShader, blurShader);
const copyProgram = new Program(baseVertexShader, copyShader);
const clearProgram = new Program(baseVertexShader, clearShader);
const colorProgram = new Program(baseVertexShader, colorShader);
const checkerboardProgram = new Program(baseVertexShader, checkerboardShader);
const bloomPrefilterProgram = new Program(baseVertexShader, bloomPrefilterShader);
const bloomBlurProgram = new Program(baseVertexShader, bloomBlurShader);
const bloomFinalProgram = new Program(baseVertexShader, bloomFinalShader);
const sunraysMaskProgram = new Program(baseVertexShader, sunraysMaskShader);
const sunraysProgram = new Program(baseVertexShader, sunraysShader);
const splatProgram = new Program(baseVertexShader, splatShader);
const advectionProgram = new Program(baseVertexShader, advectionShader);
const divergenceProgram = new Program(baseVertexShader, divergenceShader);
const curlProgram = new Program(baseVertexShader, curlShader);
const vorticityProgram = new Program(baseVertexShader, vorticityShader);
const pressureProgram = new Program(baseVertexShader, pressureShader);
const gradienSubtractProgram = new Program(baseVertexShader, gradientSubtractShader);

const displayMaterial = new Material(baseVertexShader, displayShaderSource);

function initFramebuffers() {
  let simRes = getResolution(config.SIM_RESOLUTION * OS.s);
  let dyeRes = getResolution(config.DYE_RESOLUTION * OS.s);

  const texType = ext.halfFloatTexType;
  const rgba = ext.formatRGBA;
  const rg = ext.formatRG;
  const r = ext.formatR;
  const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

  if (dye == null)
    dye = createDoubleFBO(dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);
  else dye = resizeDoubleFBO(dye, dyeRes.width, dyeRes.height, rgba.internalFormat, rgba.format, texType, filtering);

  if (velocity == null)
    velocity = createDoubleFBO(simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);
  else
    velocity = resizeDoubleFBO(velocity, simRes.width, simRes.height, rg.internalFormat, rg.format, texType, filtering);

  divergence = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
  curl = createFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);
  pressure = createDoubleFBO(simRes.width, simRes.height, r.internalFormat, r.format, texType, gl.NEAREST);

  initBloomFramebuffers();
  initSunraysFramebuffers();
}

function initBloomFramebuffers() {
  let res = getResolution(config.BLOOM_RESOLUTION);

  const texType = ext.halfFloatTexType;
  const rgba = ext.formatRGBA;
  const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

  bloom = createFBO(res.width, res.height, rgba.internalFormat, rgba.format, texType, filtering);

  bloomFramebuffers.length = 0;
  for (let i = 0; i < config.BLOOM_ITERATIONS; i++) {
    let width = res.width >> (i + 1);
    let height = res.height >> (i + 1);

    if (width < 2 || height < 2) break;

    let fbo = createFBO(width, height, rgba.internalFormat, rgba.format, texType, filtering);
    bloomFramebuffers.push(fbo);
  }
}

function initSunraysFramebuffers() {
  let res = getResolution(config.SUNRAYS_RESOLUTION);

  const texType = ext.halfFloatTexType;
  const r = ext.formatR;
  const filtering = ext.supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

  sunrays = createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
  sunraysTemp = createFBO(res.width, res.height, r.internalFormat, r.format, texType, filtering);
}

function createFBO(w, h, internalFormat, format, type, param) {
  gl.activeTexture(gl.TEXTURE0);
  let texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

  let fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.viewport(0, 0, w, h);
  gl.clear(gl.COLOR_BUFFER_BIT);

  let texelSizeX = 1.0 / w;
  let texelSizeY = 1.0 / h;

  return {
    texture,
    fbo,
    width: w,
    height: h,
    texelSizeX,
    texelSizeY,
    attach(id) {
      gl.activeTexture(gl.TEXTURE0 + id);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      return id;
    },
  };
}

function createDoubleFBO(w, h, internalFormat, format, type, param) {
  let fbo1 = createFBO(w, h, internalFormat, format, type, param);
  let fbo2 = createFBO(w, h, internalFormat, format, type, param);

  return {
    width: w,
    height: h,
    texelSizeX: fbo1.texelSizeX,
    texelSizeY: fbo1.texelSizeY,
    get read() {
      return fbo1;
    },
    set read(value) {
      fbo1 = value;
    },
    get write() {
      return fbo2;
    },
    set write(value) {
      fbo2 = value;
    },
    swap() {
      let temp = fbo1;
      fbo1 = fbo2;
      fbo2 = temp;
    },
  };
}

function resizeFBO(target, w, h, internalFormat, format, type, param) {
  let newFBO = createFBO(w, h, internalFormat, format, type, param);
  copyProgram.bind();
  gl.uniform1i(copyProgram.uniforms.uTexture, target.attach(0));
  blit(newFBO.fbo);
  return newFBO;
}

function resizeDoubleFBO(target, w, h, internalFormat, format, type, param) {
  if (target.width == w && target.height == h) return target;
  target.read = resizeFBO(target.read, w, h, internalFormat, format, type, param);
  target.write = createFBO(w, h, internalFormat, format, type, param);
  target.width = w;
  target.height = h;
  target.texelSizeX = 1.0 / w;
  target.texelSizeY = 1.0 / h;
  return target;
}

function createTextureAsync(url) {
  let texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255]));

  let obj = {
    texture,
    width: 1,
    height: 1,
    attach(id) {
      gl.activeTexture(gl.TEXTURE0 + id);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      return id;
    },
  };

  let image = new Image();
  image.onload = () => {
    obj.width = image.width;
    obj.height = image.height;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
  };
  image.src = url;

  return obj;
}

function updateKeywords() {
  let displayKeywords = [];
  if (config.SHADING) displayKeywords.push("SHADING");
  if (config.BLOOM) displayKeywords.push("BLOOM");
  if (config.SUNRAYS) displayKeywords.push("SUNRAYS");
  displayMaterial.setKeywords(displayKeywords);
}

updateKeywords();
initFramebuffers();
multipleSplats(parseInt(Math.random() * 20) + 5);

let lastUpdateTime = Date.now();
let colorUpdateTimer = 0.0;
update();

function update() {
  const dt = calcDeltaTime();
  if (resizeCanvas() || OS.dirty) { OS.dirty = false; initFramebuffers(); }
  updatePalette(dt);
  NEON.cur += (NEON.target * NEON.strength - NEON.cur) * Math.min(1, dt * 2.5); // eases in / out with the song
  updateColors(dt);
  applyInputs();
  instrTick(dt);
  if (!config.PAUSED) step(dt);
  render(null);
  requestAnimationFrame(update);
}

function calcDeltaTime() {
  let now = Date.now();
  let dt = (now - lastUpdateTime) / 1000;
  dt = Math.min(dt, 0.016666);
  lastUpdateTime = now;
  return dt;
}

function resizeCanvas() {
  applyOverscanStyle();
  let width = scaleByPixelRatio(canvas.clientWidth);
  let height = scaleByPixelRatio(canvas.clientHeight);
  if (canvas.width != width || canvas.height != height) {
    canvas.width = width;
    canvas.height = height;
    return true;
  }
  return false;
}

function updateColors(dt) {
  colorUpdateTimer += dt * config.COLOR_UPDATE_SPEED;
  if (colorUpdateTimer >= 1) {
    colorUpdateTimer = wrap(colorUpdateTimer, 0, 1);
    pointers.forEach((p) => {
      p.color = generateColor();
    });
  }
}

function applyInputs() {
  if (splatStack.length > 0) multipleSplats(splatStack.pop());

  pointers.forEach((p) => {
    if (p.moved) {
      p.moved = false;
      splatPointer(p);
    }
  });
}

function step(dt) {
  gl.disable(gl.BLEND);
  gl.viewport(0, 0, velocity.width, velocity.height);

  curlProgram.bind();
  gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
  blit(curl.fbo);

  vorticityProgram.bind();
  gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
  gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
  gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
  gl.uniform1f(vorticityProgram.uniforms.dt, dt);
  blit(velocity.write.fbo);
  velocity.swap();

  divergenceProgram.bind();
  gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
  blit(divergence.fbo);

  clearProgram.bind();
  gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
  gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
  blit(pressure.write.fbo);
  pressure.swap();

  pressureProgram.bind();
  gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
  for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
    gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
    blit(pressure.write.fbo);
    pressure.swap();
  }

  gradienSubtractProgram.bind();
  gl.uniform2f(gradienSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  gl.uniform1i(gradienSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
  gl.uniform1i(gradienSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
  blit(velocity.write.fbo);
  velocity.swap();

  advectionProgram.bind();
  gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
  if (!ext.supportLinearFiltering)
    gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
  let velocityId = velocity.read.attach(0);
  gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
  gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
  gl.uniform1f(advectionProgram.uniforms.dt, dt);
  gl.uniform1f(advectionProgram.uniforms.dissipation, config.VELOCITY_DISSIPATION);
  blit(velocity.write.fbo);
  velocity.swap();

  gl.viewport(0, 0, dye.width, dye.height);

  if (!ext.supportLinearFiltering) gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
  gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
  gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
  gl.uniform1f(advectionProgram.uniforms.dissipation, config.DENSITY_DISSIPATION * config.QUIET_FADE * _lingerMul * (1 + INSTR.FW.CLEAR * fwIntense()));
  blit(dye.write.fbo);
  dye.swap();
}

function render(target) {
  if (config.BLOOM) applyBloom(dye.read, bloom);
  if (config.SUNRAYS) {
    applySunrays(dye.read, dye.write, sunrays);
    blur(sunrays, sunraysTemp, 1);
  }

  if (target == null || !config.TRANSPARENT) {
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
  } else {
    gl.disable(gl.BLEND);
  }

  let width = target == null ? gl.drawingBufferWidth : target.width;
  let height = target == null ? gl.drawingBufferHeight : target.height;
  gl.viewport(0, 0, width, height);

  let fbo = target == null ? null : target.fbo;
  if (!config.TRANSPARENT) drawColor(fbo, normalizeColor(config.BACK_COLOR));
  //if (target == null && config.TRANSPARENT)
  //drawCheckerboard(fbo);
  drawDisplay(fbo, width, height);
}

function drawColor(fbo, color) {
  colorProgram.bind();
  gl.uniform4f(colorProgram.uniforms.color, color.r, color.g, color.b, 1);
  blit(fbo);
}

function drawCheckerboard(fbo) {
  checkerboardProgram.bind();
  gl.uniform1f(checkerboardProgram.uniforms.aspectRatio, canvas.width / canvas.height);
  blit(fbo);
}

function drawDisplay(fbo, width, height) {
  displayMaterial.bind();
  if (config.SHADING) gl.uniform2f(displayMaterial.uniforms.texelSize, 1.0 / width, 1.0 / height);
  gl.uniform1i(displayMaterial.uniforms.uTexture, dye.read.attach(0));
  if (config.BLOOM) {
    gl.uniform1i(displayMaterial.uniforms.uBloom, bloom.attach(1));
    gl.uniform1i(displayMaterial.uniforms.uDithering, ditheringTexture.attach(2));
    let scale = getTextureScale(ditheringTexture, width, height);
    gl.uniform2f(displayMaterial.uniforms.ditherScale, scale.x, scale.y);
  }
  if (config.SUNRAYS) gl.uniform1i(displayMaterial.uniforms.uSunrays, sunrays.attach(3));
  gl.uniform1f(displayMaterial.uniforms.neon, NEON.cur);
  blit(fbo);
}

function applyBloom(source, destination) {
  if (bloomFramebuffers.length < 2) return;

  let last = destination;

  gl.disable(gl.BLEND);
  bloomPrefilterProgram.bind();
  let knee = config.BLOOM_THRESHOLD * config.BLOOM_SOFT_KNEE + 0.0001;
  let curve0 = config.BLOOM_THRESHOLD - knee;
  let curve1 = knee * 2;
  let curve2 = 0.25 / knee;
  gl.uniform3f(bloomPrefilterProgram.uniforms.curve, curve0, curve1, curve2);
  gl.uniform1f(bloomPrefilterProgram.uniforms.threshold, config.BLOOM_THRESHOLD);
  gl.uniform1i(bloomPrefilterProgram.uniforms.uTexture, source.attach(0));
  gl.viewport(0, 0, last.width, last.height);
  blit(last.fbo);

  bloomBlurProgram.bind();
  for (let i = 0; i < bloomFramebuffers.length; i++) {
    let dest = bloomFramebuffers[i];
    gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
    gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
    gl.viewport(0, 0, dest.width, dest.height);
    blit(dest.fbo);
    last = dest;
  }

  gl.blendFunc(gl.ONE, gl.ONE);
  gl.enable(gl.BLEND);

  for (let i = bloomFramebuffers.length - 2; i >= 0; i--) {
    let baseTex = bloomFramebuffers[i];
    gl.uniform2f(bloomBlurProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
    gl.uniform1i(bloomBlurProgram.uniforms.uTexture, last.attach(0));
    gl.viewport(0, 0, baseTex.width, baseTex.height);
    blit(baseTex.fbo);
    last = baseTex;
  }

  gl.disable(gl.BLEND);
  bloomFinalProgram.bind();
  gl.uniform2f(bloomFinalProgram.uniforms.texelSize, last.texelSizeX, last.texelSizeY);
  gl.uniform1i(bloomFinalProgram.uniforms.uTexture, last.attach(0));
  gl.uniform1f(bloomFinalProgram.uniforms.intensity, config.BLOOM_INTENSITY);
  gl.viewport(0, 0, destination.width, destination.height);
  blit(destination.fbo);
}

function applySunrays(source, mask, destination) {
  gl.disable(gl.BLEND);
  sunraysMaskProgram.bind();
  gl.uniform1i(sunraysMaskProgram.uniforms.uTexture, source.attach(0));
  gl.viewport(0, 0, mask.width, mask.height);
  blit(mask.fbo);

  sunraysProgram.bind();
  gl.uniform1f(sunraysProgram.uniforms.weight, config.SUNRAYS_WEIGHT);
  gl.uniform1i(sunraysProgram.uniforms.uTexture, mask.attach(0));
  gl.viewport(0, 0, destination.width, destination.height);
  blit(destination.fbo);
}

function blur(target, temp, iterations) {
  blurProgram.bind();
  for (let i = 0; i < iterations; i++) {
    gl.uniform2f(blurProgram.uniforms.texelSize, target.texelSizeX, 0.0);
    gl.uniform1i(blurProgram.uniforms.uTexture, target.attach(0));
    blit(temp.fbo);

    gl.uniform2f(blurProgram.uniforms.texelSize, 0.0, target.texelSizeY);
    gl.uniform1i(blurProgram.uniforms.uTexture, temp.attach(0));
    blit(target.fbo);
  }
}

function splatPointer(pointer) {
  const k = config.CURSOR_AMOUNT;
  if (k <= 0) return;
  let dx = pointer.deltaX * config.SPLAT_FORCE * k * OS.s;
  let dy = pointer.deltaY * config.SPLAT_FORCE * k * OS.s;
  const c = pointer.color;
  splat(pointer.texcoordX, pointer.texcoordY, dx, dy, { r: c.r * k, g: c.g * k, b: c.b * k }, Math.sqrt(k), true);
}

function randomSplatAt(x, y, pushDir, rs) {
  const color = generateColor();
  const pb = 10.0 * config.PULSE_BRIGHT;
  color.r *= pb;
  color.g *= pb;
  color.b *= pb;
  const dx = 1000 * (Math.random() - 0.5) + pushDir * MONITORS.CROSS_PUSH;
  const dy = 1000 * (Math.random() - 0.5);
  splat(x, y, dx, dy, color, rs);
}

function multipleSplats(amount) {
  const n = MONITORS.enabled ? MONITORS.count : 1;
  const sm = srcMonitor(n);
  for (let i = 0; i < amount; i++) {
    if (sm >= 0) {
      const rc = monRect(sm, n);
      randomSplatAt(rc.x0 + Math.random() * (rc.x1 - rc.x0), rc.y0 + Math.random() * (rc.y1 - rc.y0), sm === 0 ? 3 : -3, monScale(sm, n)); // pushed toward the other monitor
      continue;
    }
    if (n <= 1) {
      randomSplatAt(Math.random(), Math.random(), 0, 1);
      continue;
    }
    // Each hit comes from a random non-empty mix of monitors; each one fires independently.
    let fired = 0;
    for (let m = 0; m < n; m++) {
      if (Math.random() < 0.5) continue;
      fired++;
      const toward = m === 0 ? 1 : m === n - 1 ? -1 : (Math.random() < 0.5 ? -1 : 1);
      { const rc = monRect(m, n); randomSplatAt(rc.x0 + Math.random() * (rc.x1 - rc.x0), rc.y0 + Math.random() * (rc.y1 - rc.y0), toward, monScale(m, n)); }
    }
    if (fired === 0) {
      const m = Math.floor(Math.random() * n);
      const toward = m === 0 ? 1 : m === n - 1 ? -1 : (Math.random() < 0.5 ? -1 : 1);
      const rc = monRect(m, n); randomSplatAt(rc.x0 + Math.random() * (rc.x1 - rc.x0), rc.y0 + Math.random() * (rc.y1 - rc.y0), toward, monScale(m, n));
    }
  }
}

function splat(x, y, dx, dy, color, radiusScale, raw) {
  const rScale = radiusScale || 1;
  if (!raw) { x = OS.x0 + x * OS.k; y = OS.x0 + y * OS.k; } // raw = already in canvas coordinates (the mouse)
  gl.viewport(0, 0, velocity.width, velocity.height);
  splatProgram.bind();
  gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
  gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
  gl.uniform2f(splatProgram.uniforms.point, x, y);
  gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0.0);
  gl.uniform1f(splatProgram.uniforms.radius, correctRadius((config.SPLAT_RADIUS / 100.0) * rScale) * OS.k * OS.k);
  blit(velocity.write.fbo);
  velocity.swap();

  gl.viewport(0, 0, dye.width, dye.height);
  gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
  gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
  blit(dye.write.fbo);
  dye.swap();
}

function correctRadius(radius) {
  let aspectRatio = canvas.width / canvas.height;
  if (aspectRatio > 1) radius *= aspectRatio;
  return radius;
}

// canvas.addEventListener('mousedown', e => {
//     let posX = scaleByPixelRatio(e.offsetX);
//     let posY = scaleByPixelRatio(e.offsetY);
//     let pointer = pointers.find(p => p.id == -1);
//     if (pointer == null)
//         pointer = new pointerPrototype();
//     updatePointerDownData(pointer, -1, posX, posY);
// });
let lastMove = -1;
function checkLastMove() {
  const currentMove = window.performance.now();
  if (currentMove - lastMove > 1000) {
    lastMove = currentMove;
    return true;
  }
  return false;
}

canvas.addEventListener("mousemove", (e) => {
  if (checkLastMove()) {
    let posX = scaleByPixelRatio(e.offsetX);
    let posY = scaleByPixelRatio(e.offsetY);
    let pointer = pointers.find((p) => p.id == -1);
    if (pointer == null) pointer = new pointerPrototype();
    updatePointerDownData(pointer, -1, posX, posY);
  }

  let pointer = pointers[0];
  if (!pointer.down) return;
  let posX = scaleByPixelRatio(e.offsetX);
  let posY = scaleByPixelRatio(e.offsetY);
  updatePointerMoveData(pointer, posX, posY);
});

window.addEventListener("mouseup", () => {
  updatePointerUpData(pointers[0]);
});

canvas.addEventListener("touchstart", (e) => {
  e.preventDefault();
  const touches = e.targetTouches;
  while (touches.length >= pointers.length) pointers.push(new pointerPrototype());
  for (let i = 0; i < touches.length; i++) {
    let posX = scaleByPixelRatio(touches[i].pageX);
    let posY = scaleByPixelRatio(touches[i].pageY);
    updatePointerDownData(pointers[i + 1], touches[i].identifier, posX, posY);
  }
});

canvas.addEventListener(
  "touchmove",
  (e) => {
    e.preventDefault();
    const touches = e.targetTouches;
    for (let i = 0; i < touches.length; i++) {
      let pointer = pointers[i + 1];
      if (!pointer.down) continue;
      let posX = scaleByPixelRatio(touches[i].pageX);
      let posY = scaleByPixelRatio(touches[i].pageY);
      updatePointerMoveData(pointer, posX, posY);
    }
  },
  false
);

window.addEventListener("touchend", (e) => {
  const touches = e.changedTouches;
  for (let i = 0; i < touches.length; i++) {
    let pointer = pointers.find((p) => p.id == touches[i].identifier);
    if (pointer == null) continue;
    updatePointerUpData(pointer);
  }
});

window.addEventListener("keydown", (e) => {
  if (e.code === "KeyP") config.PAUSED = !config.PAUSED;
  if (e.key === " ") splatStack.push(parseInt(Math.random() * 20) + 5);
});

function updatePointerDownData(pointer, id, posX, posY) {
  pointer.id = id;
  pointer.down = true;
  pointer.moved = false;
  pointer.texcoordX = posX / canvas.width;
  pointer.texcoordY = 1.0 - posY / canvas.height;
  pointer.prevTexcoordX = pointer.texcoordX;
  pointer.prevTexcoordY = pointer.texcoordY;
  pointer.deltaX = 0;
  pointer.deltaY = 0;
  pointer.color = generateColor();
}

function updatePointerMoveData(pointer, posX, posY) {
  pointer.prevTexcoordX = pointer.texcoordX;
  pointer.prevTexcoordY = pointer.texcoordY;
  pointer.texcoordX = posX / canvas.width;
  pointer.texcoordY = 1.0 - posY / canvas.height;
  pointer.deltaX = correctDeltaX(pointer.texcoordX - pointer.prevTexcoordX);
  pointer.deltaY = correctDeltaY(pointer.texcoordY - pointer.prevTexcoordY);
  pointer.moved = Math.abs(pointer.deltaX) > 0 || Math.abs(pointer.deltaY) > 0;
}

function updatePointerUpData(pointer) {
  pointer.down = false;
}

function correctDeltaX(delta) {
  let aspectRatio = canvas.width / canvas.height;
  if (aspectRatio < 1) delta *= aspectRatio;
  return delta;
}

function correctDeltaY(delta) {
  let aspectRatio = canvas.width / canvas.height;
  if (aspectRatio > 1) delta /= aspectRatio;
  return delta;
}

function generateColor() {
  return paletteColor();
}

function HSVtoRGB(h, s, v) {
  let r, g, b, i, f, p, q, t;
  i = Math.floor(h * 6);
  f = h * 6 - i;
  p = v * (1 - s);
  q = v * (1 - f * s);
  t = v * (1 - (1 - f) * s);

  switch (i % 6) {
    case 0:
      (r = v), (g = t), (b = p);
      break;
    case 1:
      (r = q), (g = v), (b = p);
      break;
    case 2:
      (r = p), (g = v), (b = t);
      break;
    case 3:
      (r = p), (g = q), (b = v);
      break;
    case 4:
      (r = t), (g = p), (b = v);
      break;
    case 5:
      (r = v), (g = p), (b = q);
      break;
  }

  return {
    r,
    g,
    b,
  };
}

function normalizeColor(input) {
  let output = {
    r: input.r / 255,
    g: input.g / 255,
    b: input.b / 255,
  };
  return output;
}

function wrap(value, min, max) {
  let range = max - min;
  if (range == 0) return min;
  return ((value - min) % range) + min;
}

function getResolution(resolution) {
  let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
  if (aspectRatio < 1) aspectRatio = 1.0 / aspectRatio;

  let min = Math.round(resolution);
  let max = Math.round(resolution * aspectRatio);

  if (gl.drawingBufferWidth > gl.drawingBufferHeight) return { width: max, height: min };
  else return { width: min, height: max };
}

function getTextureScale(texture, width, height) {
  return {
    x: width / texture.width,
    y: height / texture.height,
  };
}

function scaleByPixelRatio(input) {
  let pixelRatio = window.devicePixelRatio || 1;
  return Math.floor(input * pixelRatio);
}

function hashCode(s) {
  if (s.length == 0) return 0;
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash << 5) - hash + s.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}
