/*
 * The brain graph engine. A force layout decides which notes sit together, then the
 * flat map is folded over a cortex, so linked notes stay neighbours on the surface.
 * Plain canvas, no dependencies. The page provides window.BRAIN (see bin/brain-graph.mjs).
 */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ICO = { local: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/></svg>` };
function toast(msg) { $("#g-status").textContent = msg; }
function hilite(text, q) {
  const i = text.toLowerCase().indexOf(q);
  return i < 0 ? esc(text) : `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
}
/** Opens the note in Obsidian. Anonymous exports have no vault to open. */
const noteHref = (id) => (window.BRAIN.vault ? `obsidian://open?vault=${encodeURIComponent(window.BRAIN.vault)}&file=${encodeURIComponent(id)}` : "");

/* ---------- graph engine: a 2D force layout (d3-force style, hand-rolled), wrapped onto a 3D brain ---------- */
// The force layout still decides who sits next to whom; gWrap then folds that flat map over the cortex like a
// sheet, so linked notes stay neighbours on the surface while the whole thing reads as an organ, not a hairball.
const GS = {
  nodes: [], byId: new Map(), edges: [], adj: [], act: [], actEdges: [], on: null, ldeg: null, groups: [], hubDeg: Infinity,
  alpha: 0, alphaTarget: 0, w: 0, h: 0, dpr: 1, ctx: null,
  parts: [], adjE: [], cum: [], cumNodes: [], spawnAcc: 0, ripple: null, interacting: false, lastTs: 0, lastDraw: 0,
  selId: null, hover: -1, hl: null, raf: 0, dirty: true, anim: null, theme: null,
  // Camera: yaw turns the brain about its vertical axis, pitch tips it, px/py pan in screen pixels.
  yaw: -0.7, pitch: 0.18, zoom: 1, px: 0, py: 0, vyaw: 0, idleAt: 0,
  wrapTail: 0, dust: null, dustAt: 0, ec: new Float32Array(0), order: [],
  f: { off: new Set(store.get("brain-graph.Off", [])), unresolved: store.get("brain-graph.Unres", true), orphans: store.get("brain-graph.Orphans", true), local: false, depth: store.get("brain-graph.Depth", 1) },
};
const LINK_DIST = 46, CHARGE = -85, THETA2 = 0.81, DECAY = 0.6, ALPHA_MIN = 0.002, ALPHA_DECAY = 0.0228, GRAVITY = 0.035, Z_MIN = 0.45, Z_MAX = 7;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const gSel = () => (GS.selId ? GS.byId.get(GS.selId) || null : null);

function gSetData(idx) {
  const old = GS.byId;
  GS.groups = idx.groups || [];
  GS.theme = null;
  const nodes = idx.notes.map((n, i) => {
    const o = old.get(n.id);
    const gi = n.unresolved ? -1 : GS.groups.findIndex((g) => (g.prefixes || []).some((p) => n.id.startsWith(p)));
    return { i, id: n.id, title: n.title, folder: n.folder || "", un: !!n.unresolved, deg: n.degree || 0, gi,
      r: Math.min(22, 3.2 + Math.sqrt(n.degree || 0) * 1.6), ph: ((((i + 1) * 2654435761) >>> 0) % 6283) / 1000, amp: 0.035 + Math.min(0.09, Math.sqrt(n.degree || 0) * 0.011), fl: 0,
      x: o ? o.x : NaN, y: o ? o.y : NaN, vx: 0, vy: 0, fx: null, fy: null,
      X: o ? o.X : NaN, Y: o ? o.Y : NaN, Z: o ? o.Z : NaN, sx: NaN, sy: NaN, sz: 0, sp: 1, sr: 2 };
  });
  // Seed new nodes by group so the layout starts roughly clustered and settles fast.
  const ng = GS.groups.length + 1, R = Math.sqrt(nodes.length) * 16;
  for (const n of nodes) if (Number.isNaN(n.x)) {
    const a = ((n.gi < 0 ? GS.groups.length : n.gi) / ng) * Math.PI * 2 + (Math.random() - 0.5) * 1.2;
    const rr = R * (0.25 + Math.random() * 0.8);
    n.x = Math.cos(a) * rr; n.y = Math.sin(a) * rr;
  }
  GS.nodes = nodes;
  GS.byId = new Map(nodes.map((n) => [n.id, n]));
  GS.edges = (idx.edges || []).filter(([s, t]) => s !== t && nodes[s] && nodes[t]).map(([s, t]) => [s, t]);
  GS.adj = nodes.map(() => []);
  for (const [s, t] of GS.edges) { GS.adj[s].push(t); GS.adj[t].push(s); }
  const degs = nodes.filter((n) => !n.un).map((n) => n.deg).sort((a, b) => b - a);
  GS.hubDeg = degs.length ? degs[Math.min(degs.length - 1, Math.floor(degs.length * 0.04))] : Infinity;
  if (GS.selId && !GS.byId.has(GS.selId)) GS.selId = null;
  gApplyFilters(old.size ? 0.12 : 1);
  gCard();
  if (!$("#g-panel").hidden) gPanel();
}

