/* =========================================================
   QuitaFondosGif
   ========================================================= */

(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  const cv = $('cv');
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const wrap = $('wrap');
  const viewport = $('viewport');
  const cursorEl = $('brushcur');

  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d');


  /* =========================================================
     Estado
     ========================================================= */

  const S = {
    W: 0,
    H: 0,
    frames: [],
    cur: 0,
    playing: false,
    loaded: false,

    keys: [],
    tol: 48,
    soft: 16,
    mode: 'global',

    tool: 'erase',
    brush: 30,
    target: 'frame',

    sel: new Set(),
    markKey: null,
    clip: null,

    zoom: 1,
    viewBg: 'checker',
    expBg: 'alpha',

    keyCache: [],
    per: [],
    globalMask: null,
    out: null,

    overlays: [],
    ovSel: null,

    undo: [],
    redo: [],
    undoBytes: 0
  };

  const stroke = { active: false, mask: null, last: null };

  let thumbEls = [];
  let lastClicked = 0;
  let panning = null;
  let spaceDown = false;
  let dragOv = null;
  let dragDepth = 0;
  let playTimer = null;
  let thumbTimer = null;
  let tolTimer = null;
  let rafPending = false;


  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.className = '', 3200);
  }


  /* =========================================================
     Tema claro y oscuro
     ========================================================= */

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;

    $('themeIcon').innerHTML = theme === 'dark'
      ? '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>'
      : '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.2 12H2M22 12h-2.2M6.4 6.4 4.9 4.9M19.1 19.1l-1.5-1.5M17.6 6.4l1.5-1.5M4.9 19.1l1.5-1.5"/>';
  }

  $('btnTheme').onclick = () => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  };


  /* =========================================================
     Ventana de ayuda
     ========================================================= */

  function showHelp(on) {
    $('help').classList.toggle('on', on);
  }

  $('btnHelp').onclick = () => showHelp(true);
  $('helpOk').onclick = () => showHelp(false);
  $('help').onclick = e => { if (e.target.id === 'help') showHelp(false); };


  /* =========================================================
     Máscaras
     ========================================================= */

  function newMask() {
    const c = document.createElement('canvas');
    c.width = S.W;
    c.height = S.H;

    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.lineCap = cx.lineJoin = 'round';
    cx.strokeStyle = '#fff';
    cx.fillStyle = '#fff';

    return { cv: c, cx, arr: new Uint8Array(S.W * S.H) };
  }

  function readMask(m, x0, y0, w, h) {
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    w = Math.min(S.W - x0, Math.ceil(w));
    h = Math.min(S.H - y0, Math.ceil(h));
    if (w <= 0 || h <= 0) return;

    const d = m.cx.getImageData(x0, y0, w, h).data;

    for (let y = 0; y < h; y++) {
      let s = (y * w) * 4 + 3;
      let t = (y0 + y) * S.W + x0;
      for (let x = 0; x < w; x++, s += 4, t++) m.arr[t] = d[s];
    }
  }

  function clearMask(m) {
    m.cx.clearRect(0, 0, S.W, S.H);
    m.arr.fill(0);
  }

  function putAlpha(m, arr) {
    const img = m.cx.createImageData(S.W, S.H);
    const d = img.data;

    for (let i = 0, o = 0; i < arr.length; i++, o += 4) {
      d[o] = d[o + 1] = d[o + 2] = 255;
      d[o + 3] = arr[i];
    }

    m.cx.putImageData(img, 0, 0);
    m.arr.set(arr);
  }

  function hasInk(a) {
    for (let i = 0; i < a.length; i++) if (a[i]) return true;
    return false;
  }

  function pf(i) {
    let o = S.per[i];
    if (!o) o = S.per[i] = { erase: newMask(), keep: newMask(), dirty: false };
    return o;
  }

  function selection() {
    return S.sel.size ? [...S.sel].sort((a, b) => a - b) : [S.cur];
  }

  function targetFrames() {
    if (S.target === 'all') return ['all'];
    if (S.target === 'sel') return selection();
    return [S.cur];
  }

  function maskPair(t) {
    if (t === 'all') return S.globalMask;
    const o = pf(t);
    return { erase: o.erase, keep: o.keep };
  }


  /* =========================================================
     Historial
     ========================================================= */

  function pushUndo(list) {
    const snaps = list.map(t => {
      const m = maskPair(t);
      return { t, erase: new Uint8Array(m.erase.arr), keep: new Uint8Array(m.keep.arr) };
    });

    const bytes = snaps.length * S.W * S.H * 2;
    S.undo.push({ snaps, bytes });
    S.undoBytes += bytes;

    while (S.undoBytes > 80e6 && S.undo.length > 1) {
      S.undoBytes -= S.undo.shift().bytes;
    }

    S.redo.length = 0;
    updateButtons();
  }

  function applySnaps(entry) {
    const inverse = entry.snaps.map(s => {
      const m = maskPair(s.t);
      return { t: s.t, erase: new Uint8Array(m.erase.arr), keep: new Uint8Array(m.keep.arr) };
    });

    entry.snaps.forEach(s => {
      const m = maskPair(s.t);
      putAlpha(m.erase, s.erase);
      putAlpha(m.keep, s.keep);
      if (s.t !== 'all') S.per[s.t].dirty = hasInk(s.erase) || hasInk(s.keep);
    });

    return { snaps: inverse, bytes: entry.bytes };
  }

  function updateButtons() {
    $('btnUndo').disabled = !S.undo.length;
    $('btnRedo').disabled = !S.redo.length;
    $('btnPaste').disabled = !S.clip;
  }


  /* =========================================================
     Fondo por color
     ========================================================= */

  function invalidateKeys() {
    S.keyCache = new Array(S.frames.length).fill(null);
    scheduleRender();
    scheduleThumbs();
  }

  function activeKeys(f) {
    const r = [];

    for (const k of S.keys) {
      if (k.scope === 'all') r.push(k);
      else if (k.scope === 'auto') { if (k.present[f]) r.push(k); }
      else if (k.frames.has(f)) r.push(k);
    }

    return r;
  }

  function computePresence(k) {
    const n = S.W * S.H;
    const thr = Math.max(8, Math.round(n * 0.0004));
    const t2 = S.tol * S.tol;

    k.present = new Uint8Array(S.frames.length);

    for (let f = 0; f < S.frames.length; f++) {
      const s = S.frames[f].data;
      let c = 0;

      for (let i = 0; i < n; i++) {
        const o = i << 2;
        if (s[o + 3] === 0) continue;

        const dr = s[o] - k.rgb[0];
        const dg = s[o + 1] - k.rgb[1];
        const db = s[o + 2] - k.rgb[2];

        if (dr * dr + dg * dg + db * db <= t2) c++;
      }

      k.present[f] = c >= thr ? 1 : 0;
    }
  }

  function recomputeAllPresence() {
    S.keys.forEach(computePresence);
    drawKeys();
  }

  function getKeyAlpha(f) {
    if (S.keyCache[f]) return S.keyCache[f];

    const n = S.W * S.H;
    const src = S.frames[f].data;
    const a = new Uint8Array(n);
    const K = activeKeys(f).map(k => k.rgb);

    if (!K.length) {
      a.fill(255);
      S.keyCache[f] = a;
      return a;
    }

    const tol = S.tol;
    const soft = S.soft;

    const dist = i => {
      const o = i << 2;
      let best = 1e9;

      for (let k = 0; k < K.length; k++) {
        const dr = src[o] - K[k][0];
        const dg = src[o + 1] - K[k][1];
        const db = src[o + 2] - K[k][2];
        const d2 = dr * dr + dg * dg + db * db;
        if (d2 < best) best = d2;
      }

      return Math.sqrt(best);
    };

    const ramp = d => d <= tol
      ? 0
      : (soft <= 0 || d >= tol + soft ? 255 : ((d - tol) / soft) * 255);

    if (S.mode === 'global') {

      for (let i = 0; i < n; i++) {
        a[i] = src[(i << 2) + 3] === 0 ? 0 : ramp(dist(i));
      }

    } else {

      // relleno desde los bordes hacia adentro
      const bg = new Uint8Array(n);
      const stack = new Int32Array(n);
      let sp = 0;

      const push = i => {
        if (bg[i]) return;
        const o = i << 2;
        if (src[o + 3] === 0 || dist(i) <= tol) {
          bg[i] = 1;
          stack[sp++] = i;
        }
      };

      for (let x = 0; x < S.W; x++) { push(x); push((S.H - 1) * S.W + x); }
      for (let y = 0; y < S.H; y++) { push(y * S.W); push(y * S.W + S.W - 1); }

      while (sp > 0) {
        const i = stack[--sp];
        const x = i % S.W;
        const y = (i / S.W) | 0;

        if (x > 0) push(i - 1);
        if (x < S.W - 1) push(i + 1);
        if (y > 0) push(i - S.W);
        if (y < S.H - 1) push(i + S.W);
      }

      for (let i = 0; i < n; i++) a[i] = bg[i] ? 0 : 255;

      // suavizado solo en el contorno del relleno
      if (soft > 0) {
        for (let y = 0; y < S.H; y++) {
          for (let x = 0; x < S.W; x++) {
            const i = y * S.W + x;
            if (bg[i]) continue;

            const touches =
              (x > 0 && bg[i - 1]) ||
              (x < S.W - 1 && bg[i + 1]) ||
              (y > 0 && bg[i - S.W]) ||
              (y < S.H - 1 && bg[i + S.W]);

            if (touches) a[i] = ramp(dist(i));
          }
        }
      }
    }

    S.keyCache[f] = a;
    return a;
  }

  function addKey(rgb) {
    const k = {
      rgb,
      scope: 'auto',
      frames: new Set(),
      present: new Uint8Array(S.frames.length)
    };

    computePresence(k);
    if (S.frames.length === 1) k.scope = 'all';

    S.keys.push(k);
    drawKeys();
    invalidateKeys();
    markThumbState();
  }

  function drawKeys() {
    const box = $('keys');
    box.innerHTML = '';

    S.keys.forEach((k, i) => {
      const row = document.createElement('div');
      row.className = 'keyrow';

      const sw = document.createElement('button');
      sw.className = 'sw';
      sw.style.background = 'rgb(' + k.rgb.join(',') + ')';
      sw.title = 'Ver en qué cuadros aparece';
      sw.onclick = () => {
        S.markKey = (S.markKey === k ? null : k);
        updateMarkMsg();
        markThumbState();
      };

      const body = document.createElement('div');
      body.className = 'kbody';

      const info = document.createElement('div');
      info.className = 'kinfo';
      const n = k.present.reduce((a, b) => a + b, 0);
      const chosen = k.scope === 'pick'
        ? k.frames.size
        : (k.scope === 'all' ? S.frames.length : n);
      info.innerHTML = 'aparece en <b>' + n + '</b> de ' + S.frames.length + ' · se borra en ' + chosen;

      const sel = document.createElement('select');
      sel.innerHTML =
        '<option value="auto">Solo donde aparece</option>' +
        '<option value="all">En todos los cuadros</option>' +
        '<option value="pick">Cuadros que yo elija</option>';
      sel.value = k.scope;
      sel.onchange = () => {
        k.scope = sel.value;

        if (k.scope === 'pick') {
          if (!k.frames.size) {
            for (let f = 0; f < S.frames.length; f++) if (k.present[f]) k.frames.add(f);
          }
          S.markKey = k;
        }

        updateMarkMsg();
        drawKeys();
        invalidateKeys();
        markThumbState();
      };

      body.append(info, sel);

      const x = document.createElement('button');
      x.className = 'kx';
      x.textContent = '×';
      x.title = 'Quitar el color';
      x.onclick = () => {
        if (S.markKey === k) S.markKey = null;
        S.keys.splice(i, 1);
        drawKeys();
        invalidateKeys();
        updateMarkMsg();
        markThumbState();
      };

      row.append(sw, body, x);
      box.appendChild(row);
    });

    $('noKeys').style.display = S.keys.length ? 'none' : 'block';
  }

  function updateMarkMsg() {
    const k = S.markKey;

    $('markMsg').textContent = k
      ? (k.scope === 'pick'
        ? 'Elegí en qué cuadros se borra este color (clic en las miniaturas)'
        : 'Mostrando dónde aparece ese color')
      : '';
  }

  function autoPickKey() {
    const src = S.frames[0].data;
    const tally = new Map();

    const add = i => {
      const o = i << 2;
      if (src[o + 3] < 250) return;
      const k = (src[o] >> 3 << 10) | (src[o + 1] >> 3 << 5) | (src[o + 2] >> 3);
      tally.set(k, (tally.get(k) || 0) + 1);
    };

    for (let x = 0; x < S.W; x++) { add(x); add((S.H - 1) * S.W + x); }
    for (let y = 0; y < S.H; y++) { add(y * S.W); add(y * S.W + S.W - 1); }

    let best = -1;
    let bc = 0;
    tally.forEach((v, k) => { if (v > bc) { bc = v; best = k; } });

    if (best >= 0 && bc > 2 * (S.W + S.H) * 0.3) {
      addKey([
        ((best >> 10) & 31) * 8 + 4,
        ((best >> 5) & 31) * 8 + 4,
        (best & 31) * 8 + 4
      ]);
    }
  }


  /* =========================================================
     Composición y dibujo
     ========================================================= */

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  }

  function composite(f, out, preview) {
    const src = S.frames[f].data;
    const key = getKeyAlpha(f);
    const n = S.W * S.H;

    const g = S.globalMask;
    const own = S.per[f];

    const eG = g.erase.arr;
    const kG = g.keep.arr;
    const eF = own ? own.erase.arr : null;
    const kF = own ? own.keep.arr : null;

    const st = preview ? stroke.mask.arr : null;
    const stTool = preview ? S.tool : null;

    for (let i = 0; i < n; i++) {
      const o = i << 2;

      out[o] = src[o];
      out[o + 1] = src[o + 1];
      out[o + 2] = src[o + 2];

      let a = src[o + 3];

      if (a) {
        let keep = kG[i];
        if (kF && kF[i] > keep) keep = kF[i];

        let er = eG[i];
        if (eF && eF[i] > er) er = eF[i];

        if (st) {
          const v = st[i];
          if (v) {
            if (stTool === 'erase') {
              if (v > er) er = v;
            } else {
              if (v > keep) keep = v;
              er = er * (255 - v) / 255;
            }
          }
        }

        if (keep < 255) a = a * (keep + (255 - keep) * key[i] / 255) / 255;
        if (er) a = a * (255 - er) / 255;
      }

      out[o + 3] = a;
    }
  }

  function ovVisible(ov, f) {
    return ov.scope === 'all' || ov.frames.has(f);
  }

  function drawOverlays(c, f) {
    for (const ov of S.overlays) {
      if (!ovVisible(ov, f)) continue;

      c.save();
      c.globalAlpha = ov.op;
      c.translate(ov.x, ov.y);
      c.rotate(ov.rot * Math.PI / 180);
      c.scale(ov.scale, ov.scale);
      c.drawImage(ov.img, -ov.img.width / 2, -ov.img.height / 2);
      c.restore();
    }
  }

  function render() {
    if (!S.loaded) return;

    composite(S.cur, S.out.data, !!stroke.active && strokeAffectsCurrent());
    ctx.putImageData(S.out, 0, 0);
    drawOverlays(ctx, S.cur);

    const ov = S.ovSel;
    if (ov && S.tool === 'move' && ovVisible(ov, S.cur)) {
      const w = 2 / (ov.scale * S.zoom);

      ctx.save();
      ctx.translate(ov.x, ov.y);
      ctx.rotate(ov.rot * Math.PI / 180);
      ctx.scale(ov.scale, ov.scale);
      ctx.strokeStyle = 'rgba(61,220,132,.95)';
      ctx.lineWidth = w;
      ctx.setLineDash([w * 3, w * 2]);
      ctx.strokeRect(-ov.img.width / 2, -ov.img.height / 2, ov.img.width, ov.img.height);
      ctx.restore();
    }

    $('counter').textContent = (S.cur + 1) + ' / ' + S.frames.length;
    $('frameRange').value = S.cur;
    markThumbState();
  }

  function frameCanvas(f) {
    const img = new ImageData(S.W, S.H);
    composite(f, img.data, false);

    const c = document.createElement('canvas');
    c.width = S.W;
    c.height = S.H;

    const x = c.getContext('2d');
    x.putImageData(img, 0, 0);
    drawOverlays(x, f);

    return c;
  }


  /* =========================================================
     Tira de cuadros
     ========================================================= */

  function buildStrip() {
    const box = $('thumbs');
    box.innerHTML = '';
    thumbEls = [];

    const tw = Math.min(120, Math.max(1, Math.round(52 * S.W / S.H)));

    for (let f = 0; f < S.frames.length; f++) {
      const b = document.createElement('button');
      b.className = 'th';
      b.dataset.f = f;

      const c = document.createElement('canvas');
      c.width = tw;
      c.height = 52;
      b.appendChild(c);

      const bar = document.createElement('span');
      bar.className = 'kbar';
      b.appendChild(bar);

      const dot = document.createElement('span');
      dot.className = 'dot';
      b.appendChild(dot);

      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = f + 1;
      b.appendChild(n);

      b.onclick = e => onThumbClick(f, e);
      box.appendChild(b);

      thumbEls.push({ el: b, cx: c.getContext('2d'), w: tw, h: 52 });
    }

    $('strip').style.display = 'flex';
    drawThumbs();
    markThumbState();
  }

  function drawThumb(f) {
    const t = thumbEls[f];
    if (!t) return;

    const img = new ImageData(S.W, S.H);
    composite(f, img.data, false);

    scratch.width = S.W;
    scratch.height = S.H;
    sctx.clearRect(0, 0, S.W, S.H);
    sctx.putImageData(img, 0, 0);
    drawOverlays(sctx, f);

    t.cx.clearRect(0, 0, t.w, t.h);
    t.cx.drawImage(scratch, 0, 0, t.w, t.h);
  }

  function drawThumbs() {
    for (let f = 0; f < S.frames.length; f++) drawThumb(f);
  }

  function scheduleThumbs(all) {
    if (!S.loaded || !thumbEls.length) return;
    if (!all) drawThumb(S.cur);

    clearTimeout(thumbTimer);
    thumbTimer = setTimeout(drawThumbs, 260);
  }

  function markThumbState() {
    const mk = S.markKey;

    for (let f = 0; f < thumbEls.length; f++) {
      const e = thumbEls[f].el;

      e.classList.toggle('cur', f === S.cur);
      e.classList.toggle('sel', S.sel.has(f));
      e.classList.toggle('dirty', !!(S.per[f] && S.per[f].dirty));

      if (mk) {
        const on = mk.scope === 'pick'
          ? mk.frames.has(f)
          : (mk.scope === 'all' || mk.present[f]);

        e.classList.toggle('haskey', !!mk.present[f]);
        e.classList.toggle('marked', !!on);
        e.querySelector('.kbar').style.background = 'rgb(' + mk.rgb.join(',') + ')';
      } else {
        e.classList.remove('haskey');
        e.classList.remove('marked');
      }
    }
  }

  function onThumbClick(f, e) {
    if (S.markKey && S.markKey.scope === 'pick') {
      const s = S.markKey.frames;
      if (s.has(f)) s.delete(f); else s.add(f);

      invalidateKeys();
      drawKeys();
      markThumbState();
      return;
    }

    if (e.shiftKey) {
      const a = Math.min(lastClicked, f);
      const b = Math.max(lastClicked, f);
      for (let i = a; i <= b; i++) S.sel.add(i);

    } else if (e.ctrlKey || e.metaKey) {
      if (S.sel.has(f)) S.sel.delete(f); else S.sel.add(f);
      lastClicked = f;

    } else {
      S.sel = new Set([f]);
      lastClicked = f;
    }

    goto(f);
    updateButtons();
  }

  $('selAll').onclick = () => {
    S.sel = new Set(S.frames.map((_, i) => i));
    markThumbState();
    updateButtons();
  };

  $('selNone').onclick = () => {
    S.sel = new Set();
    markThumbState();
    updateButtons();
  };

  $('selInv').onclick = () => {
    const n = new Set();
    S.frames.forEach((_, i) => { if (!S.sel.has(i)) n.add(i); });
    S.sel = n;
    markThumbState();
    updateButtons();
  };


  /* =========================================================
     Pincel
     ========================================================= */

  function strokeAffectsCurrent() {
    if (S.target === 'all' || S.target === 'frame') return true;
    return selection().includes(S.cur);
  }

  function evtToImg(e) {
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) / S.zoom, y: (e.clientY - r.top) / S.zoom };
  }

  function beginStroke(p) {
    if (!stroke.mask) stroke.mask = newMask();
    clearMask(stroke.mask);

    stroke.active = true;
    stroke.last = p;
    paintSegment(p, p);
  }

  function paintSegment(a, b) {
    const m = stroke.mask;
    const r = S.brush / 2;

    m.cx.globalCompositeOperation = 'source-over';
    m.cx.lineWidth = S.brush;
    m.cx.beginPath();
    m.cx.moveTo(a.x, a.y);
    m.cx.lineTo(b.x, b.y);
    m.cx.stroke();

    readMask(
      m,
      Math.min(a.x, b.x) - r - 2,
      Math.min(a.y, b.y) - r - 2,
      Math.abs(a.x - b.x) + S.brush + 4,
      Math.abs(a.y - b.y) + S.brush + 4
    );

    scheduleRender();
  }

  function endStrokeCommit() {
    if (!stroke.active) return;
    stroke.active = false;

    const list = targetFrames();
    pushUndo(list);

    for (const t of list) {
      const m = maskPair(t);

      if (S.tool === 'erase') {
        m.erase.cx.globalCompositeOperation = 'source-over';
        m.erase.cx.drawImage(stroke.mask.cv, 0, 0);
        readMask(m.erase, 0, 0, S.W, S.H);

      } else {
        m.keep.cx.globalCompositeOperation = 'source-over';
        m.keep.cx.drawImage(stroke.mask.cv, 0, 0);
        readMask(m.keep, 0, 0, S.W, S.H);

        m.erase.cx.globalCompositeOperation = 'destination-out';
        m.erase.cx.drawImage(stroke.mask.cv, 0, 0);
        m.erase.cx.globalCompositeOperation = 'source-over';
        readMask(m.erase, 0, 0, S.W, S.H);
      }

      if (t !== 'all') S.per[t].dirty = true;
    }

    clearMask(stroke.mask);
    scheduleRender();
    scheduleThumbs(true);
    markThumbState();

    if (list.length > 1 && list[0] !== 'all') toast('Pintado en ' + list.length + ' cuadros.');
  }


  /* =========================================================
     Imágenes encima
     ========================================================= */

  function overlayAt(p) {
    for (let i = S.overlays.length - 1; i >= 0; i--) {
      const ov = S.overlays[i];
      if (!ovVisible(ov, S.cur)) continue;

      const dx = p.x - ov.x;
      const dy = p.y - ov.y;
      const a = -ov.rot * Math.PI / 180;

      const lx = (dx * Math.cos(a) - dy * Math.sin(a)) / ov.scale;
      const ly = (dx * Math.sin(a) + dy * Math.cos(a)) / ov.scale;

      if (Math.abs(lx) <= ov.img.width / 2 && Math.abs(ly) <= ov.img.height / 2) return ov;
    }

    return null;
  }

  async function addOverlay(file) {
    const img = await createImageBitmap(file);
    const fit = Math.min(1, (S.W * 0.6) / img.width, (S.H * 0.6) / img.height);

    const ov = {
      img,
      name: file.name,
      x: S.W / 2,
      y: S.H / 2,
      scale: fit,
      rot: 0,
      op: 1,
      scope: 'all',
      frames: new Set(selection()),
      thumb: null
    };

    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const cx = c.getContext('2d');
    const s = Math.min(64 / img.width, 64 / img.height);
    cx.drawImage(img, (64 - img.width * s) / 2, (64 - img.height * s) / 2, img.width * s, img.height * s);
    ov.thumb = c.toDataURL();

    S.overlays.push(ov);
    S.ovSel = ov;

    setTool('move');
    drawOvs();
    scheduleRender();
    scheduleThumbs(true);
    toast('Imagen apoyada encima. Arrastrala para acomodarla.');
  }

  function drawOvs() {
    const box = $('ovs');
    box.innerHTML = '';

    S.overlays.forEach(ov => {
      const row = document.createElement('div');
      row.className = 'ovrow' + (ov === S.ovSel ? ' on' : '');

      const im = document.createElement('img');
      im.className = 'ovthumb';
      im.src = ov.thumb;
      im.alt = '';
      im.onclick = () => {
        S.ovSel = ov;
        setTool('move');
        drawOvs();
        scheduleRender();
      };

      const body = document.createElement('div');
      body.className = 'ovbody';

      const nm = document.createElement('div');
      nm.className = 'ovname';
      nm.textContent = ov.name;

      const st = document.createElement('div');
      st.className = 'kinfo';
      st.textContent = ov.scope === 'all'
        ? 'en todos los cuadros'
        : 'en ' + ov.frames.size + ' cuadros';

      body.append(nm, st);
      row.append(im, body);
      box.appendChild(row);
    });

    $('secOvs').hidden = !S.overlays.length;

    const ov = S.ovSel;
    $('ovCtl').hidden = !ov;

    if (ov) {
      $('ovScale').value = Math.round(ov.scale * 100);
      $('ovScaleVal').textContent = Math.round(ov.scale * 100) + '%';

      $('ovRot').value = Math.round(ov.rot);
      $('ovRotVal').textContent = Math.round(ov.rot) + '°';

      $('ovOp').value = Math.round(ov.op * 100);
      $('ovOpVal').textContent = Math.round(ov.op * 100) + '%';

      $('ovScope').value = ov.scope;
    }
  }

  $('ovScale').oninput = e => {
    if (!S.ovSel) return;
    S.ovSel.scale = +e.target.value / 100;
    $('ovScaleVal').textContent = e.target.value + '%';
    scheduleRender();
    scheduleThumbs();
  };

  $('ovRot').oninput = e => {
    if (!S.ovSel) return;
    S.ovSel.rot = +e.target.value;
    $('ovRotVal').textContent = e.target.value + '°';
    scheduleRender();
    scheduleThumbs();
  };

  $('ovOp').oninput = e => {
    if (!S.ovSel) return;
    S.ovSel.op = +e.target.value / 100;
    $('ovOpVal').textContent = e.target.value + '%';
    scheduleRender();
    scheduleThumbs();
  };

  $('ovScope').onchange = e => {
    if (!S.ovSel) return;
    S.ovSel.scope = e.target.value;
    if (e.target.value === 'pick') S.ovSel.frames = new Set(selection());

    drawOvs();
    scheduleRender();
    scheduleThumbs(true);
  };

  $('ovCenter').onclick = () => {
    if (!S.ovSel) return;
    S.ovSel.x = S.W / 2;
    S.ovSel.y = S.H / 2;
    scheduleRender();
    scheduleThumbs(true);
  };

  $('ovDel').onclick = () => {
    if (!S.ovSel) return;
    S.overlays.splice(S.overlays.indexOf(S.ovSel), 1);
    S.ovSel = S.overlays[S.overlays.length - 1] || null;

    drawOvs();
    scheduleRender();
    scheduleThumbs(true);
  };


  /* =========================================================
     Eventos del lienzo
     ========================================================= */

  viewport.addEventListener('pointerdown', e => {
    if (!S.loaded) return;

    if (e.button === 1 || e.button === 2 || spaceDown) {
      panning = { x: e.clientX, y: e.clientY, sl: viewport.scrollLeft, st: viewport.scrollTop };
      viewport.classList.add('panning');
      viewport.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    if (e.button !== 0) return;

    const p = evtToImg(e);
    if (p.x < 0 || p.y < 0 || p.x >= S.W || p.y >= S.H) return;

    viewport.setPointerCapture(e.pointerId);

    if (S.tool === 'move') {
      const ov = overlayAt(p);
      if (ov) {
        S.ovSel = ov;
        dragOv = { ov, dx: p.x - ov.x, dy: p.y - ov.y };
        drawOvs();
        scheduleRender();
      }
      return;
    }

    if (S.tool === 'pick') {
      const s = S.frames[S.cur].data;
      const o = (((p.y | 0) * S.W) + (p.x | 0)) << 2;

      if (s[o + 3] === 0) {
        toast('Ese píxel ya es transparente.');
        return;
      }

      addKey([s[o], s[o + 1], s[o + 2]]);
      return;
    }

    setPlaying(false);
    beginStroke(p);
  });

  viewport.addEventListener('pointermove', e => {
    if (panning) {
      viewport.scrollLeft = panning.sl - (e.clientX - panning.x);
      viewport.scrollTop = panning.st - (e.clientY - panning.y);
      return;
    }

    if (S.loaded && (S.tool === 'erase' || S.tool === 'restore')) {
      const r = viewport.getBoundingClientRect();
      cursorEl.style.display = 'block';
      cursorEl.style.left = (e.clientX - r.left + viewport.scrollLeft) + 'px';
      cursorEl.style.top = (e.clientY - r.top + viewport.scrollTop) + 'px';
    }

    if (dragOv) {
      const p = evtToImg(e);
      dragOv.ov.x = p.x - dragOv.dx;
      dragOv.ov.y = p.y - dragOv.dy;
      scheduleRender();
      return;
    }

    if (!stroke.active) return;

    const p = evtToImg(e);
    paintSegment(stroke.last, p);
    stroke.last = p;
  });

  function releasePointer() {
    if (panning) {
      panning = null;
      viewport.classList.remove('panning');
    }

    if (dragOv) {
      dragOv = null;
      scheduleThumbs(true);
    }

    endStrokeCommit();
  }

  viewport.addEventListener('pointerup', releasePointer);
  viewport.addEventListener('pointercancel', releasePointer);
  viewport.addEventListener('pointerleave', () => cursorEl.style.display = 'none');
  viewport.addEventListener('contextmenu', e => e.preventDefault());

  viewport.addEventListener('wheel', e => {
    if (!S.loaded) return;
    e.preventDefault();
    setZoom(S.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
  }, { passive: false });


  /* =========================================================
     Carga del archivo
     ========================================================= */

  async function loadBase(file) {
    try {
      let W, H, frames;

      if (/gif/i.test(file.type) || /\.gif$/i.test(file.name)) {
        const g = parseGIF(await file.arrayBuffer());
        W = g.width;
        H = g.height;
        frames = g.frames;

      } else {
        const bmp = await createImageBitmap(file);
        W = bmp.width;
        H = bmp.height;

        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const x = c.getContext('2d');
        x.drawImage(bmp, 0, 0);

        frames = [{ data: x.getImageData(0, 0, W, H).data, delay: 100 }];
      }

      S.W = W;
      S.H = H;
      S.frames = frames;
      S.cur = 0;
      S.playing = false;

      S.keys = [];
      S.per = new Array(frames.length).fill(null);
      S.undo = [];
      S.redo = [];
      S.undoBytes = 0;

      S.sel = new Set([0]);
      S.markKey = null;
      S.clip = null;
      S.overlays = [];
      S.ovSel = null;

      S.globalMask = { erase: newMask(), keep: newMask() };
      stroke.mask = null;
      stroke.active = false;

      S.out = new ImageData(W, H);
      cv.width = W;
      cv.height = H;
      S.loaded = true;

      $('drop').style.display = 'none';
      $('fname').textContent = file.name;
      $('meta').textContent = W + '×' + H + ' · ' + frames.length + (frames.length > 1 ? ' cuadros' : ' cuadro');
      $('frameRange').max = frames.length - 1;
      $('btnGif').disabled = false;
      $('btnPng').disabled = false;

      autoPickKey();
      invalidateKeys();
      drawKeys();
      drawOvs();
      buildStrip();
      fit();
      updateButtons();
      updateMarkMsg();
      setPlaying(frames.length > 1);

    } catch (err) {
      console.error(err);
      toast(err.message || 'No se pudo abrir el archivo.', true);
    }
  }


  /* =========================================================
     Vista
     ========================================================= */

  function applyZoom() {
    const w = Math.max(1, Math.round(S.W * S.zoom));
    const h = Math.max(1, Math.round(S.H * S.zoom));

    wrap.style.width = w + 'px';
    wrap.style.height = h + 'px';
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';

    $('zoomVal').textContent = Math.round(S.zoom * 100) + '%';
    $('zoom').value = Math.round(S.zoom * 100);
    sizeCursor();
  }

  function setZoom(z) {
    S.zoom = Math.min(16, Math.max(0.1, z));
    applyZoom();
  }

  function fit() {
    setZoom(Math.min(
      (viewport.clientWidth - 56) / S.W,
      (viewport.clientHeight - 56) / S.H,
      8
    ));
  }

  function sizeCursor() {
    const d = S.brush * S.zoom;
    cursorEl.style.width = d + 'px';
    cursorEl.style.height = d + 'px';
  }


  /* =========================================================
     Reproducción
     ========================================================= */

  function setPlaying(on) {
    S.playing = on && S.frames.length > 1;

    $('btnPlay').innerHTML = S.playing
      ? '<svg viewBox="0 0 24 24"><rect x="6" y="4.5" width="4" height="15"/><rect x="14" y="4.5" width="4" height="15"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg>';

    clearTimeout(playTimer);
    if (S.playing) tick();
  }

  function tick() {
    render();

    playTimer = setTimeout(() => {
      if (!S.playing) return;
      S.cur = (S.cur + 1) % S.frames.length;
      tick();
    }, Math.max(20, S.frames[S.cur].delay));
  }

  function goto(i) {
    setPlaying(false);
    S.cur = (i + S.frames.length) % S.frames.length;
    render();
    markThumbState();

    const t = thumbEls[S.cur];
    if (t) t.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }


  /* =========================================================
     Controles del panel
     ========================================================= */

  function setTool(t) {
    S.tool = t;

    document.querySelectorAll('.tool').forEach(b => {
      b.setAttribute('aria-pressed', b.dataset.tool === t);
    });

    viewport.style.cursor = (t === 'erase' || t === 'restore')
      ? 'none'
      : (t === 'move' ? 'move' : 'crosshair');

    if (t !== 'erase' && t !== 'restore') cursorEl.style.display = 'none';
    scheduleRender();
  }

  document.querySelectorAll('.tool').forEach(b => {
    b.onclick = () => setTool(b.dataset.tool);
  });

  $('brush').oninput = e => {
    S.brush = +e.target.value;
    $('brushVal').textContent = S.brush + ' px';
    sizeCursor();
  };

  $('targetSeg').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;

    S.target = b.dataset.t;
    [...e.currentTarget.children].forEach(x => x.setAttribute('aria-pressed', x === b));
  };

  $('tol').oninput = e => {
    S.tol = +e.target.value;
    $('tolVal').textContent = S.tol;
    invalidateKeys();

    clearTimeout(tolTimer);
    tolTimer = setTimeout(() => {
      recomputeAllPresence();
      invalidateKeys();
      markThumbState();
    }, 300);
  };

  $('soft').oninput = e => {
    S.soft = +e.target.value;
    $('softVal').textContent = S.soft;
    invalidateKeys();
  };

  $('modeSel').onchange = e => {
    S.mode = e.target.value;
    invalidateKeys();
  };

  $('zoom').oninput = e => setZoom(+e.target.value / 100);
  $('btnFit').onclick = fit;

  $('bgSeg').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;

    S.viewBg = b.dataset.bg;
    [...e.currentTarget.children].forEach(x => x.setAttribute('aria-pressed', x === b));
    wrap.className = S.viewBg === 'checker' ? '' : 'bg-' + S.viewBg;
  };

  $('expSeg').onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;

    S.expBg = b.dataset.exp;
    [...e.currentTarget.children].forEach(x => x.setAttribute('aria-pressed', x === b));
  };

  $('btnUndo').onclick = () => {
    const e = S.undo.pop();
    if (!e) return;

    S.undoBytes -= e.bytes;
    S.redo.push(applySnaps(e));
    updateButtons();
    scheduleRender();
    scheduleThumbs(true);
  };

  $('btnRedo').onclick = () => {
    const e = S.redo.pop();
    if (!e) return;

    S.undo.push(applySnaps(e));
    S.undoBytes += e.bytes;
    updateButtons();
    scheduleRender();
    scheduleThumbs(true);
  };

  $('btnCopy').onclick = () => {
    if (!S.loaded) return;

    const o = pf(S.cur);
    S.clip = { erase: new Uint8Array(o.erase.arr), keep: new Uint8Array(o.keep.arr) };

    updateButtons();
    toast('Máscara del cuadro ' + (S.cur + 1) + ' copiada.');
  };

  $('btnPaste').onclick = () => {
    if (!S.clip) return;

    const list = selection();
    pushUndo(list);

    list.forEach(f => {
      const o = pf(f);
      putAlpha(o.erase, S.clip.erase);
      putAlpha(o.keep, S.clip.keep);
      o.dirty = hasInk(S.clip.erase) || hasInk(S.clip.keep);
    });

    scheduleRender();
    scheduleThumbs(true);
    toast('Pegada en ' + list.length + ' cuadros.');
  };

  $('btnClearFrame').onclick = () => {
    if (!S.loaded) return;

    pushUndo([S.cur]);
    const o = pf(S.cur);
    clearMask(o.erase);
    clearMask(o.keep);
    o.dirty = false;

    scheduleRender();
    scheduleThumbs(true);
  };

  $('btnClearSel').onclick = () => {
    if (!S.loaded) return;

    const list = selection();
    pushUndo(list);

    list.forEach(f => {
      const o = pf(f);
      clearMask(o.erase);
      clearMask(o.keep);
      o.dirty = false;
    });

    scheduleRender();
    scheduleThumbs(true);
    toast('Limpiados ' + list.length + ' cuadros.');
  };

  $('btnReset').onclick = () => {
    if (!S.loaded) return;

    S.per = new Array(S.frames.length).fill(null);
    S.globalMask = { erase: newMask(), keep: newMask() };
    S.undo = [];
    S.redo = [];
    S.undoBytes = 0;

    updateButtons();
    scheduleRender();
    scheduleThumbs(true);
    toast('Todas las máscaras borradas.');
  };

  $('btnPlay').onclick = () => setPlaying(!S.playing);
  $('btnPrev').onclick = () => goto(S.cur - 1);
  $('btnNext').onclick = () => goto(S.cur + 1);
  $('frameRange').oninput = e => goto(+e.target.value);

  $('btnOpen').onclick = $('btnOpen2').onclick = () => $('file').click();

  $('file').onchange = e => {
    if (e.target.files[0]) loadBase(e.target.files[0]);
    e.target.value = '';
  };


  /* =========================================================
     Arrastrar y soltar
     ========================================================= */

  function overStage(e) {
    const r = viewport.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right &&
           e.clientY >= r.top && e.clientY <= r.bottom;
  }

  window.addEventListener('dragenter', e => {
    e.preventDefault();
    dragDepth++;

    $('dropMsg').textContent = S.loaded ? 'Soltá para apoyarla encima' : 'Soltá para abrir el GIF';
    $('dropover').style.display = 'grid';
  });

  window.addEventListener('dragover', e => e.preventDefault());

  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      $('dropover').style.display = 'none';
    }
  });

  window.addEventListener('drop', async e => {
    e.preventDefault();
    dragDepth = 0;
    $('dropover').style.display = 'none';

    const files = [...e.dataTransfer.files].filter(f => /^image\//.test(f.type));
    if (!files.length) return;

    if (!S.loaded || !overStage(e)) {
      loadBase(files[0]);
      return;
    }

    for (const f of files) await addOverlay(f);
  });


  /* =========================================================
     Teclado
     ========================================================= */

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      showHelp(false);
      return;
    }

    const tag = e.target.tagName;
    if (tag === 'SELECT' || (tag === 'INPUT' && e.target.type !== 'range')) return;
    if ($('help').classList.contains('on')) return;

    if (e.code === 'Space') {
      spaceDown = true;
      e.preventDefault();
      if (!e.repeat && !panning) setPlaying(!S.playing);
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      (e.shiftKey ? $('btnRedo') : $('btnUndo')).click();
      return;
    }

    const k = e.key.toLowerCase();

    if (k === 'e') setTool('erase');
    else if (k === 'r') setTool('restore');
    else if (k === 'p') setTool('pick');
    else if (k === 'm') setTool('move');

    else if (k === '[') {
      $('brush').value = Math.max(2, S.brush - Math.ceil(S.brush * .2));
      $('brush').oninput({ target: $('brush') });
    }
    else if (k === ']') {
      $('brush').value = Math.min(300, S.brush + Math.ceil(S.brush * .2));
      $('brush').oninput({ target: $('brush') });
    }

    else if (e.key === 'ArrowLeft') { goto(S.cur - 1); S.sel = new Set([S.cur]); markThumbState(); }
    else if (e.key === 'ArrowRight') { goto(S.cur + 1); S.sel = new Set([S.cur]); markThumbState(); }
    else if (k === 'f' && S.loaded) fit();
  });

  window.addEventListener('keyup', e => {
    if (e.code === 'Space') spaceDown = false;
  });

  window.addEventListener('resize', () => {
    if (S.loaded) sizeCursor();
  });


  /* =========================================================
     Exportar
     ========================================================= */

  function download(blob, name) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
  }

  function flatten(d, hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);

    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      d[i] = d[i] * a + r * (1 - a);
      d[i + 1] = d[i + 1] * a + g * (1 - a);
      d[i + 2] = d[i + 2] * a + b * (1 - a);
      d[i + 3] = 255;
    }
  }

  function baseName() {
    return ($('fname').textContent || 'imagen').replace(/\.\w+$/, '');
  }

  function solidColor() {
    if (S.expBg === 'white') return '#ffffff';
    if (S.expBg === 'black') return '#000000';
    return null;
  }

  $('btnPng').onclick = () => {
    const c = frameCanvas(S.cur);
    const x = c.getContext('2d');
    const solid = solidColor();

    if (solid) {
      const img = x.getImageData(0, 0, S.W, S.H);
      flatten(img.data, solid);
      x.putImageData(img, 0, 0);
    }

    c.toBlob(b => download(b, baseName() + '-cuadro' + (S.cur + 1) + '.png'));
  };

  let gifLibs = null;

  async function loadGifJs() {
    if (gifLibs) return gifLibs;

    const base = 'https://cdnjs.cloudflare.com/ajax/libs/gif.js/0.2.0/';

    await new Promise((ok, err) => {
      const s = document.createElement('script');
      s.src = base + 'gif.js';
      s.onload = ok;
      s.onerror = () => err(new Error('No se pudo cargar el codificador de GIF. Revisá la conexión.'));
      document.head.appendChild(s);
    });

    const txt = await fetch(base + 'gif.worker.js').then(r => r.text());
    gifLibs = { worker: URL.createObjectURL(new Blob([txt], { type: 'application/javascript' })) };

    return gifLibs;
  }

  // color señuelo: el más alejado de los que ya usa la imagen
  function pickMagic(datas) {
    const cand = [[255, 0, 255], [0, 255, 0], [0, 255, 255], [255, 0, 128], [128, 255, 0]];
    const used = new Set();

    datas.forEach(d => {
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] > 127) used.add((d[i] >> 4 << 8) | (d[i + 1] >> 4 << 4) | (d[i + 2] >> 4));
      }
    });

    let best = cand[0];
    let bestDist = -1;

    for (const c of cand) {
      let min = 1e9;

      used.forEach(k => {
        const dr = c[0] - (((k >> 8) & 15) * 16 + 8);
        const dg = c[1] - (((k >> 4) & 15) * 16 + 8);
        const db = c[2] - ((k & 15) * 16 + 8);
        const d2 = dr * dr + dg * dg + db * db;
        if (d2 < min) min = d2;
      });

      if (min > bestDist) {
        bestDist = min;
        best = c;
      }
    }

    return best;
  }

  $('btnGif').onclick = async () => {
    setPlaying(false);

    $('busy').style.display = 'grid';
    $('busyText').textContent = 'Preparando los cuadros…';
    $('busyBar').style.width = '0%';

    try {
      const { worker } = await loadGifJs();
      const solid = solidColor();

      const datas = [];
      for (let f = 0; f < S.frames.length; f++) {
        const c = frameCanvas(f);
        datas.push(c.getContext('2d').getImageData(0, 0, S.W, S.H).data);
        $('busyBar').style.width = Math.round((f + 1) / S.frames.length * 20) + '%';
      }

      const magic = solid ? null : pickMagic(datas);

      const opts = {
        workers: 2,
        quality: 5,
        width: S.W,
        height: S.H,
        workerScript: worker,
        dither: false
      };
      if (magic) opts.transparent = (magic[0] << 16) | (magic[1] << 8) | magic[2];

      const gif = new GIF(opts);

      for (let f = 0; f < S.frames.length; f++) {
        const d = datas[f];
        const img = new ImageData(S.W, S.H);
        const o = img.data;

        if (solid) {
          o.set(d);
          flatten(o, solid);

        } else {
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 128) {
              o[i] = magic[0];
              o[i + 1] = magic[1];
              o[i + 2] = magic[2];
              o[i + 3] = 255;
            } else {
              o[i] = d[i];
              o[i + 1] = d[i + 1];
              o[i + 2] = d[i + 2];
              o[i + 3] = 255;
            }
          }
        }

        const c = document.createElement('canvas');
        c.width = S.W;
        c.height = S.H;
        c.getContext('2d').putImageData(img, 0, 0);

        gif.addFrame(c, { delay: S.frames[f].delay, copy: true, dispose: 2 });
        $('busyBar').style.width = (20 + Math.round((f + 1) / S.frames.length * 10)) + '%';
      }

      $('busyText').textContent = 'Armando el GIF…';

      gif.on('progress', p => {
        $('busyBar').style.width = (30 + p * 70) + '%';
      });

      gif.on('finished', blob => {
        $('busy').style.display = 'none';
        download(blob, baseName() + '-sin-fondo.gif');
        toast('GIF guardado.');
      });

      gif.render();

    } catch (err) {
      console.error(err);
      $('busy').style.display = 'none';
      toast(err.message || 'Falló la exportación.', true);
    }
  };


  /* =========================================================
     Arranque
     ========================================================= */

  setTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  setTool('erase');
  showHelp(true);

})();