function gBaseVisible(n) {
  if (n.un) return GS.f.unresolved;
  if (GS.f.off.has(n.gi >= 0 ? GS.groups[n.gi].name : "Other")) return false;
  if (!GS.f.orphans && !GS.adj[n.i].length) return false;
  return true;
}
function gApplyFilters(heat = 0.5) {
  const N = GS.nodes;
  const base = new Uint8Array(N.length);
  for (const n of N) base[n.i] = gBaseVisible(n) ? 1 : 0;
  let on = base;
  const sel = gSel();
  if (GS.f.local && sel) {
    on = new Uint8Array(N.length); on[sel.i] = 1;
    let frontier = [sel.i];
    for (let d = 0; d < GS.f.depth; d++) {
      const next = [];
      for (const i of frontier) for (const j of GS.adj[i]) if (!on[j] && base[j]) { on[j] = 1; next.push(j); }
      frontier = next;
    }
  }
  GS.on = on;
  GS.act = [];
  for (const n of N) if (on[n.i]) GS.act.push(n.i);
  GS.actEdges = GS.edges.filter(([s, t]) => on[s] && on[t]);
  GS.ldeg = new Float32Array(N.length);
  for (const [s, t] of GS.actEdges) { GS.ldeg[s]++; GS.ldeg[t]++; }
  // Edge lookup per node, and hub-weighted sources for the travelling signals.
  GS.adjE = N.map(() => []);
  GS.actEdges.forEach(([s, t], e) => { GS.adjE[s].push([t, e]); GS.adjE[t].push([s, e]); });
  GS.cum = []; GS.cumNodes = [];
  let acc = 0;
  for (const i of GS.act) if (GS.ldeg[i] > 0) { acc += Math.pow(GS.ldeg[i], 1.25); GS.cumNodes.push(i); GS.cum.push(acc); }
  GS.parts = []; GS.ripple = null;
  gUpdateHl();
  GS.wrapTail = 40;
  gReheat(heat);
  const notes = GS.act.filter((i) => !N[i].un).length;
  $("#g-status").textContent = N.length ? `${plural(notes, "note")}, ${plural(GS.actEdges.length, "link")} · drag to turn` : "No notes found in this vault.";
}
function gUpdateHl() {
  const s = gSel();
  if (!s || !GS.on || !GS.on[s.i]) { GS.hl = null; return; }
  GS.hl = new Set([s.i, ...GS.adj[s.i].filter((j) => GS.on[j])]);
}
function gReheat(a) { GS.alpha = Math.max(GS.alpha, a); gKick(); }

/* Barnes-Hut quadtree for the repulsion force. */
function qNode(x, y, s) { return { x, y, s, kids: null, pts: null, m: 0, cx: 0, cy: 0 }; }
function qInsert(q, i, depth) {
  if (!q.kids) {
    if (!q.pts) { q.pts = [i]; return; }
    if (depth > 14) { q.pts.push(i); return; }
    const old = q.pts; q.pts = null; q.kids = [null, null, null, null];
    for (const j of old) qPut(q, j, depth);
  }
  qPut(q, i, depth);
}
function qPut(q, i, depth) {
  const h = q.s / 2, n = GS.nodes[i];
  const ix = n.x >= q.x + h ? 1 : 0, iy = n.y >= q.y + h ? 1 : 0, k = iy * 2 + ix;
  if (!q.kids[k]) q.kids[k] = qNode(q.x + ix * h, q.y + iy * h, h);
  qInsert(q.kids[k], i, depth + 1);
}
function qAccum(q) {
  let m = 0, cx = 0, cy = 0;
  if (q.pts) for (const i of q.pts) { const n = GS.nodes[i]; cx += n.x; cy += n.y; m++; }
  else for (const c of q.kids) if (c) { qAccum(c); m += c.m; cx += c.cx * c.m; cy += c.cy * c.m; }
  q.m = m; q.cx = cx / m; q.cy = cy / m;
}
function qForce(q, n, i, a) {
  const dx = q.cx - n.x, dy = q.cy - n.y;
  let d2 = dx * dx + dy * dy;
  if (q.kids && (q.s * q.s) / THETA2 < d2) { const f = (CHARGE * a * q.m) / Math.max(d2, 1); n.vx += dx * f; n.vy += dy * f; return; }
  if (q.pts) {
    for (const j of q.pts) {
      if (j === i) continue;
      const o = GS.nodes[j];
      let ex = o.x - n.x, ey = o.y - n.y;
      if (!ex && !ey) { ex = (Math.random() - 0.5) * 1e-3; ey = (Math.random() - 0.5) * 1e-3; }
      const f = (CHARGE * a) / Math.max(ex * ex + ey * ey, 1);
      n.vx += ex * f; n.vy += ey * f;
    }
    return;
  }
  for (const c of q.kids) if (c) qForce(c, n, i, a);
}
function gTick() {
  const N = GS.nodes, act = GS.act, a = GS.alpha, ld = GS.ldeg;
  if (!act.length) { GS.alpha = 0; return; }
  for (const [s, t] of GS.actEdges) {
    const S = N[s], T = N[t];
    let dx = T.x + T.vx - S.x - S.vx || 1e-6, dy = T.y + T.vy - S.y - S.vy || 1e-6;
    let l = Math.sqrt(dx * dx + dy * dy);
    l = ((l - LINK_DIST) / l) * a / Math.min(ld[s], ld[t]);
    dx *= l; dy *= l;
    const b = ld[s] / (ld[s] + ld[t]);
    T.vx -= dx * b; T.vy -= dy * b; S.vx += dx * (1 - b); S.vy += dy * (1 - b);
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of act) { const n = N[i]; if (n.x < x0) x0 = n.x; if (n.y < y0) y0 = n.y; if (n.x > x1) x1 = n.x; if (n.y > y1) y1 = n.y; }
  const root = qNode(x0, y0, Math.max(x1 - x0, y1 - y0, 1) + 1);
  for (const i of act) qInsert(root, i, 0);
  qAccum(root);
  for (const i of act) qForce(root, N[i], i, a);
  for (const i of act) {
    const n = N[i];
    // Unlinked notes feel only gravity and repulsion, so they drift far out. Pull them harder,
    // which keeps them in a ring around the cluster the way Obsidian does.
    const gk = GRAVITY * a * (GS.ldeg && !GS.ldeg[i] ? 7 : 1);
    n.vx -= n.x * gk; n.vy -= n.y * gk;
    if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = n.vy = 0; }
    else { n.vx *= DECAY; n.vy *= DECAY; n.x += n.vx; n.y += n.vy; }
  }
  GS.alpha += (GS.alphaTarget - GS.alpha) * ALPHA_DECAY;
  if (GS.alpha < ALPHA_MIN && !GS.alphaTarget) GS.alpha = 0;
}

/* ---------- anatomy: Y up, +Z toward the face, roughly unit size ---------- */
/** A point on (r = 1) or inside (r < 1) the cerebrum, in direction (dx, dy, dz). The folds are a product of sines:
    no mesh, but enough relief that the dust reads as gyri. */
function cortex(dx, dy, dz, r) {
  const k = r * (1 + 0.045 * Math.sin(dx * 11 + 1.3) * Math.sin(dy * 9 + 0.4) * Math.sin(dz * 10 + 2.1) + 0.022 * Math.sin(dz * 23 + dy * 17 + dx * 5));
  let X = 0.7 * dx * (1 - 0.12 * Math.max(0, dz)) * k, Y = 0.62 * dy * (dy < 0 ? 0.6 : 1) * k;
  const Z = 0.92 * dz * k, ax = Math.abs(dx);
  X += (dx < 0 ? -1 : 1) * 0.045 * r;                       // the fissure between the hemispheres
  if (dy > 0 && ax < 0.2) Y *= 0.9 + 0.5 * ax;               // ...which dips along the top
  Y -= 0.16 * clamp((0.15 - dy) / 0.35, 0, 1) * clamp((ax - 0.35) / 0.4, 0, 1) * clamp((dz + 0.5) / 0.5, 0, 1) * k; // temporal lobes
  return [X, Y + 0.08, Z];
}
function rng(seed) {
  return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** The dust is decoration: a fixed, seeded cloud that gives the brain its shape however few notes there are. */
function gBuildDust() {
  const R = rng(7), M = matchMedia("(pointer: coarse)").matches ? 5000 : 9000;
  const D = { n: M, x: new Float32Array(M), y: new Float32Array(M), z: new Float32Array(M), kind: new Uint8Array(M),
    sx: new Float32Array(M), sy: new Float32Array(M), ps: new Float32Array(M), band: new Uint8Array(M), byCol: null };
  const dir = () => { const u = R() * 2 - 1, a = R() * TAU, s = Math.sqrt(1 - u * u); return [s * Math.cos(a), u, s * Math.sin(a)]; };
  for (let i = 0; i < M; i++) {
    const p = R();
    let P, kind = 0;
    if (p < 0.7) { const d = dir(); P = cortex(d[0], d[1], d[2], 0.94 + R() * 0.07); }
    else if (p < 0.82) { const d = dir(); P = cortex(d[0], d[1], d[2], 0.3 + R() * 0.58); kind = 1; }
    else if (p < 0.94) {
      // Cerebellum: two lobes tucked under the back, with fine horizontal folia.
      const d = dir(), side = d[0] < 0 ? -1 : 1, s = 0.93 + R() * 0.08;
      P = [d[0] * 0.25 * s + side * 0.17, -0.33 + d[1] * 0.19 * s * (1 + 0.08 * Math.sin(d[1] * 34)), -0.55 + d[2] * 0.25 * s];
      kind = 2;
    } else {
      const t = R(), a = R() * TAU, rr = (0.105 - 0.035 * t) * (0.75 + R() * 0.25);
      P = [Math.cos(a) * rr, -0.2 - 0.55 * t, -0.24 - 0.1 * t + Math.sin(a) * rr];
      kind = 3;
    }
    D.x[i] = P[0]; D.y[i] = P[1]; D.z[i] = P[2]; D.kind[i] = kind;
  }
  D.byCol = [[-1, Int32Array.from({ length: M }, (_, i) => i)]];
  return D;
}
/** Tint the cortex dust by the nearest note's group, so each folder lights up its own territory. */
function gColorDust() {
  const D = GS.dust || (GS.dust = gBuildDust()), N = GS.nodes, G = GS.groups.length;
  const pts = GS.act.filter((i) => !N[i].un && !Number.isNaN(N[i].X));
  const by = new Map();
  for (let i = 0; i < D.n; i++) {
    let c = -1;
    if (D.kind[i] < 2) {
      let bd = 0.11;
      const x = D.x[i], y = D.y[i], z = D.z[i];
      for (const j of pts) {
        const n = N[j], dx = n.X - x, dy = n.Y - y, dz = n.Z - z, d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; c = n.gi >= 0 ? n.gi : G; }
      }
    }
    let arr = by.get(c);
    if (!arr) by.set(c, (arr = []));
    arr.push(i);
  }
  D.byCol = [...by].map(([c, a]) => [c, Int32Array.from(a)]);
}
/** Fold the settled 2D layout over the cortex: its centre lands on the crown, its rim wraps down the sides. */
function gWrap() {
  const N = GS.nodes, act = GS.act;
  if (!act.length) return;
  let mx = 0, my = 0;
  for (const i of act) { mx += N[i].x; my += N[i].y; }
  mx /= act.length; my /= act.length;
  const d = act.map((i) => Math.hypot(N[i].x - mx, N[i].y - my));
  const sorted = Float64Array.from(d).sort();
  const R = sorted[Math.floor((sorted.length - 1) * 0.9)] || 1;
  act.forEach((i, j) => {
    const n = N[i];
    let r = d[j] / R;
    if (r > 0.85) r = 0.85 + 0.15 * Math.tanh((r - 0.85) / 0.15);
    const th = r * 1.95, ph = Math.atan2(n.y - my, n.x - mx), s = Math.sin(th);
    const depth = n.un ? 1.05 : 0.9 + 0.07 * (((n.ph * 1000) | 0) % 97) / 97;
    const [X, Y, Z] = cortex(s * Math.cos(ph), Math.cos(th), -s * Math.sin(ph), depth);
    if (Number.isNaN(n.X)) { n.X = X; n.Y = Y; n.Z = Z; }
    else { n.X += (X - n.X) * 0.25; n.Y += (Y - n.Y) * 0.25; n.Z += (Z - n.Z) * 0.25; }
  });
}

/* ---------- camera ---------- */
const PJ = { x: 0, y: 0, z: 0, p: 1 }, FOV = 3.4;
const gOy = () => 54 + (GS.h - 84) / 2;
function gCam(px = GS.px, py = GS.py) {
  return { cy: Math.cos(GS.yaw), sy: Math.sin(GS.yaw), cp: Math.cos(GS.pitch), sp: Math.sin(GS.pitch),
    s: Math.min(GS.w * 0.52, (GS.h - 84) * 0.62) * GS.zoom, ox: GS.w / 2 + px, oy: gOy() + py };
}
function gProj(C, X, Y, Z) {
  const x1 = X * C.cy + Z * C.sy, z1 = -X * C.sy + Z * C.cy;
  const y2 = Y * C.cp - z1 * C.sp, z2 = Y * C.sp + z1 * C.cp, p = FOV / (FOV + z2);
  PJ.x = C.ox + x1 * C.s * p; PJ.y = C.oy - (y2 + 0.04) * C.s * p; PJ.z = z2; PJ.p = p;
}
function gZoomAt(mx, my, ratio) {
  const z = clamp(GS.zoom * ratio, Z_MIN, Z_MAX), r = z / GS.zoom, ox = GS.w / 2 + GS.px, oy = gOy() + GS.py;
  GS.px = mx - (mx - ox) * r - GS.w / 2; GS.py = my - (my - oy) * r - gOy(); GS.zoom = z;
  gKick();
}
const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };

function gVisible() { return !document.hidden && GS.w > 0; }
function gKick() { GS.dirty = true; if (!GS.raf) GS.raf = requestAnimationFrame(gFrame); }
function gFrame(ts) {
  GS.raf = 0;
  if (!gVisible()) { GS.lastTs = 0; return; }
  ts = ts || performance.now();
  const dt = GS.lastTs ? Math.min(0.05, (ts - GS.lastTs) / 1000) : 0.016;
  GS.lastTs = ts;
  let moving = false;
  if (GS.alpha > 0 || GS.alphaTarget > 0) {
    // Ticks are cheap (~0.5 ms for 300 notes): burn through the hot start, then 3 per frame so it settles in ~2s.
    const t0 = performance.now();
    let n = 0;
    do { gTick(); n++; } while (GS.alpha > 0 && (GS.alpha > 0.25 || n < 3) && performance.now() - t0 < 12);
    moving = true; GS.wrapTail = 40;
  }
  if (GS.wrapTail > 0) {
    gWrap(); GS.wrapTail--; moving = true;
    // Recolouring is the one O(dust × notes) step, so it runs a couple of times a second while settling, then once.
    if (!GS.wrapTail || ts - GS.dustAt > 500) { gColorDust(); GS.dustAt = ts; }
  }
  if (GS.anim) { gAnimStep(dt); moving = true; }
  if (Math.abs(GS.vyaw) > 0.01 && !GS.interacting) { GS.yaw += GS.vyaw * dt; GS.vyaw *= Math.pow(0.05, dt); moving = true; }
  if (!RM && !GS.interacting && !GS.anim && !gSel() && GS.act.length && ts - GS.idleAt > 2500) { GS.yaw += dt * 0.14; moving = true; }
  const ambient = !RM && GS.act.length > 0;
  if (ambient) gAmbient(dt);
  if (moving || GS.dirty || (ambient && ts - GS.lastDraw > 30)) { gDraw(ts); GS.dirty = false; GS.lastDraw = ts; }
  if (moving || ambient) GS.raf = requestAnimationFrame(gFrame);
}
function gAnimStep(dt) {
  const A = GS.anim, n = A.node != null ? GS.nodes[A.node] : null, e = 1 - Math.pow(0.001, dt);
  let ty = A.yaw ?? GS.yaw, tp = A.pitch, tx = A.px, tyy = A.py;
  if (n && !Number.isNaN(n.X)) {
    // Turn the note to face the camera, then pan so it sits dead centre.
    ty = Math.atan2(n.X, -n.Z);
    tp = clamp(Math.atan(n.Y / Math.min(-0.05, -Math.hypot(n.X, n.Z))), -1.1, 0.8);
  }
  GS.yaw += angDiff(ty, GS.yaw) * e; GS.pitch += (tp - GS.pitch) * e; GS.zoom += (A.zoom - GS.zoom) * e;
  if (n && !Number.isNaN(n.X)) { gProj(gCam(0, 0), n.X, n.Y, n.Z); tx = GS.w / 2 - PJ.x; tyy = gOy() - PJ.y; }
  GS.px += (tx - GS.px) * e; GS.py += (tyy - GS.py) * e;
  if (Math.abs(angDiff(ty, GS.yaw)) < 0.002 && Math.abs(tp - GS.pitch) < 0.002 && Math.abs(A.zoom - GS.zoom) < 0.002 && Math.abs(tx - GS.px) < 0.5 && Math.abs(tyy - GS.py) < 0.5) GS.anim = null;
}

/* ---------- neural layer: signals travel along links and make the notes they reach flare ---------- */
const MAX_PARTS = 40;
function gPickSource() {
  const cum = GS.cum;
  if (!cum.length) return -1;
  const r = Math.random() * cum[cum.length - 1];
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
  return GS.cumNodes[lo];
}
function gSpark(i) { const th = gTheme(), n = GS.nodes[i]; return n.gi >= 0 ? th.spark[n.gi] : th.sparkOther; }
function gSpawn(from, avoid, hops) {
  const opts = GS.adjE[from];
  if (!opts || !opts.length) return;
  let pick = opts[(Math.random() * opts.length) | 0];
  if (opts.length > 1 && pick[0] === avoid) pick = opts[(Math.random() * opts.length) | 0];
  GS.parts.push({ a: from, b: pick[0], e: pick[1], u: 0, dur: 0.9 + Math.random() * 0.9, hops, spr: gSpark(from) });
}
function gAmbient(dt) {
  const N = GS.nodes;
  for (const i of GS.act) { const n = N[i]; if (n.fl > 0) n.fl = Math.max(0, n.fl - dt * 1.8); }
  if (GS.interacting) return;
  GS.spawnAcc += dt * (GS.alpha > 0.1 ? 1.5 : 6);
  while (GS.spawnAcc >= 1) {
    GS.spawnAcc -= 1;
    if (GS.parts.length < MAX_PARTS) { const s = gPickSource(); if (s >= 0) gSpawn(s, -1, 0); }
  }
  for (let j = GS.parts.length - 1; j >= 0; j--) {
    const p = GS.parts[j];
    p.u += dt / p.dur;
    if (p.u < 1) continue;
    GS.parts.splice(j, 1);
    if (N[p.b]) N[p.b].fl = Math.min(1.2, N[p.b].fl + 0.55);
    if (p.hops < 3 && Math.random() < 0.5 && GS.parts.length < MAX_PARTS) gSpawn(p.b, p.a, p.hops + 1);
  }
}
/** Selecting a note sends an activation wave out through its neighbours, depth 1 then 2. */
function gRipple(i) {
  const depth = new Map([[i, 0]]);
  let frontier = [i];
  for (let d = 1; d <= 2; d++) {
    const next = [];
    for (const a of frontier) for (const b of GS.adj[a]) if (GS.on && GS.on[b] && !depth.has(b)) { depth.set(b, d); next.push(b); }
    frontier = next;
  }
  GS.ripple = { i, t0: performance.now(), depth };
  const spr = gSpark(i);
  for (const [b, e] of (GS.adjE[i] || []).slice().sort(() => Math.random() - 0.5).slice(0, 14)) GS.parts.push({ a: i, b, e, u: 0, dur: 0.45 + Math.random() * 0.25, hops: 2, spr });
  if (GS.parts.length > 64) GS.parts.splice(0, GS.parts.length - 64);
}

function hexHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return null;
  const v = parseInt(m[1], 16), r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: d ? d / (1 - Math.abs(2 * l - 1)) : 0, l };
}
function glowSprite(h, s, l) {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 64;
  const x = cv.getContext("2d"), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  const col = (a) => `hsla(${h},${s}%,${l}%,${a})`;
  g.addColorStop(0, col(0.95)); g.addColorStop(0.16, col(0.6)); g.addColorStop(0.42, col(0.16)); g.addColorStop(1, col(0));
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  return cv;
}
/** The graph has its own dark surface in both themes, so Obsidian's pastel groups glow the way they do there. */
function gTheme() {
  if (GS.theme) return GS.theme;
  const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
  const tone = (hex) => { const c = hexHsl(hex) || { h: 38, s: 0.2, l: 0.7 }; return { h: Math.round(c.h), s: Math.round(clamp(c.s, 0.3, 0.5) * 100), l: Math.round(clamp(c.l, 0.62, 0.78) * 100) }; };
  const mk = (tn) => ({ fill: `hsl(${tn.h},${tn.s}%,${tn.l}%)`, core: `hsl(${tn.h},${tn.s}%,${Math.min(94, tn.l + 14)}%)`, spr: glowSprite(tn.h, tn.s, tn.l), spark: glowSprite(tn.h, Math.min(100, tn.s + 10), 88) });
  const gs = GS.groups.map((g) => mk(tone(g.color))), other = mk({ h: 38, s: 16, l: 70 });
  return (GS.theme = {
    text: v("--brain-ink"), faint: v("--brain-faint"), bg: v("--brain-bg"), ring: v("--brain-ink"), font: v("--font"), dust: "rgb(224,208,178)",
    edge: "rgba(226,200,152,.16)", edgeBack: "rgba(226,200,152,.05)", edgeDim: "rgba(226,200,152,.03)", edgeHi: "rgba(244,224,184,.75)",
    groups: gs.map((x) => x.fill), core: gs.map((x) => x.core), spr: gs.map((x) => x.spr), spark: gs.map((x) => x.spark),
    other: other.fill, coreOther: other.core, sprOther: other.spr, sparkOther: other.spark,
  });
}

const TAU = Math.PI * 2;
function rpAct(rp, i, rel) { const d = rp.depth.get(i); if (d === undefined) return 0; const x = rel - d * 0.3; return Math.exp(-(x * x) / 0.018) * (d ? 1 : 1.3); }
/** How much a point faces the camera: 1 on the near surface, 0 at the far side. */
const facing = (z) => clamp(0.5 - z / 1.8, 0, 1);
function gDraw(ts) {
  const c = GS.ctx, N = GS.nodes, th = gTheme(), dpr = GS.dpr, hl = GS.hl, sel = gSel(), E = GS.actEdges, G = GS.groups.length;
  if (!c) return;
  ts = ts || performance.now();
  const t = ts / 1000;
  let rp = RM ? null : GS.ripple;
  const rel = rp ? (ts - rp.t0) / 1000 : 0;
  if (rp && rel > 1.8) GS.ripple = rp = null;
  const C = gCam(), zf = Math.sqrt(GS.zoom) * clamp(C.s / GS.zoom / 260, 0.75, 1.5);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, GS.w, GS.h);
  // A faint inner light, so the cloud reads as a lit volume rather than points on black.
  gProj(C, 0, 0.12, 0);
  const halo = c.createRadialGradient(PJ.x, PJ.y, 0, PJ.x, PJ.y, C.s * 0.95);
  halo.addColorStop(0, "rgba(217,178,102,.10)"); halo.addColorStop(0.55, "rgba(170,125,60,.04)"); halo.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = halo; c.fillRect(0, 0, GS.w, GS.h);

  // Dust: batched by colour and four depth bands, so ~5k points cost a few dozen fills.
  const D = GS.dust || (GS.dust = gBuildDust());
  for (let i = 0; i < D.n; i++) {
    gProj(C, D.x[i], D.y[i], D.z[i]);
    D.sx[i] = PJ.x; D.sy[i] = PJ.y; D.ps[i] = PJ.p;
    D.band[i] = Math.max(0, Math.min(3, Math.floor(facing(PJ.z) * 4)) - (D.kind[i] === 1 ? 1 : 0));
  }
  c.globalCompositeOperation = "lighter";
  const dim = hl ? 0.4 : 1, ds = clamp(1.15 * zf, 0.9, 2.6), BAND = [0.1, 0.22, 0.42, 0.72];
  for (const [col, idx] of D.byCol) {
    c.fillStyle = col < 0 ? th.dust : col < G ? th.groups[col] : th.other;
    for (let band = 0; band < 4; band++) {
      c.globalAlpha = dim * BAND[band] * (col < 0 ? 0.75 : 1);
      c.beginPath();
      for (let j = 0; j < idx.length; j++) {
        const i = idx[j];
        if (D.band[i] !== band) continue;
        const sz = ds * D.ps[i];
        c.rect(D.sx[i] - sz / 2, D.sy[i] - sz / 2, sz, sz);
      }
      c.fill();
    }
  }

  for (const i of GS.act) {
    const n = N[i];
    if (Number.isNaN(n.X)) { n.sx = NaN; continue; }
    gProj(C, n.X, n.Y, n.Z);
    n.sx = PJ.x; n.sy = PJ.y; n.sz = PJ.z; n.sp = PJ.p; n.sr = Math.max(1.1, n.r * 0.27 * PJ.p * zf);
  }
  // Links arc inward through the white matter: the control point is pulled toward the brain's core.
  if (GS.ec.length < E.length * 3) GS.ec = new Float32Array(E.length * 3 + 32);
  const ec = GS.ec;
  for (let e = 0; e < E.length; e++) {
    const a = N[E[e][0]], b = N[E[e][1]];
    if (Number.isNaN(a.sx) || Number.isNaN(b.sx)) { ec[e * 3 + 2] = 2; continue; }
    const f = 1 - 0.42 * Math.min(1, Math.hypot(a.X - b.X, a.Y - b.Y, a.Z - b.Z) / 0.9);
    gProj(C, ((a.X + b.X) / 2) * f, ((a.Y + b.Y) / 2 - 0.08) * f + 0.08, ((a.Z + b.Z) / 2) * f);
    ec[e * 3] = PJ.x; ec[e * 3 + 1] = PJ.y; ec[e * 3 + 2] = a.sz + b.sz < 0 ? 1 : 0;
  }
  c.globalAlpha = 1; c.lineWidth = 0.75;
  for (const front of [0, 1]) {
    c.strokeStyle = hl ? th.edgeDim : front ? th.edge : th.edgeBack;
    c.beginPath();
    for (let e = 0; e < E.length; e++) {
      if (ec[e * 3 + 2] !== front) continue;
      const a = N[E[e][0]], b = N[E[e][1]];
      c.moveTo(a.sx, a.sy); c.quadraticCurveTo(ec[e * 3], ec[e * 3 + 1], b.sx, b.sy);
    }
    c.stroke();
  }
  const focus = sel && hl ? sel : GS.hover >= 0 ? N[GS.hover] : null;
  if (focus && GS.adjE[focus.i]) {
    c.strokeStyle = th.edgeHi; c.lineWidth = 1.2;
    c.beginPath();
    for (const [, e] of GS.adjE[focus.i]) {
      if (ec[e * 3 + 2] === 2) continue;
      const a = N[E[e][0]], b = N[E[e][1]];
      c.moveTo(a.sx, a.sy); c.quadraticCurveTo(ec[e * 3], ec[e * 3 + 1], b.sx, b.sy);
    }
    c.stroke();
  }
  // Glow is additive, so dense clusters brighten the way they do in a real neural map.
  for (const i of GS.act) {
    const n = N[i];
    if (n.un || Number.isNaN(n.sx)) continue;
    const f = n.fl + (rp ? rpAct(rp, i, rel) : 0);
    const br = RM ? 1 : 1 + n.amp * Math.sin(t * 1.7 + n.ph);
    const R = n.sr * 2.6 * br * (1 + Math.min(f, 1.5) * 0.7);
    c.globalAlpha = Math.min(1, (hl && !hl.has(i) ? 0.07 : 0.18 + 0.4 * facing(n.sz)) + f * 0.45);
    c.drawImage(n.gi >= 0 ? th.spr[n.gi] : th.sprOther, n.sx - R, n.sy - R, R * 2, R * 2);
  }
  for (const p of GS.parts) {
    const ed = E[p.e];
    if (!ed || ec[p.e * 3 + 2] === 2) continue;
    const a = N[ed[0]], b = N[ed[1]], qx = ec[p.e * 3], qy = ec[p.e * 3 + 1], fwd = p.a === ed[0];
    for (let m = 0; m < 3; m++) {
      let u = p.u - m * 0.055;
      if (u < 0) break;
      if (!fwd) u = 1 - u;
      const v = 1 - u, x = v * v * a.sx + 2 * v * u * qx + u * u * b.sx, y = v * v * a.sy + 2 * v * u * qy + u * u * b.sy;
      const sz = (5.5 - m * 1.6) * zf;
      c.globalAlpha = (hl ? 0.45 : 0.95) * (1 - m * 0.33);
      c.drawImage(p.spr, x - sz, y - sz, sz * 2, sz * 2);
    }
  }
  c.globalCompositeOperation = "source-over";
  // Cores back to front, so near notes cover far ones.
  GS.order = GS.act.filter((i) => !Number.isNaN(N[i].sx)).sort((i, j) => N[j].sz - N[i].sz);
  for (const i of GS.order) {
    const n = N[i], fc = facing(n.sz);
    const rr = n.sr * (RM ? 1 : 1 + n.amp * 0.6 * Math.sin(t * 1.7 + n.ph));
    c.globalAlpha = hl && !hl.has(i) ? 0.18 : 0.35 + 0.65 * fc;
    c.beginPath();
    c.arc(n.sx, n.sy, rr, 0, TAU);
    if (n.un) { c.lineWidth = 1; c.strokeStyle = th.faint; c.stroke(); }
    else { c.fillStyle = n.gi >= 0 ? th.core[n.gi] : th.coreOther; c.fill(); }
    if (sel === n || i === GS.hover) { c.globalAlpha = 1; c.lineWidth = 1.5; c.strokeStyle = th.ring; c.beginPath(); c.arc(n.sx, n.sy, rr + 4, 0, TAU); c.stroke(); }
  }
  if (rp && rel < 1.2 && N[rp.i] && !Number.isNaN(N[rp.i].sx)) {
    const n = N[rp.i];
    c.strokeStyle = th.ring; c.lineWidth = 1.4;
    for (const lag of [0, 0.22]) {
      const r2 = rel - lag;
      if (r2 <= 0) continue;
      c.globalAlpha = Math.max(0, 1 - r2) * 0.55;
      c.beginPath();
      c.arc(n.sx, n.sy, n.sr + r2 * 170 * zf, 0, TAU);
      c.stroke();
    }
  }
  // Labels: hubs on the near side, everything near once zoomed in, and whatever is selected or hovered.
  c.font = `500 11.5px ${th.font}`; c.textAlign = "center"; c.textBaseline = "top"; c.lineJoin = "round";
  const hubFade = clamp((GS.zoom - (GS.w < 640 ? 1.2 : 0.6)) / 0.4, 0, 1), allFade = clamp((GS.zoom - 1.6) / 0.6, 0, 1);
  for (const i of GS.order) {
    const n = N[i], near = clamp((facing(n.sz) - 0.62) / 0.2, 0, 1);
    // With names off, the graph is shape only: the hovered or selected note still says what it is.
    let a = !gNames ? 0 : hl ? (hl.has(i) ? Math.max(0.35, near) : 0) : near * (n.deg >= GS.hubDeg ? hubFade : allFade);
    if (i === GS.hover || n === sel) a = 1;
    if (a < 0.04) continue;
    const sx = n.sx, sy = n.sy + n.sr + 4;
    if (sx < -120 || sx > GS.w + 120 || sy < -20 || sy > GS.h + 4) continue;
    const label = n.title.length > 30 ? n.title.slice(0, 29) + "…" : n.title;
    c.globalAlpha = a * 0.92;
    c.lineWidth = 3; c.strokeStyle = th.bg; c.strokeText(label, sx, sy);
    c.fillStyle = n.un ? th.faint : th.text; c.fillText(label, sx, sy);
  }
  c.globalAlpha = 1;
}

function sizeGraph() {
  const wrap = $("#graph-wrap");
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5), w = wrap.clientWidth, h = wrap.clientHeight;
  if (w !== GS.w || h !== GS.h || dpr !== GS.dpr) {
    const cv = $("#graph");
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    GS.w = w; GS.h = h; GS.dpr = dpr; GS.ctx = cv.getContext("2d");
    gKick();
  }
}
window.addEventListener("resize", sizeGraph);
document.addEventListener("visibilitychange", () => { if (!document.hidden) gKick(); });

/** Nearest note under the pointer, preferring the one nearer the camera when they overlap. */
function gHit(sx, sy) {
  let best = -1, bd = Infinity;
  for (const i of GS.act) {
    const n = GS.nodes[i];
    if (Number.isNaN(n.sx)) continue;
    const d = Math.hypot(n.sx - sx, n.sy - sy);
    if (d < n.sr + 9) { const score = d + n.sz * 8; if (score < bd) { bd = score; best = i; } }
  }
  return best;
}
(function gPointers() {
  const cv = $("#graph"), P = new Map();
  let g = null, lastTap = { i: -2, t: 0 };
  const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const closeOverlays = () => { $("#g-sugg").hidden = true; if (document.activeElement === $("#g-find")) $("#g-find").blur(); };
  const touch = () => { GS.idleAt = performance.now(); };
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  cv.addEventListener("pointerdown", (e) => {
    try { cv.setPointerCapture(e.pointerId); } catch {}
    const p = pos(e); P.set(e.pointerId, p); GS.anim = null; GS.vyaw = 0; touch(); closeOverlays();
    const now = performance.now();
    if (P.size === 1) g = { kind: "one", sx: p.x, sy: p.y, lx: p.x, ly: p.y, lt: now, t: now, node: gHit(p.x, p.y), pan: e.shiftKey || e.button === 2, moved: false };
    else if (P.size === 2) {
      const [a, b] = [...P.values()];
      g = { kind: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, z0: GS.zoom, px0: GS.px, py0: GS.py };
    }
  });
  cv.addEventListener("pointermove", (e) => {
    const p = pos(e);
    if (!P.has(e.pointerId)) {
      if (e.pointerType === "mouse") { const h = gHit(p.x, p.y); if (h !== GS.hover) { GS.hover = h; cv.style.cursor = h >= 0 ? "pointer" : "grab"; gKick(); } }
      return;
    }
    P.set(e.pointerId, p);
    if (!g) return;
    touch();
    if (g.kind === "pinch" && P.size >= 2) {
      // Two fingers zoom about their midpoint and pan with it.
      const [a, b] = [...P.values()], mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      GS.zoom = g.z0; GS.px = g.px0; GS.py = g.py0;
      gZoomAt(g.mx, g.my, (Math.hypot(a.x - b.x, a.y - b.y) || 1) / g.d0);
      GS.px += mx - g.mx; GS.py += my - g.my;
      GS.interacting = true; gKick();
      return;
    }
    if (g.kind !== "one") return;
    if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) > 6) g.moved = true;
    if (!g.moved) return;
    GS.interacting = true;
    const ddx = p.x - g.lx, ddy = p.y - g.ly, now = performance.now();
    if (g.pan) { GS.px += ddx; GS.py += ddy; }
    else {
      GS.yaw += ddx * 0.0085;
      GS.pitch = clamp(GS.pitch + ddy * 0.006, -1.25, 1.25);
      GS.vyaw = clamp(((ddx * 0.0085) / Math.max(4, now - g.lt)) * 1000, -5, 5);
    }
    g.lx = p.x; g.ly = p.y; g.lt = now;
    gKick();
  });
  const end = (e, cancel) => {
    if (!P.has(e.pointerId)) return;
    P.delete(e.pointerId);
    if (!P.size) GS.interacting = false;
    touch();
    if (g && g.kind === "one") {
      // A flick keeps the brain turning; a drag that paused before letting go doesn't.
      if (!g.moved || g.pan || performance.now() - g.lt > 80) GS.vyaw = 0;
      if (!g.moved && !cancel && performance.now() - g.t < 600) tap(g.node);
      g = null;
    } else if (g && g.kind === "pinch" && P.size < 2) {
      const rest = [...P.values()][0];
      g = rest ? { kind: "one", sx: rest.x, sy: rest.y, lx: rest.x, ly: rest.y, lt: performance.now(), t: 0, node: -1, pan: true, moved: true } : null;
    }
    gKick();
  };
  const tap = (i) => {
    const t = performance.now();
    if (i >= 0 && lastTap.i === i && t - lastTap.t < 400) { lastTap = { i: -2, t: 0 }; gOpen(i); return; }
    lastTap = { i, t };
    gSelect(i);
  };
  cv.addEventListener("pointerup", (e) => end(e, false));
  cv.addEventListener("pointercancel", (e) => end(e, true));
  cv.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && GS.hover >= 0 && !P.size) { GS.hover = -1; gKick(); } });
  cv.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = pos(e);
    GS.anim = null; touch();
    gZoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
})();

function gSelect(i) {
  const prev = GS.selId;
  GS.selId = i >= 0 ? GS.nodes[i].id : null;
  if (GS.f.local && prev !== GS.selId) gApplyFilters(0.5, true); else gUpdateHl();
  gCard();
  if (!$("#g-panel").hidden) gPanel();
  if (i >= 0 && !RM) gRipple(i);
  gKick();
}
function gOpen(i) {
  const n = GS.nodes[i];
  if (!n) return;
  if (n.un) { toast(`“${n.title}” doesn't exist yet`); return; }
  const href = noteHref(n.id);
  if (href) location.href = href;
}
function gFocusId(id, local) {
  const n = GS.byId.get(id);
  if (!n) return;
  GS.selId = id;
  if (local) GS.f.local = true;
  gApplyFilters(0.5);
  gCard();
  gCenterOn(n);
}
/** Turn the brain until the note faces you, and lean in. */
function gCenterOn(n) {
  GS.anim = { node: n.i, zoom: Math.max(GS.zoom, 1.35) };
  GS.vyaw = 0;
  gKick();
}
function gCard() {
  const el = $("#g-card"), n = gSel();
  if (!n) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span class="sw" style="background:${n.un ? "transparent;border:1.5px solid var(--text-3)" : esc(n.gi >= 0 ? gTheme().groups[n.gi] : gTheme().other)}"></span>
    <div style="flex:1;min-width:0"><div class="t ellipsis">${esc(n.title)}</div><div class="faint ellipsis" style="font-size:var(--fs-sec, 12.5px)">${n.un ? "Not created yet" : esc(n.id.split("/").slice(0, -1).join(" / ") || "Vault root")}, ${plural(GS.adj[n.i].length, "link")}</div></div>
    <button class="g-btn" id="g-local" aria-pressed="${GS.f.local}" aria-label="Local graph" title="Local graph">${ICO.local}</button>
    ${n.un || !noteHref(n.id) ? "" : `<a class="btn primary small" href="${esc(noteHref(n.id))}">Open</a>`}`;
  $("#g-local").onclick = () => { GS.f.local = !GS.f.local; gApplyFilters(0.6, true); gCard(); if (!$("#g-panel").hidden) gPanel(); };
}
function gPanel() {
  const el = $("#g-panel"), th = gTheme(), sel = gSel();
  const groups = [...GS.groups.map((g, i) => ({ name: g.name, color: th.groups[i] })), { name: "Other", color: th.other }];
  el.innerHTML = `<div class="g-sub">Show groups</div><div class="g-chips">${groups.map((g) => `<button class="g-chip" data-g="${esc(g.name)}" aria-pressed="${!GS.f.off.has(g.name)}"><span class="sw" style="background:${esc(g.color)}"></span><span class="lbl">${esc(g.name)}</span></button>`).join("")}</div>
    <label class="g-row"><span>Unresolved links</span><input type="checkbox" id="g-unres" ${GS.f.unresolved ? "checked" : ""}></label>
    <label class="g-row"><span>Orphans</span><input type="checkbox" id="g-orph" ${GS.f.orphans ? "checked" : ""}></label>
    <label class="g-row"><span>Local graph ${sel ? `<span class="faint">around ${esc(sel.title.slice(0, 22))}</span>` : `<span class="faint">select a note first</span>`}</span><input type="checkbox" id="g-loc" ${GS.f.local ? "checked" : ""} ${sel ? "" : "disabled"}></label>
    <label class="g-row"><span>Local depth <b>${GS.f.depth}</b></span><input type="range" id="g-depth" min="1" max="3" step="1" value="${GS.f.depth}"></label>`;
  for (const b of $$("[data-g]", el)) b.onclick = () => {
    const name = b.dataset.g;
    GS.f.off.has(name) ? GS.f.off.delete(name) : GS.f.off.add(name);
    store.set("brain-graph.Off", [...GS.f.off]); gApplyFilters(0.4, true); gPanel();
  };
  $("#g-unres").onchange = (e) => { GS.f.unresolved = e.target.checked; store.set("brain-graph.Unres", GS.f.unresolved); gApplyFilters(0.4, true); };
  $("#g-orph").onchange = (e) => { GS.f.orphans = e.target.checked; store.set("brain-graph.Orphans", GS.f.orphans); gApplyFilters(0.4, true); };
  $("#g-loc").onchange = (e) => { GS.f.local = e.target.checked; gApplyFilters(0.6, true); gCard(); };
  $("#g-depth").oninput = (e) => { GS.f.depth = +e.target.value; store.set("brain-graph.Depth", GS.f.depth); e.target.previousElementSibling.querySelector("b").textContent = GS.f.depth; if (GS.f.local) gApplyFilters(0.5, true); };
}
let gNames = store.get("brain-graph.Names", true);
const gNamesBtn = () => $("#g-names").setAttribute("aria-pressed", String(gNames));
gNamesBtn();
$("#g-names").onclick = () => { gNames = !gNames; store.set("brain-graph.Names", gNames); gNamesBtn(); gKick(); };
$("#g-filter-btn").onclick = () => {
  const p = $("#g-panel"), open = p.hidden;
  p.hidden = !open; $("#g-filter-btn").setAttribute("aria-pressed", String(open));
  if (open) { $("#g-sugg").hidden = true; gPanel(); }
};
$("#g-fit").onclick = () => { GS.anim = { yaw: null, pitch: 0.18, zoom: 1, px: 0, py: 0 }; GS.vyaw = 0; GS.idleAt = 0; gKick(); };
(function gFind() {
  const input = $("#g-find"), box = $("#g-sugg");
  let items = [];
  const pick = (n) => { box.hidden = true; input.value = ""; input.blur(); gFocusId(n.id, false); };
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q || !GS.nodes.length) { box.hidden = true; return; }
    items = GS.nodes.filter((n) => n.title.toLowerCase().includes(q))
      .sort((a, b) => (b.title.toLowerCase().startsWith(q) - a.title.toLowerCase().startsWith(q)) || (a.un - b.un) || b.deg - a.deg).slice(0, 8);
    const th = gTheme();
    box.innerHTML = items.length ? items.map((n, i) => `<button data-i="${i}"><span class="sw" style="background:${n.un ? "transparent;border:1.5px solid var(--text-3)" : esc(n.gi >= 0 ? th.groups[n.gi] : th.other)}"></span><span class="grow ellipsis">${hilite(n.title, q)}</span><span class="cnt">${esc(n.un ? "unresolved" : n.folder)}</span></button>`).join("") : `<div class="empty" style="padding:10px">No note called that.</div>`;
    box.hidden = false; $("#g-panel").hidden = true; $("#g-filter-btn").setAttribute("aria-pressed", "false");
    for (const b of $$("button", box)) b.onclick = () => pick(items[+b.dataset.i]);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && items[0] && !box.hidden) { e.preventDefault(); pick(items[0]); }
    if (e.key === "Escape") { box.hidden = true; input.blur(); }
  });
})();

if (window.BRAIN.anonymous) { gNames = false; $("#g-names").hidden = true; $("#g-find").hidden = true; }
gNamesBtn();
sizeGraph();
gSetData(window.BRAIN);
