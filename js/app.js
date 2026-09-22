/* Nadir georeferencer – UI. Geometry lives in georef.js. */
$(function () {
  'use strict';

  const G = window.Georef;
  const NS = 'http://www.w3.org/2000/svg';
  // Labels use a web font so they look (and measure) the same in every browser and in the export.
  const FONT_FAMILY = 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const LABEL_FONT_READY = document.fonts ? document.fonts.load('600 16px Inter').catch(() => {}) : Promise.resolve();
  const COLORS = ['#e63946', '#f77f00', '#ffd60a', '#52b788', '#2a9d8f', '#1d6fe0', '#7b2cbf', '#ff4d9d', '#ffffff', '#1a1a1a'];
  const MAX_ZOOM = 16;

  /* ---------- State ---------- */

  const state = {
    controlPoints: [],   // {id, x, y, lat, lon, note}
    queries: [],         // {id, n, x, y}
    labels: [],          // {id, name, color, shape, scale, x, y, lx, ly}
    areas: [],           // {id, name, color, shape, scale, opacity, showSize, points: [[x, y], ...], ox, oy}
    method: 'similarity',
  };
  const image = { loaded: false, name: '', size: 0, W: 0, H: 0, url: null };
  const view = { s: 1, tx: 0, ty: 0 };
  const labelDefaults = { color: COLORS[0], shape: 'pill', scale: 1, opacity: 0.25, showSize: false };
  let mode = 'pan';
  let geo = { ok: false };
  let nextId = 1;
  let queryCounter = 0;
  let bubbleQueryId = null;
  let drawing = null;       // corners of the area being drawn, [[x, y], ...]
  let draftCursor = null;   // cursor position while drawing (rubber band)
  let draftGroup = null;
  // Shared project on the server. serverSnap is the JSON of the last version known to be saved there.
  const share = { id: null, token: null, version: 0, canEdit: false, serverSnap: null,
                  saving: false, dirty: false, error: null, timer: null };

  const $vp = $('#viewport'), vp = $vp[0];
  const $stage = $('#stage'), photo = $('#photo')[0], overlay = $('#overlay')[0];
  const layerAreas = $('#layer-areas')[0], layerLabels = $('#layer-labels')[0], layerMarkers = $('#layer-markers')[0];
  const measureCtx = document.createElement('canvas').getContext('2d');
  const modalCp = new bootstrap.Modal('#modal-cp');
  const modalLabel = new bootstrap.Modal('#modal-label');

  /* ---------- Helpers ---------- */

  function esc(s) { return $('<div>').text(s == null ? '' : s).html(); }
  function svg(tag, attrs, parent) {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }
  function byId(list, id) { return list.find(o => o.id === id); }
  function inImage(x, y) { return x >= 0 && y >= 0 && x <= image.W && y <= image.H; }
  function mapsUrl(ll) { return 'https://www.google.com/maps?q=' + ll.lat.toFixed(7) + ',' + ll.lon.toFixed(7); }
  function fmtDist(m) { return m < 1 ? (m * 100).toFixed(0) + ' cm' : m < 1000 ? m.toFixed(m < 10 ? 2 : 1) + ' m' : (m / 1000).toFixed(2) + ' km'; }

  function toast(msg, variant) {
    const $t = $(`<div class="toast align-items-center text-bg-${variant || 'dark'} border-0" role="status">
      <div class="d-flex"><div class="toast-body"></div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div></div>`);
    $t.find('.toast-body').text(msg);
    $('#toasts').append($t);
    $t.on('hidden.bs.toast', () => $t.remove());
    new bootstrap.Toast($t[0], { delay: 4000 }).show();
  }

  function copy(text) {
    const done = () => toast('Copied ' + text, 'success');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
    function fallback() {
      const $ta = $('<textarea>').val(text).css({ position: 'fixed', opacity: 0 }).appendTo('body');
      $ta[0].select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed', 'danger'); }
      $ta.remove();
    }
  }

  function textColorFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(c => {
      c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111111' : '#ffffff';
  }

  /* ---------- Georeference ---------- */

  function computeFit() {
    geo = G.fit(state.controlPoints, state.method, [image.W / 2, image.H / 2]);
  }

  /* ---------- Persistence ---------- */

  // Local work is keyed by image, or by shared project id when viewing a share.
  // For a share, the stored copy remembers which server version it was based on.
  function storageKey() {
    return share.id ? 'nadir:share:' + share.id
                    : 'nadir:v1:' + image.name + ':' + image.size + ':' + image.W + 'x' + image.H;
  }

  function snapshot() {
    return {
      app: 'nadir-georeferencer', version: 1,
      image: { name: image.name, width: image.W, height: image.H },
      method: state.method, controlPoints: state.controlPoints,
      queries: state.queries, labels: state.labels, areas: state.areas, labelDefaults,
    };
  }

  function readLocal() {
    try { return JSON.parse(localStorage.getItem(storageKey()) || 'null'); } catch (e) { return null; }
  }

  function saveLocal() {
    if (!image.loaded) return;
    const data = share.id ? { base: share.version, data: snapshot() } : snapshot();
    try { localStorage.setItem(storageKey(), JSON.stringify(data)); } catch (e) { /* storage unavailable */ }
  }

  function save() {
    saveLocal();
    if (share.id) {
      if (share.canEdit) scheduleRemoteSave();
      else renderShareStatus();
    }
  }

  function restore(data) {
    const arr = a => Array.isArray(a) ? a : [];
    state.controlPoints = arr(data.controlPoints).filter(p => isFinite(p.x) && isFinite(p.lat) && isFinite(p.lon));
    state.queries = arr(data.queries).filter(q => isFinite(q.x));
    state.labels = arr(data.labels).filter(l => isFinite(l.x) && isFinite(l.lx));
    state.areas = arr(data.areas).filter(a => Array.isArray(a.points) && a.points.length >= 3);
    drawing = null;
    state.method = G.METHODS[data.method] ? data.method : 'similarity';
    if (data.labelDefaults) Object.assign(labelDefaults, data.labelDefaults);
    const all = [...state.controlPoints, ...state.queries, ...state.labels, ...state.areas];
    nextId = all.reduce((m, o) => Math.max(m, o.id || 0), 0) + 1;
    all.forEach(o => { if (!o.id) o.id = nextId++; });
    queryCounter = state.queries.reduce((m, q) => Math.max(m, q.n || 0), 0);
    bubbleQueryId = null;
  }

  /* ---------- Image loading ---------- */

  // sharedProject: the api.php 'get' response when opening a share; omitted for a local file.
  function openImage(file, sharedProject) {
    if (!file || !/^image\//.test(file.type)) { toast('That is not an image file', 'danger'); return; }
    const url = URL.createObjectURL(file);
    const probe = new Image();
    probe.onload = () => {
      if (image.url) URL.revokeObjectURL(image.url);
      Object.assign(image, { loaded: true, name: file.name, size: file.size, file,
                             W: probe.naturalWidth, H: probe.naturalHeight, url });
      photo.src = url;
      photo.width = image.W; photo.height = image.H;
      $(overlay).attr({ width: image.W, height: image.H, viewBox: `0 0 ${image.W} ${image.H}` });
      $vp.addClass('has-image');
      $('#status-file').text(`${file.name} · ${image.W}×${image.H}`);
      $('#btn-share, #btn-export-top').prop('disabled', false);

      restore({});
      let restored = false;
      if (sharedProject) {
        restored = applySharedProject(sharedProject);
      } else {
        leaveShare();
        const saved = readLocal();
        if (saved) { restore(saved); restored = true; }
      }
      fitView();
      renderAll();
      renderShareStatus();
      if (sharedProject) {
        if (!state.controlPoints.length) setMode('cp'); else setMode('pan');
      } else if (restored && (state.controlPoints.length || state.labels.length)) {
        toast(`Restored ${state.controlPoints.length} control point(s) and ${state.labels.length} label(s) saved for this image`);
      } else if (!state.controlPoints.length) {
        setMode('cp');
      }
    };
    probe.onerror = () => { URL.revokeObjectURL(url); toast('Could not read that image', 'danger'); };
    probe.src = url;
  }

  function loadProjectFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try { data = JSON.parse(reader.result); } catch (e) { toast('Not a valid project file', 'danger'); return; }
      if (!image.loaded) { toast('Open the image first, then load the project', 'warning'); return; }
      if (data.image && (data.image.width !== image.W || data.image.height !== image.H)) {
        toast(`Project was made for ${data.image.name} (${data.image.width}×${data.image.height}); positions may not match`, 'warning');
      }
      restore(data);
      renderAll(); save();
      toast('Project loaded', 'success');
    };
    reader.readAsText(file);
  }

  $('#file-image').on('change', function () { openImage(this.files[0]); this.value = ''; });
  $('#file-project').on('change', function () { if (this.files[0]) loadProjectFile(this.files[0]); this.value = ''; });

  $vp.on('dragover', e => { e.preventDefault(); $vp.addClass('drop'); })
     .on('dragleave drop', () => $vp.removeClass('drop'))
     .on('drop', e => {
       e.preventDefault();
       const f = e.originalEvent.dataTransfer.files[0];
       if (!f) return;
       if (/\.json$/i.test(f.name) || f.type === 'application/json') loadProjectFile(f);
       else openImage(f);
     });

  /* ---------- View (pan / zoom) ---------- */

  function fitScale() {
    return Math.min(vp.clientWidth / image.W, vp.clientHeight / image.H) * 0.97;
  }

  function fitView() {
    view.s = fitScale();
    view.tx = (vp.clientWidth - image.W * view.s) / 2;
    view.ty = (vp.clientHeight - image.H * view.s) / 2;
    applyView();
  }

  function zoomAt(factor, mx, my) {
    const s = Math.min(MAX_ZOOM, Math.max(fitScale() * 0.5, view.s * factor));
    view.tx = mx - (mx - view.tx) * (s / view.s);
    view.ty = my - (my - view.ty) * (s / view.s);
    view.s = s;
    applyView();
  }

  function centerOn(x, y) {
    view.tx = vp.clientWidth / 2 - x * view.s;
    view.ty = vp.clientHeight / 2 - y * view.s;
    applyView();
  }

  function applyView() {
    if (!image.loaded) return;
    $stage.css('transform', `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`);
    $('#zoom-level').text(Math.round(view.s * 100) + '%');
    renderMarkers();
    positionBubble();
  }

  function clientToImage(e) {
    const r = vp.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.tx) / view.s, y: (e.clientY - r.top - view.ty) / view.s };
  }

  vp.addEventListener('wheel', e => {
    if (!image.loaded) return;
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    zoomAt(Math.exp(-dy * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  function zoomCenter(f) { zoomAt(f, vp.clientWidth / 2, vp.clientHeight / 2); }
  $('#zoom-in').on('click', () => zoomCenter(1.5));
  $('#zoom-out').on('click', () => zoomCenter(1 / 1.5));
  $('#zoom-fit').on('click', () => image.loaded && fitView());
  $(window).on('resize', () => applyView());

  /* ---------- Pointer interaction ---------- */

  let ptr = null;

  vp.addEventListener('pointerdown', e => {
    if (!image.loaded || e.button !== 0 || $(e.target).closest('#bubble').length) return;
    const $t = $(e.target).closest('[data-drag]');
    const start = clientToImage(e);
    ptr = { id: e.pointerId, cx: e.clientX, cy: e.clientY, moved: false, start,
            tx: view.tx, ty: view.ty };
    if ($t.length) {
      const type = $t.attr('data-drag'), id = +$t.attr('data-id');
      if (type === 'area') {
        ptr.click = { type, id };            // clicking an area edits it; dragging on it pans
      } else {
        ptr.drag = { type, id, index: +$t.attr('data-index') };
        const o = dragObject(ptr.drag);
        ptr.orig = !o || type === 'midpoint' ? null     // a midpoint becomes a corner once dragged
          : type === 'vertex' ? [...o.points[ptr.drag.index]]
          : type === 'arealabel' ? { ox: o.ox || 0, oy: o.oy || 0 }
          : { x: o.x, y: o.y, lx: o.lx, ly: o.ly };
      }
    }
    vp.setPointerCapture(e.pointerId);
  });

  vp.addEventListener('pointermove', e => {
    if (image.loaded) {
      const pt = clientToImage(e);
      updateStatus(pt);
      if (drawing) { draftCursor = [pt.x, pt.y]; renderDraft(); }
    }
    if (!ptr || e.pointerId !== ptr.id) return;
    const dx = e.clientX - ptr.cx, dy = e.clientY - ptr.cy;
    if (!ptr.moved && Math.hypot(dx, dy) > 4) {
      ptr.moved = true;
      if (!ptr.drag) $vp.addClass('panning');
      if (ptr.drag && ptr.drag.type === 'midpoint') {
        const a = dragObject(ptr.drag), i = ptr.drag.index;
        const [x0, y0] = a.points[i], [x1, y1] = a.points[(i + 1) % a.points.length];
        a.points.splice(i + 1, 0, [(x0 + x1) / 2, (y0 + y1) / 2]);
        ptr.drag = { type: 'vertex', id: a.id, index: i + 1 };
        ptr.orig = [...a.points[i + 1]];
      }
    }
    if (!ptr.moved) return;
    if (ptr.drag && ptr.orig) {
      const o = dragObject(ptr.drag);
      const ix = dx / view.s, iy = dy / view.s;
      const type = ptr.drag.type;
      if (type === 'label') { o.lx = ptr.orig.lx + ix; o.ly = ptr.orig.ly + iy; }
      else if (type === 'arealabel') { o.ox = ptr.orig.ox + ix; o.oy = ptr.orig.oy + iy; }
      else if (type === 'vertex') o.points[ptr.drag.index] = [ptr.orig[0] + ix, ptr.orig[1] + iy];
      else { o.x = ptr.orig.x + ix; o.y = ptr.orig.y + iy; }
      if (type === 'cp') computeFit();
      renderOverlay();
      positionBubble();
    } else if (!ptr.drag) {
      view.tx = ptr.tx + dx; view.ty = ptr.ty + dy;
      applyView();
    }
  });

  function endPointer(e, cancelled) {
    if (!ptr || e.pointerId !== ptr.id) return;
    const p = ptr; ptr = null;
    $vp.removeClass('panning');
    if (cancelled) return;
    if (p.moved) {
      if (p.drag) { save(); renderAll(); }
    } else if (p.drag) {
      if (p.drag.type === 'vertex' && e.altKey) deleteVertex(p.drag);
      else if (p.drag.type !== 'vertex' && p.drag.type !== 'midpoint') objectClicked(p.drag);
    } else if (p.click) {
      objectClicked(p.click);
    } else {
      imageClicked(p.start.x, p.start.y);
    }
  }
  vp.addEventListener('pointerup', e => endPointer(e, false));
  vp.addEventListener('pointercancel', e => endPointer(e, true));
  vp.addEventListener('pointerleave', () => { if (!ptr) updateStatus(null); });

  function dragObject(d) {
    if (d.type === 'cp') return byId(state.controlPoints, d.id);
    if (['area', 'arealabel', 'vertex', 'midpoint'].includes(d.type)) return byId(state.areas, d.id);
    if (d.type === 'query') return byId(state.queries, d.id);
    return byId(state.labels, d.id);   // 'label' (body) or 'anchor' (tip)
  }

  function imageClicked(x, y) {
    if (mode === 'pan') { hideBubble(); return; }
    if (!inImage(x, y)) { toast('Click inside the image'); return; }
    if (mode === 'cp') openCpModal(null, x, y);
    else if (mode === 'query') addQuery(x, y, true);
    else if (mode === 'label') openLabelModal(null, x, y);
    else if (mode === 'area') addDraftPoint(x, y);
  }

  function objectClicked(d) {
    if (d.type === 'cp') openCpModal(d.id);
    else if (d.type === 'query') showBubble(d.id);
    else if (d.type === 'area' || d.type === 'arealabel') openAreaModal(d.id);
    else openLabelModal(d.id);
  }

  function updateStatus(pt) {
    if (!pt || !inImage(pt.x, pt.y)) { $('#status-px').text('–'); $('#status-ll').text(''); return; }
    $('#status-px').text(`x ${Math.round(pt.x)}  y ${Math.round(pt.y)}`);
    const ll = geo.ok && geo.toLatLon(pt.x, pt.y);
    $('#status-ll').text(ll ? G.formatDecimal(ll) : '');
  }

  /* ---------- Modes ---------- */

  const HINTS = {
    pan: '',
    cp: 'Click a spot you can also identify on a map, then enter its coordinates',
    query: 'Click anywhere to read its coordinates',
    label: 'Click the location you want to label',
  };

  function setMode(m) {
    if (m !== 'area' && drawing) cancelDraft();
    mode = m;
    $('#mode-' + m).prop('checked', true);
    $vp.removeClass('mode-pan mode-cp mode-query mode-label mode-area').addClass('mode-' + m);
    renderMarkers();   // corner handles are shown in Area mode only
    updateHint();
  }
  function updateHint() {
    let h = HINTS[mode];
    if (mode === 'query' && !geo.ok) h = 'Add control points first. ' + (geo.error || '');
    if (mode === 'area') {
      h = !drawing ? 'Click to start an area. Drag corners to reshape, drag midpoints to add a corner, Alt-click a corner to delete it.'
        : drawing.length < 3 ? 'Click to add corners · Backspace undoes · Esc cancels'
        : 'Click the first corner, double-click or press Enter to finish · Backspace undoes · Esc cancels';
    }
    $('#mode-hint').text(image.loaded ? h : '');
  }
  $('input[name=mode]').on('change', function () { setMode(this.value); });

  $(document).on('keydown', e => {
    if ($(e.target).is('input, textarea, select') || $('.modal.show').length || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (drawing && (k === 'escape' || k === 'enter' || k === 'backspace')) {
      if (k === 'escape') cancelDraft();
      else if (k === 'enter') finishArea();
      else { drawing.pop(); if (drawing.length) { renderMarkers(); updateHint(); } else cancelDraft(); }
      e.preventDefault();
      return;
    }
    if (k === 'escape' || k === 'p') { setMode('pan'); hideBubble(); }
    else if (k === 'a') setMode('area');
    else if (k === 'c') setMode('cp');
    else if (k === 'q') setMode('query');
    else if (k === 'l') setMode('label');
    else if (image.loaded && (k === '+' || k === '=')) zoomCenter(1.5);
    else if (image.loaded && (k === '-' || k === '_')) zoomCenter(1 / 1.5);
    else if (image.loaded && k === '0') fitView();
    else return;
    e.preventDefault();
  });

  /* ---------- Rendering: overlay ---------- */

  function baseFont() { return Math.max(12, Math.round(Math.max(image.W, image.H) / 70)); }

  // Shared label geometry for the SVG overlay, the modal preview and JPEG export.
  function labelFontSize(lb, fsOverride) { return fsOverride || baseFont() * (lb.scale || 1); }

  // textWidth: the rendered width when known (SVG); otherwise measured on a canvas.
  function labelGeom(lb, fsOverride, textWidth) {
    const fs = labelFontSize(lb, fsOverride);
    const font = `600 ${fs}px ${FONT_FAMILY}`;
    measureCtx.font = font;
    const tw = textWidth || measureCtx.measureText(lb.name || ' ').width;
    let w, h, r;
    if (lb.shape === 'ellipse') { h = fs * 2.1; w = tw * 1.2 + fs * 1.6; r = null; }
    else { h = fs * 1.7; w = tw + fs * 1.5; r = lb.shape === 'rounded' ? fs * 0.35 : h / 2; }
    const dx = lb.x - lb.lx, dy = lb.y - lb.ly, len = Math.hypot(dx, dy);
    let wedge = null;
    if (len > Math.min(w, h) / 2) {
      const bw = h * 0.24, nx = -dy / len * bw, ny = dx / len * bw;
      wedge = [[lb.lx + nx, lb.ly + ny], [lb.lx - nx, lb.ly - ny], [lb.x, lb.y]];
    }
    return { fs, font, w, h, r, wedge, cx: lb.lx, cy: lb.ly,
             stroke: Math.max(1, fs * 0.09), dot: fs * 0.2,
             fill: lb.color, text: textColorFor(lb.color),
             edge: textColorFor(lb.color) === '#ffffff' ? '#ffffff' : '#1a1a1a' };
  }

  // Body and pointer are drawn as one outlined shape: first both outlines (at double
  // width, since the fill then covers the inner half), then both fills on top, so no
  // outline shows where the pointer meets the body.
  // lb.noDot: skip the anchor dot unless there is a pointer (area labels sit inside their area).
  function drawLabelSvg(parent, lb, fsOverride, id, dragType) {
    const grp = svg('g', id != null ? { 'data-drag': dragType || 'label', 'data-id': id } : {}, parent);
    // Render the text first so the body can be sized to its actual on-screen width.
    const t = svg('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': FONT_FAMILY,
                            'font-weight': 600, 'font-size': labelFontSize(lb, fsOverride), 'pointer-events': 'none' }, grp);
    t.textContent = lb.name;
    let tw = 0;
    try { tw = t.getComputedTextLength(); } catch (e) { /* not rendered yet */ }
    const g = labelGeom(lb, fsOverride, tw);
    t.setAttribute('x', g.cx); t.setAttribute('y', g.cy); t.setAttribute('fill', g.text);

    const outline = { fill: g.edge, stroke: g.edge, 'stroke-width': g.stroke * 2, 'stroke-linejoin': 'round' };
    const fill = { fill: g.fill };
    for (const style of [outline, fill]) {
      if (g.wedge) grp.insertBefore(svg('polygon', { points: g.wedge.map(p => p.join(',')).join(' '), ...style }), t);
      grp.insertBefore(g.r == null
        ? svg('ellipse', { cx: g.cx, cy: g.cy, rx: g.w / 2, ry: g.h / 2, ...style })
        : svg('rect', { x: g.cx - g.w / 2, y: g.cy - g.h / 2, width: g.w, height: g.h, rx: g.r, ...style }), t);
    }
    if (lb.noDot && !g.wedge) return grp;
    const dot = svg('circle', { cx: lb.x, cy: lb.y, r: g.dot, fill: g.fill, stroke: g.edge, 'stroke-width': g.stroke }, grp);
    if (id != null && !dragType) { dot.setAttribute('data-drag', 'anchor'); dot.setAttribute('data-id', id); }
    return grp;
  }

  function drawLabelCanvas(ctx, lb) {
    const g = labelGeom(lb);
    const paths = [];
    if (g.wedge) {
      const w = new Path2D();
      w.moveTo(...g.wedge[0]); w.lineTo(...g.wedge[1]); w.lineTo(...g.wedge[2]); w.closePath();
      paths.push(w);
    }
    const body = new Path2D();
    if (g.r == null) body.ellipse(g.cx, g.cy, g.w / 2, g.h / 2, 0, 0, Math.PI * 2);
    else body.roundRect(g.cx - g.w / 2, g.cy - g.h / 2, g.w, g.h, g.r);
    paths.push(body);

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.fillStyle = ctx.strokeStyle = g.edge; ctx.lineWidth = g.stroke * 2;
    paths.forEach(p => { ctx.fill(p); ctx.stroke(p); });
    ctx.fillStyle = g.fill;
    paths.forEach(p => ctx.fill(p));
    ctx.fillStyle = g.text; ctx.font = g.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(lb.name, g.cx, g.cy);
    if (!lb.noDot || g.wedge) {
      ctx.fillStyle = g.fill; ctx.strokeStyle = g.edge; ctx.lineWidth = g.stroke;
      ctx.beginPath(); ctx.arc(lb.x, lb.y, g.dot, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  function renderLabels() {
    $(layerLabels).empty();
    state.areas.forEach(a => drawLabelSvg(layerLabels, areaLabel(a), null, a.id, 'arealabel'));
    state.labels.forEach(lb => drawLabelSvg(layerLabels, lb, null, lb.id));
  }

  /* ---------- Areas ---------- */

  function pointInPolygon(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Where an area's label attaches: its centroid, or, for a concave shape whose
  // centroid falls outside, the middle of the widest run across the centroid's row.
  function areaAnchor(pts) {
    let a = 0, cx = 0, cy = 0;
    pts.forEach(([x0, y0], i) => {
      const [x1, y1] = pts[(i + 1) % pts.length], f = x0 * y1 - x1 * y0;
      a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
    });
    const mean = [pts.reduce((t, p) => t + p[0], 0) / pts.length, pts.reduce((t, p) => t + p[1], 0) / pts.length];
    if (Math.abs(a) < 1e-9) return mean;
    cx /= 3 * a; cy /= 3 * a;
    if (pointInPolygon(cx, cy, pts)) return [cx, cy];
    const xs = [];
    pts.forEach(([x0, y0], i) => {
      const [x1, y1] = pts[(i + 1) % pts.length];
      if ((y0 > cy) !== (y1 > cy)) xs.push(x0 + (cy - y0) * (x1 - x0) / (y1 - y0));
    });
    xs.sort((p, q) => p - q);
    let best = null;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      if (!best || xs[i + 1] - xs[i] > best[1] - best[0]) best = [xs[i], xs[i + 1]];
    }
    return best ? [(best[0] + best[1]) / 2, cy] : mean;
  }

  function areaMetrics(points) {
    if (!geo.ok) return null;
    const lls = points.map(([x, y]) => geo.toLatLon(x, y));
    return lls.every(Boolean) ? G.polygonMetrics(lls) : null;
  }

  function fmtArea(m2) {
    if (m2 < 1e4) return Math.round(m2).toLocaleString() + ' m²';
    if (m2 < 1e6) return (m2 / 1e4).toFixed(2) + ' ha';
    return (m2 / 1e6).toFixed(2) + ' km²';
  }

  function areaLabelText(name, points, showSize) {
    const m = showSize && areaMetrics(points);
    return m ? `${name} · ${fmtArea(m.area)}` : name;
  }

  // An area's label, in the same form as a point label.
  function areaLabel(a) {
    const [x, y] = areaAnchor(a.points);
    return { name: areaLabelText(a.name, a.points, a.showSize), color: a.color, shape: a.shape, scale: a.scale,
             x, y, lx: x + (a.ox || 0), ly: y + (a.oy || 0), noDot: true };
  }

  // Area outlines get a faint dark halo so they stay visible on any background.
  function areaStrokeWidth() { return Math.max(1.5, baseFont() * 0.09); }
  const AREA_HALO = 'rgba(0, 0, 0, 0.45)';

  function rgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  function renderAreas() {
    $(layerAreas).empty();
    const sw = areaStrokeWidth();
    state.areas.forEach(a => {
      const points = a.points.map(p => p.join(',')).join(' ');
      svg('polygon', { points, fill: 'none', stroke: AREA_HALO, 'stroke-width': sw * 2, 'stroke-linejoin': 'round',
                       'pointer-events': 'none' }, layerAreas);
      svg('polygon', { points, fill: a.color, 'fill-opacity': a.opacity, stroke: a.color, 'stroke-width': sw,
                       'stroke-linejoin': 'round', class: 'area-body', 'data-drag': 'area', 'data-id': a.id }, layerAreas);
    });
  }

  // Corner and midpoint handles for reshaping areas (Area mode, when not drawing).
  function renderAreaHandles(k) {
    state.areas.forEach(a => {
      a.points.forEach(([x0, y0], i) => {
        const [x1, y1] = a.points[(i + 1) % a.points.length];
        const m = svg('g', { transform: `translate(${(x0 + x1) / 2} ${(y0 + y1) / 2}) scale(${k})`,
                             'data-drag': 'midpoint', 'data-id': a.id, 'data-index': i }, layerMarkers);
        svg('circle', { r: 9, fill: 'transparent' }, m);
        svg('circle', { r: 4, fill: 'rgba(255,255,255,.75)', stroke: '#000', 'stroke-width': 1.25 }, m);
      });
      a.points.forEach(([x, y], i) => {
        const v = svg('g', { transform: `translate(${x} ${y}) scale(${k})`, 'data-drag': 'vertex', 'data-id': a.id, 'data-index': i }, layerMarkers);
        svg('rect', { x: -9, y: -9, width: 18, height: 18, fill: 'transparent' }, v);
        svg('rect', { x: -5.5, y: -5.5, width: 11, height: 11, fill: '#fff', stroke: '#000', 'stroke-width': 1.75 }, v);
      });
    });
  }

  // The area being drawn: its outline so far, plus a rubber band to the cursor.
  function renderDraft() {
    if (!draftGroup) return;
    $(draftGroup).empty();
    if (!drawing || !drawing.length) return;
    const k = 1 / view.s;
    const pts = draftCursor ? [...drawing, draftCursor] : drawing;
    const str = pts.map(p => p.join(',')).join(' ');
    if (pts.length >= 3) svg('polygon', { points: str, fill: labelDefaults.color, 'fill-opacity': 0.2 }, draftGroup);
    svg('polyline', { points: str, fill: 'none', stroke: '#000', 'stroke-opacity': 0.6, 'stroke-width': 4 * k, 'stroke-linejoin': 'round' }, draftGroup);
    svg('polyline', { points: str, fill: 'none', stroke: '#fff', 'stroke-width': 2 * k, 'stroke-dasharray': `${6 * k} ${4 * k}` }, draftGroup);
    drawing.forEach(([x, y], i) => {
      const closing = i === 0 && drawing.length >= 3;
      svg('circle', { cx: x, cy: y, r: (closing ? 7 : 4.5) * k, fill: closing ? '#ffc107' : '#fff',
                      stroke: '#000', 'stroke-width': 1.5 * k }, draftGroup);
    });
  }

  function addDraftPoint(x, y) {
    drawing = drawing || [];
    const tol = 10 / view.s, near = p => Math.hypot(p[0] - x, p[1] - y) < tol;
    const last = drawing[drawing.length - 1];
    // Clicking the first corner, or clicking the last one again (double-click), finishes.
    if (drawing.length >= 3 && (near(drawing[0]) || near(last))) { finishArea(); return; }
    if (last && near(last)) return;
    drawing.push([x, y]);
    renderMarkers();
    updateHint();
  }

  function finishArea() {
    if (!drawing || drawing.length < 3) { toast('An area needs at least 3 corners'); return; }
    const pts = drawing;
    cancelDraft();
    openAreaModal(null, pts);
  }

  function cancelDraft() {
    drawing = null; draftCursor = null;
    renderMarkers();
    updateHint();
  }

  function deleteVertex(d) {
    const a = dragObject(d);
    if (a.points.length <= 3) { toast('An area needs at least 3 corners'); return; }
    a.points.splice(d.index, 1);
    renderAll(); save();
  }

  // Control points and query markers keep a constant on-screen size.
  function renderMarkers() {
    $(layerMarkers).empty();
    if (!image.loaded) return;
    const k = 1 / view.s;
    state.controlPoints.forEach((p, i) => {
      const g = svg('g', { transform: `translate(${p.x} ${p.y}) scale(${k})`, 'data-drag': 'cp', 'data-id': p.id, class: 'mk' }, layerMarkers);
      svg('circle', { r: 16, fill: 'transparent' }, g);
      const cross = 'M-16 0H-4M4 0H16M0 -16V-4M0 4V16';
      svg('path', { d: cross, stroke: '#000', 'stroke-width': 4, opacity: 0.7 }, g);
      svg('circle', { r: 9, fill: 'none', stroke: '#000', 'stroke-width': 4, opacity: 0.7 }, g);
      svg('path', { d: cross, stroke: '#ffc107', 'stroke-width': 1.75 }, g);
      svg('circle', { r: 9, fill: 'none', stroke: '#ffc107', 'stroke-width': 2, class: 'mk-ring' }, g);
      const t = svg('text', { x: 12, y: -12, fill: '#ffc107', class: 'mk-text' }, g);
      t.textContent = i + 1;
    });
    state.queries.forEach(q => {
      const g = svg('g', { transform: `translate(${q.x} ${q.y}) scale(${k})`, 'data-drag': 'query', 'data-id': q.id,
                           class: 'mk' + (q.id === bubbleQueryId ? ' selected' : '') }, layerMarkers);
      svg('circle', { r: 12, fill: 'transparent' }, g);
      svg('circle', { r: 7, fill: 'none', stroke: '#000', 'stroke-width': 4.5, opacity: 0.7 }, g);
      svg('circle', { r: 7, fill: 'none', stroke: '#0dcaf0', 'stroke-width': 2.25, class: 'mk-ring' }, g);
      svg('circle', { r: 1.6, fill: '#0dcaf0' }, g);
      const t = svg('text', { x: 10, y: -9, fill: '#0dcaf0', class: 'mk-text' }, g);
      t.textContent = 'Q' + q.n;
    });
    $vp.toggleClass('drawing', !!drawing);
    if (mode === 'area' && !drawing) renderAreaHandles(k);
    draftGroup = svg('g', { 'pointer-events': 'none' }, layerMarkers);
    renderDraft();
  }

  function renderOverlay() { renderAreas(); renderLabels(); renderMarkers(); }

  /* ---------- Rendering: sidebar ---------- */

  function renderMethodSelect() {
    const $m = $('#method').empty();
    for (const [key, spec] of Object.entries(G.METHODS)) {
      $('<option>').val(key).text(`${spec.label} · ≥${spec.min} pts`).appendTo($m);
    }
    $m.val(state.method);
  }

  function renderSidebar() {
    const n = state.controlPoints.length;
    $('#cp-count').text(n);
    $('#method').val(state.method);

    const $st = $('#calib-status');
    if (!image.loaded) $st.html('<span class="text-secondary">Open an image to start.</span>');
    else if (geo.ok) {
      const parts = [`<b class="text-success"><i class="bi bi-check-circle-fill"></i> Calibrated</b>`];
      if (geo.gsd) parts.push(`${(geo.gsd * 100).toFixed(1)} cm/px`);
      if (geo.bearing != null) parts.push(`<span class="text-nowrap">image top faces ${geo.bearing.toFixed(0)}° ${G.compass(geo.bearing)}</span>`);
      let html = parts.join(' · ');
      html += geo.rms != null
        ? `<br>RMS error <b>${fmtDist(geo.rms)}</b> <span class="text-secondary">(how well the points agree)</span>`
        : `<br><span class="text-secondary">Add one more point to check accuracy.</span>`;
      $st.html(html);
    } else if (geo.needed) {
      $st.html(`<span class="text-secondary">Add ${geo.needed} more control point${geo.needed > 1 ? 's' : ''} to enable location queries.</span>`);
    } else {
      $st.html(`<span class="text-danger"><i class="bi bi-exclamation-triangle"></i> ${esc(geo.error)}</span>`);
    }

    const $cl = $('#cp-list').empty();
    state.controlPoints.forEach((p, i) => {
      let resid = '';
      if (geo.ok && geo.redundant) {
        const r = geo.residuals[i];
        const cls = r < 1 ? 'resid-good' : r < 3 ? 'resid-ok' : 'resid-bad';
        resid = `<span class="${cls}" title="Distance between entered and fitted position">± ${fmtDist(r)}</span>`;
      }
      $cl.append(`<li class="list-group-item d-flex align-items-center gap-2">
        <span class="badge text-bg-warning">${i + 1}</span>
        <div class="flex-grow-1 row-click min-w-0" data-center="cp:${p.id}">
          <div class="coord">${G.formatDecimal(p)}</div>
          <div class="text-secondary text-truncate">${esc(p.note) || ''}${p.note && resid ? ' · ' : ''}${resid}</div>
        </div>
        <button class="icon-btn" data-edit="cp:${p.id}" title="Edit"><i class="bi bi-pencil"></i></button>
        <button class="icon-btn" data-del="cp:${p.id}" title="Delete"><i class="bi bi-x-lg"></i></button></li>`);
    });

    const $ql = $('#q-list').empty();
    state.queries.forEach(q => {
      const ll = geo.ok && geo.toLatLon(q.x, q.y);
      $ql.append(`<li class="list-group-item d-flex align-items-center gap-2 ${q.id === bubbleQueryId ? 'active-row' : ''}">
        <span class="badge text-bg-info">Q${q.n}</span>
        <div class="flex-grow-1 row-click coord" data-center="query:${q.id}">${ll ? G.formatDecimal(ll) : '<span class="text-secondary">not calibrated</span>'}</div>
        ${ll ? `<button class="icon-btn" data-copy="${G.formatDecimal(ll)}" title="Copy"><i class="bi bi-clipboard"></i></button>
               <a class="icon-btn" href="${mapsUrl(ll)}" target="_blank" rel="noopener" title="Open in Google Maps"><i class="bi bi-map"></i></a>` : ''}
        <button class="icon-btn" data-label-from="${q.id}" title="Make a label here"><i class="bi bi-tag"></i></button>
        <button class="icon-btn" data-del="query:${q.id}" title="Delete"><i class="bi bi-x-lg"></i></button></li>`);
    });
    if (!state.queries.length) $ql.append('<li class="list-group-item text-secondary">Use <i class="bi bi-question-diamond"></i> Query mode and click the image.</li>');

    const $ll = $('#label-list').empty();
    state.labels.forEach(lb => {
      const ll = geo.ok && geo.toLatLon(lb.x, lb.y);
      $ll.append(`<li class="list-group-item d-flex align-items-center gap-2">
        <span class="swatch-dot" style="background:${esc(lb.color)}"></span>
        <div class="flex-grow-1 row-click min-w-0" data-center="label:${lb.id}">
          <div class="text-truncate fw-semibold">${esc(lb.name)}</div>
          ${ll ? `<div class="coord text-secondary">${G.formatDecimal(ll)}</div>` : ''}
        </div>
        <button class="icon-btn" data-edit="label:${lb.id}" title="Edit"><i class="bi bi-pencil"></i></button>
        <button class="icon-btn" data-del="label:${lb.id}" title="Delete"><i class="bi bi-x-lg"></i></button></li>`);
    });
    if (!state.labels.length) $ll.append('<li class="list-group-item text-secondary">Use <i class="bi bi-tag"></i> Label mode and click the image.</li>');

    const $al = $('#area-list').empty();
    state.areas.forEach(a => {
      const m = areaMetrics(a.points);
      $al.append(`<li class="list-group-item d-flex align-items-center gap-2">
        <span class="swatch-area" style="border-color:${esc(a.color)};background:${rgba(a.color, Math.max(a.opacity, 0.1))}"></span>
        <div class="flex-grow-1 row-click min-w-0" data-center="area:${a.id}">
          <div class="text-truncate fw-semibold">${esc(a.name)}</div>
          <div class="text-secondary">${m ? `${fmtArea(m.area)} · perimeter ${fmtDist(m.perimeter)}` : `${a.points.length} corners`}</div>
        </div>
        <button class="icon-btn" data-edit="area:${a.id}" title="Edit"><i class="bi bi-pencil"></i></button>
        <button class="icon-btn" data-del="area:${a.id}" title="Delete"><i class="bi bi-x-lg"></i></button></li>`);
    });
    if (!state.areas.length) $al.append('<li class="list-group-item text-secondary">Use <i class="bi bi-pentagon"></i> Area mode and click the corners.</li>');

    $('#label-at-coords').prop('disabled', !geo.ok);
    updateHint();
  }

  function renderAll() {
    computeFit();
    renderOverlay();
    renderSidebar();
    renderBubble();
  }

  $('#method').on('change', function () {
    state.method = this.value;
    renderAll(); save();
  });

  $('#sidebar')
    .on('click', '[data-center]', function () {
      const [type, id] = $(this).attr('data-center').split(':');
      const o = dragObject({ type, id: +id });
      if (!o) return;
      if (type === 'label') centerOn((o.x + o.lx) / 2, (o.y + o.ly) / 2);
      else if (type === 'area') centerOn(...areaAnchor(o.points));
      else centerOn(o.x, o.y);
      if (type === 'query') showBubble(o.id);
    })
    .on('click', '[data-edit]', function () {
      const [type, id] = $(this).attr('data-edit').split(':');
      if (type === 'cp') openCpModal(+id);
      else if (type === 'area') openAreaModal(+id);
      else openLabelModal(+id);
    })
    .on('click', '[data-del]', function () {
      const [type, id] = $(this).attr('data-del').split(':');
      remove(type, +id);
    })
    .on('click', '[data-copy]', function () { copy($(this).attr('data-copy')); })
    .on('click', '[data-label-from]', function () {
      const q = byId(state.queries, +$(this).attr('data-label-from'));
      if (q) openLabelModal(null, q.x, q.y);
    });

  function remove(type, id) {
    const list = { cp: state.controlPoints, query: state.queries, label: state.labels, area: state.areas }[type];
    const i = list.findIndex(o => o.id === id);
    if (i < 0) return;
    list.splice(i, 1);
    if (type === 'query' && id === bubbleQueryId) bubbleQueryId = null;
    renderAll(); save();
  }

  $('#area-draw').on('click', () => { if (image.loaded) setMode('area'); });
  $('#q-clear').on('click', () => { state.queries = []; bubbleQueryId = null; renderAll(); save(); });

  /* ---------- Queries & bubble ---------- */

  function addQuery(x, y, announce) {
    if (!geo.ok) {
      toast(geo.needed ? `Add ${geo.needed} more control point(s) before querying locations` : geo.error, 'warning');
      return null;
    }
    const q = { id: nextId++, n: ++queryCounter, x, y };
    state.queries.push(q);
    bubbleQueryId = q.id;
    renderAll(); save();
    if (announce) positionBubble();
    return q;
  }

  function showBubble(id) { bubbleQueryId = id; renderMarkers(); renderSidebar(); renderBubble(); }
  function hideBubble() {
    if (bubbleQueryId == null) return;
    bubbleQueryId = null; renderMarkers(); renderSidebar(); renderBubble();
  }

  function renderBubble() {
    const q = bubbleQueryId != null && byId(state.queries, bubbleQueryId);
    const $b = $('#bubble');
    if (!q) { $b.addClass('d-none'); return; }
    const ll = geo.ok && geo.toLatLon(q.x, q.y);
    $b.html(`<div class="card-body p-2">
      <div class="d-flex align-items-center mb-1"><span class="badge text-bg-info me-2">Q${q.n}</span>
        <span class="text-secondary small">x ${Math.round(q.x)}, y ${Math.round(q.y)}</span>
        <button type="button" class="btn-close btn-sm ms-auto" data-bubble="close"></button></div>
      ${ll ? `<div class="font-monospace fw-semibold">${G.formatDecimal(ll)}</div>
              <div class="font-monospace small text-secondary">${G.formatDMS(ll)}</div>
              <div class="d-flex gap-1 mt-2">
                <button class="btn btn-sm btn-outline-secondary py-0" data-bubble="copy"><i class="bi bi-clipboard"></i> Copy</button>
                <a class="btn btn-sm btn-outline-secondary py-0" href="${mapsUrl(ll)}" target="_blank" rel="noopener"><i class="bi bi-map"></i> Maps</a>
                <button class="btn btn-sm btn-outline-success py-0" data-bubble="label"><i class="bi bi-tag"></i> Label</button>
                <button class="btn btn-sm btn-outline-danger py-0 ms-auto" data-bubble="delete" title="Delete"><i class="bi bi-trash"></i></button>
              </div>`
            : '<div class="text-secondary">Not calibrated</div>'}
    </div>`).removeClass('d-none');
    positionBubble();
  }

  function positionBubble() {
    const q = bubbleQueryId != null && byId(state.queries, bubbleQueryId);
    if (!q) return;
    $('#bubble').css({ left: q.x * view.s + view.tx, top: q.y * view.s + view.ty });
  }

  $('#bubble').on('pointerdown wheel', e => e.stopPropagation())
    .on('click', '[data-bubble]', function () {
      const q = byId(state.queries, bubbleQueryId);
      const act = $(this).attr('data-bubble');
      if (act === 'close' || !q) hideBubble();
      else if (act === 'copy') copy(G.formatDecimal(geo.toLatLon(q.x, q.y)));
      else if (act === 'label') openLabelModal(null, q.x, q.y);
      else if (act === 'delete') remove('query', q.id);
    });

  function findCoordinate() {
    const ll = G.parseLatLon($('#find-input').val());
    if (!ll) { toast('Could not read that coordinate', 'danger'); return; }
    if (!geo.ok) { toast('Calibrate the image first', 'warning'); return; }
    const p = geo.toPixel(ll.lat, ll.lon);
    if (!p || !inImage(p.x, p.y)) { toast('That coordinate is outside the image', 'warning'); return; }
    const q = addQuery(p.x, p.y);
    if (q) { centerOn(p.x, p.y); $('#find-input').val(''); }
  }
  $('#find-btn').on('click', findCoordinate);
  $('#find-input').on('keydown', e => { if (e.key === 'Enter') findCoordinate(); });

  /* ---------- Control point modal ---------- */

  let editingCp = null;

  function openCpModal(id, x, y) {
    const p = id != null ? byId(state.controlPoints, id) : null;
    editingCp = p ? { id, x: p.x, y: p.y } : { id: null, x, y };
    $('#cp-title').text(p ? `Control point ${state.controlPoints.indexOf(p) + 1}` : 'New control point');
    $('#cp-coords').val(p ? G.formatDecimal(p, 7) : '');
    $('#cp-name').val(p ? p.note || '' : '');
    $('#cp-delete').toggle(!!p);
    let px = `Image position: x ${Math.round(editingCp.x)}, y ${Math.round(editingCp.y)}.`;
    if (!p && geo.ok) {
      px += ` The current calibration puts this at ${G.formatDecimal(geo.toLatLon(editingCp.x, editingCp.y))}.`;
    }
    $('#cp-pixel').text(px);
    updateCpParsed();
    modalCp.show();
  }

  function updateCpParsed() {
    const v = $('#cp-coords').val();
    const ll = G.parseLatLon(v);
    const $p = $('#cp-parsed').removeClass('text-success text-danger');
    if (!v.trim()) $p.html('&nbsp;');
    else if (ll) $p.addClass('text-success').text(`✓ ${G.formatDecimal(ll)}  (${G.formatDMS(ll)})`);
    else $p.addClass('text-danger').text('✗ Not recognised. Try "61.128514, 14.535017"');
    return ll;
  }

  $('#cp-coords').on('input', updateCpParsed);
  $('#modal-cp').on('shown.bs.modal', () => $('#cp-coords').trigger('focus').trigger('select'));

  $('#form-cp').on('submit', e => {
    e.preventDefault();
    const ll = updateCpParsed();
    if (!ll) { $('#cp-coords').trigger('focus'); return; }
    const note = $('#cp-name').val().trim();
    const wasOk = geo.ok;
    let predictedErr = null;
    if (editingCp.id != null) {
      Object.assign(byId(state.controlPoints, editingCp.id), { lat: ll.lat, lon: ll.lon, note });
    } else {
      if (geo.ok) {
        const pred = geo.toLatLon(editingCp.x, editingCp.y);
        predictedErr = distance(pred, ll);
      }
      state.controlPoints.push({ id: nextId++, x: editingCp.x, y: editingCp.y, lat: ll.lat, lon: ll.lon, note });
    }
    modalCp.hide();
    renderAll(); save();
    if (!wasOk && geo.ok) toast('Calibrated! Switch to Query mode (Q) and click anywhere to read coordinates.', 'success');
    else if (predictedErr != null && geo.gsd && predictedErr > Math.max(5, 50 * geo.gsd)) {
      toast(`Heads-up: this point is ${fmtDist(predictedErr)} from where the previous calibration placed it. Check the coordinates.`, 'warning');
    }
  });

  $('#cp-delete').on('click', () => { modalCp.hide(); remove('cp', editingCp.id); });

  function distance(a, b) {
    const R = 6371008.8, rad = Math.PI / 180;
    const x = (b.lon - a.lon) * rad * Math.cos((a.lat + b.lat) / 2 * rad);
    return Math.hypot(x, (b.lat - a.lat) * rad) * R;
  }

  /* ---------- Label modal ---------- */

  let editingLabel = null;

  function renderSwatches(active) {
    const $s = $('#swatches').empty();
    COLORS.forEach(c => $s.append(`<button type="button" class="sw ${c === active ? 'active' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`));
    const custom = !COLORS.includes(active);
    $s.append(`<input type="color" class="form-control form-control-color ${custom ? 'border-primary' : ''}" id="label-color" value="${active}" title="Custom colour">`);
  }

  function currentColor() { return $('#swatches .sw.active').attr('data-color') || $('#label-color').val(); }

  $('#swatches')
    .on('click', '.sw', function () {
      $('#swatches .sw').removeClass('active'); $(this).addClass('active');
      $('#label-color').val($(this).attr('data-color')).removeClass('border-primary');
      renderPreview();
    })
    .on('input', '#label-color', function () {
      $('#swatches .sw').removeClass('active'); $(this).addClass('border-primary');
      renderPreview();
    });

  function openLabelModal(id, x, y) {
    const lb = id != null ? byId(state.labels, id) : null;
    const src = lb || labelDefaults;
    editingLabel = { kind: 'label', id, x: lb ? lb.x : x, y: lb ? lb.y : y, prefill: '' };
    if (editingLabel.x != null && geo.ok) editingLabel.prefill = G.formatDecimal(geo.toLatLon(editingLabel.x, editingLabel.y), 7);
    $('#label-title').text(lb ? 'Edit label' : 'New label');
    $('#label-name').val(lb ? lb.name : '');
    renderSwatches(src.color);
    $('#label-shape').val(src.shape);
    $('#label-size').val(src.scale);
    $('#label-coords').val(editingLabel.prefill)
      .attr('placeholder', geo.ok ? 'lat, lon' : 'Needs 2+ control points')
      .prop('disabled', !geo.ok);
    $('#label-coords-hint').removeClass('text-danger').text(
      !geo.ok ? 'Calibrate the image to place labels by coordinate.'
      : editingLabel.x == null ? 'Enter the coordinate to label.'
      : 'Edit this to move the label to another coordinate.');
    $('#label-delete').toggle(!!lb);
    $('#label-location-block').show();
    $('#area-options').hide();
    renderPreview();
    modalLabel.show();
  }

  // points: the corners of a newly drawn area (id == null), otherwise taken from the area.
  function openAreaModal(id, points) {
    const a = id != null ? byId(state.areas, id) : null;
    const src = a || labelDefaults;
    editingLabel = { kind: 'area', id, points: a ? a.points : points, saved: false };
    $('#label-title').text(a ? 'Edit area' : 'New area');
    $('#label-name').val(a ? a.name : '');
    renderSwatches(src.color);
    $('#label-shape').val(src.shape);
    $('#label-size').val(src.scale);
    $('#area-opacity').val(src.opacity != null ? src.opacity : 0.25);
    $('#area-show-size').prop('checked', !!src.showSize);
    const m = areaMetrics(editingLabel.points);
    $('#area-size-text').text(m ? `Size ${fmtArea(m.area)} · perimeter ${fmtDist(m.perimeter)}`
                                : 'Add 2 or more control points to measure the area.');
    $('#label-delete').toggle(!!a);
    $('#label-location-block').hide();
    $('#area-options').show();
    renderPreview();
    modalLabel.show();
  }

  function formLabel() {
    return { name: $('#label-name').val().trim(), color: currentColor(),
             shape: $('#label-shape').val(), scale: +$('#label-size').val() };
  }

  function renderPreview() {
    const f = formLabel();
    const el = $('#label-preview')[0];
    $(el).empty();
    const fs = Math.min(30, 18 * f.scale);
    if (editingLabel && editingLabel.kind === 'area') {
      const w = el.clientWidth || 400, opacity = +$('#area-opacity').val();
      const poly = [[14, 10], [w * 0.45, 4], [w - 12, 16], [w - 26, 64], [w * 0.3, 66], [8, 48]];
      svg('polygon', { points: poly.map(p => p.join(',')).join(' '), fill: f.color, 'fill-opacity': opacity,
                       stroke: f.color, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }, el);
      const name = areaLabelText(f.name || 'Area name', editingLabel.points, $('#area-show-size').is(':checked'));
      drawLabelSvg(el, { ...f, name, x: w / 2, y: 35, lx: w / 2, ly: 35, noDot: true }, fs);
      $('#area-opacity-val').text(Math.round(opacity * 100) + '%');
      $('#label-size-val').text(Math.round(baseFont() * f.scale) + ' px');
      return;
    }
    const lb = { ...f, name: f.name || 'Label name', x: 30, y: 58, lx: 0, ly: 26 };
    const g = labelGeom(lb, fs);
    lb.lx = Math.max(g.w / 2 + 70, 150); lb.ly = Math.min(26, 58 - g.h / 2 - 6);
    const wbox = el.clientWidth || 400;
    lb.lx = Math.min(lb.lx, wbox - g.w / 2 - 6);
    drawLabelSvg(el, lb, fs);
    $('#label-size-val').text(Math.round(baseFont() * f.scale) + ' px');
  }

  $('#label-name, #label-shape, #label-size, #area-opacity, #area-show-size').on('input change', renderPreview);
  $('#modal-label').on('shown.bs.modal', () => {
    renderPreview();
    $(editingLabel.kind === 'label' && editingLabel.x == null ? '#label-coords' : '#label-name').trigger('focus');
  });
  // Cancelling a newly drawn area puts it back in progress rather than losing it.
  $('#modal-label').on('hidden.bs.modal', () => {
    const ed = editingLabel;
    if (!ed || ed.kind !== 'area' || ed.id != null || ed.saved) return;
    setMode('area');
    drawing = ed.points;
    editingLabel = null;
    renderMarkers();
    updateHint();
    toast('Area not saved yet. Press Enter to finish it, or Esc to discard it.');
  });

  $('#form-label').on('submit', e => {
    e.preventDefault();
    const f = formLabel();
    if (!f.name) { $('#label-name').trigger('focus'); return; }
    if (editingLabel.kind === 'area') { saveArea(f); return; }
    const $hint = $('#label-coords-hint');

    let x = editingLabel.x, y = editingLabel.y;
    const coordText = ($('#label-coords').val() || '').trim();
    if (geo.ok && coordText && coordText !== editingLabel.prefill) {
      const ll = G.parseLatLon(coordText);
      const p = ll && geo.toPixel(ll.lat, ll.lon);
      if (!p) { $hint.addClass('text-danger').text('Could not read that coordinate.'); return; }
      if (!inImage(p.x, p.y)) { $hint.addClass('text-danger').text('That coordinate is outside the image.'); return; }
      x = p.x; y = p.y;
    }
    if (x == null) { $hint.addClass('text-danger').text('Enter a coordinate.'); return; }

    Object.assign(labelDefaults, { color: f.color, shape: f.shape, scale: f.scale });
    if (editingLabel.id != null) {
      const lb = byId(state.labels, editingLabel.id);
      lb.lx += x - lb.x; lb.ly += y - lb.y;          // keep the pill's offset when relocating
      Object.assign(lb, f, { x, y });
    } else {
      const lb = { id: nextId++, ...f, x, y };
      placeNewLabel(lb);
      state.labels.push(lb);
    }
    modalLabel.hide();
    renderAll(); save();
  });

  function saveArea(f) {
    const fields = { ...f, opacity: +$('#area-opacity').val(), showSize: $('#area-show-size').is(':checked') };
    Object.assign(labelDefaults, { color: f.color, shape: f.shape, scale: f.scale,
                                   opacity: fields.opacity, showSize: fields.showSize });
    if (editingLabel.id != null) Object.assign(byId(state.areas, editingLabel.id), fields);
    else state.areas.push({ id: nextId++, ...fields, points: editingLabel.points, ox: 0, oy: 0 });
    editingLabel.saved = true;
    modalLabel.hide();
    renderAll(); save();
  }

  // Offset a new label's body from its anchor, leaning towards the image centre.
  function placeNewLabel(lb) {
    lb.lx = lb.x; lb.ly = lb.y;
    const g = labelGeom(lb);
    const dx = g.fs * 1.5 + g.w / 2, dy = g.fs * 2.8;
    lb.lx = lb.x + (lb.x + dx + g.w / 2 > image.W ? -dx : dx);
    lb.ly = lb.y + (lb.y - dy - g.h < 0 ? dy : -dy);
  }

  $('#label-delete').on('click', () => { modalLabel.hide(); remove(editingLabel.kind, editingLabel.id); });
  $('#label-at-coords').on('click', () => openLabelModal(null, null, null));

  /* ---------- Project actions ---------- */

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function baseName() { return (image.name || 'nadir').replace(/\.[^.]+$/, ''); }

  $('#btn-save').on('click', () => {
    if (!image.loaded) { toast('Open an image first', 'warning'); return; }
    download(new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' }), baseName() + '.nadir.json');
  });

  $('#btn-export, #btn-export-top').on('click', () => {
    if (!image.loaded) { toast('Open an image first', 'warning'); return; }
    const c = document.createElement('canvas');
    c.width = image.W; c.height = image.H;
    const ctx = c.getContext('2d');
    ctx.drawImage(photo, 0, 0);
    LABEL_FONT_READY.then(() => {
      state.areas.forEach(a => {
        const path = new Path2D();
        a.points.forEach(([x, y], i) => i ? path.lineTo(x, y) : path.moveTo(x, y));
        path.closePath();
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.strokeStyle = AREA_HALO; ctx.lineWidth = areaStrokeWidth() * 2; ctx.stroke(path);
        ctx.fillStyle = rgba(a.color, a.opacity); ctx.fill(path);
        ctx.strokeStyle = a.color; ctx.lineWidth = areaStrokeWidth(); ctx.stroke(path);
        ctx.restore();
      });
      state.areas.forEach(a => drawLabelCanvas(ctx, areaLabel(a)));
      state.labels.forEach(lb => drawLabelCanvas(ctx, lb));
      c.toBlob(b => b ? download(b, baseName() + '-labelled.jpg') : toast('Export failed', 'danger'), 'image/jpeg', 0.92);
    });
  });

  let clearArmed = null;
  $('#btn-clear').on('click', function (e) {
    if (!clearArmed) {
      e.stopPropagation();
      const $b = $(this), html = $b.html();
      $b.html('<i class="bi bi-exclamation-triangle"></i> Click again to clear everything');
      clearArmed = setTimeout(() => { $b.html(html); clearArmed = null; }, 3000);
      return;
    }
    clearTimeout(clearArmed); clearArmed = null;
    $(this).html('<i class="bi bi-trash"></i> Clear everything');
    state.controlPoints = []; state.queries = []; state.labels = []; state.areas = []; bubbleQueryId = null;
    renderAll(); save();
  });

  /* ---------- Sharing ---------- */

  const API = 'api.php';
  const modalShare = new bootstrap.Modal('#modal-share');

  function shareUrl(id, token) {
    const base = location.origin + location.pathname;
    return base + '?p=' + encodeURIComponent(id) + (token ? '#edit=' + token : '');
  }

  // Edit tokens this browser holds, so the creator keeps edit rights when reopening the view link.
  function tokens() { try { return JSON.parse(localStorage.getItem('nadir:tokens') || '{}'); } catch (e) { return {}; } }
  function setToken(id, token) {
    const t = tokens();
    if (token) t[id] = token; else delete t[id];
    try { localStorage.setItem('nadir:tokens', JSON.stringify(t)); } catch (e) { /* ignore */ }
  }

  function apiError(xhr, fallback) {
    return (xhr.responseJSON && xhr.responseJSON.error) ||
           (xhr.status === 413 ? 'Image is too large to upload' : xhr.status ? fallback + ' (HTTP ' + xhr.status + ')' : 'Network error');
  }

  function leaveShare() {
    if (!share.id) return;
    clearTimeout(share.timer);
    Object.assign(share, { id: null, token: null, version: 0, canEdit: false, serverSnap: null,
                           saving: false, dirty: false, error: null, timer: null });
    history.replaceState(null, '', location.pathname);
    renderShareStatus();
  }

  // Called while the shared image is being opened: load the server's project,
  // or this browser's own changes to it if they are based on the current version.
  function applySharedProject(res) {
    Object.assign(share, { id: res.id, version: res.version, canEdit: res.canEdit,
                           dirty: false, error: null, saving: false });
    restore(res.project);
    share.serverSnap = JSON.stringify(snapshot());
    const local = readLocal();
    if (local && local.data && JSON.stringify(local.data) !== share.serverSnap) {
      if (local.base === res.version) {
        restore(local.data);
        if (share.canEdit) { toast('Uploading changes that were not saved last time'); scheduleRemoteSave(); }
        else toast('Showing your own changes to this shared project. Use "revert" to see the shared version.');
      } else {
        toast('The shared project was updated since your last visit. Showing the latest version.');
        saveLocal();
      }
    }
    return true;
  }

  function loadShare(id, hashToken) {
    const token = hashToken || tokens()[id] || null;
    $('#empty-title').text('Loading shared project…');
    $('#empty-sub').text('');
    $.ajax({ url: API, data: { action: 'get', p: id }, dataType: 'json',
             headers: token ? { 'X-Edit-Token': token } : {} })
      .done(res => {
        if (token && !res.canEdit) {
          setToken(id, null);
          toast('That edit link is not valid (any more). Opened view-only.', 'warning');
        } else if (res.canEdit) setToken(id, token);
        share.token = res.canEdit ? token : null;
        $('#empty-title').text(`Downloading ${res.image.name} (${(res.image.size / 1048576).toFixed(1)} MB)…`);
        fetch(res.image.url)
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
          .then(blob => openImage(new File([blob], res.image.name, { type: blob.type }), res))
          .catch(err => loadFailed('Could not download the image: ' + err.message));
      })
      .fail(xhr => loadFailed(apiError(xhr, 'Could not load the shared project')));

    function loadFailed(msg) {
      $('#empty-title').text(msg);
      $('#empty-sub').text('You can still open an image of your own.');
      history.replaceState(null, '', location.pathname);
    }
  }

  function scheduleRemoteSave() {
    share.dirty = true;
    clearTimeout(share.timer);
    share.timer = setTimeout(remoteSave, 1000);
    renderShareStatus();
  }

  function remoteSave(overwrite) {
    if (!share.id || !share.canEdit) return;
    if (share.saving) { share.timer = setTimeout(remoteSave, 500); return; }
    if (share.error === 'conflict' && !overwrite) return;
    const project = snapshot(), snap = JSON.stringify(project);
    Object.assign(share, { saving: true, dirty: false, error: null });
    renderShareStatus();
    $.ajax({ url: API + '?action=update&p=' + share.id, method: 'POST', contentType: 'application/json',
             headers: { 'X-Edit-Token': share.token }, dataType: 'json',
             data: JSON.stringify({ baseVersion: share.version, project }) })
      .done(res => {
        share.version = res.version;
        share.serverSnap = snap;
        saveLocal();
      })
      .fail(xhr => {
        share.dirty = true;
        if (xhr.status === 409) {
          share.error = 'conflict';
          share.conflictVersion = xhr.responseJSON && xhr.responseJSON.version;
          toast('Someone else saved changes to this project. Choose "load theirs" or "keep mine" at the top.', 'warning');
        } else {
          share.error = 'failed';
          toast('Could not save to the shared project: ' + apiError(xhr, 'Save failed'), 'danger');
        }
      })
      .always(() => {
        share.saving = false;
        renderShareStatus();
        if (share.dirty && !share.error) scheduleRemoteSave();
      });
  }

  function renderShareStatus() {
    const $s = $('#share-status');
    if (!share.id) { $s.addClass('d-none').empty(); return; }
    let html;
    if (share.canEdit) {
      html = '<i class="bi bi-people"></i> Shared · editing · ';
      if (share.error === 'conflict') {
        html += '<span class="failed">conflict:</span> <a href="#" data-share="reload">load theirs</a> / <a href="#" data-share="overwrite">keep mine</a>';
      } else if (share.error) {
        html += '<span class="failed">not saved</span> <a href="#" data-share="retry">retry</a>';
      } else if (share.saving || share.dirty) {
        html += '<span class="saving">saving…</span>';
      } else {
        html += '<i class="bi bi-cloud-check"></i> saved';
      }
    } else {
      html = '<i class="bi bi-eye"></i> Shared · view only';
      if (image.loaded && JSON.stringify(snapshot()) !== share.serverSnap) {
        html += ' · your changes are local <a href="#" data-share="revert">revert</a>';
      }
    }
    $s.html(html).removeClass('d-none');
  }

  $('#share-status').on('click', '[data-share]', function (e) {
    e.preventDefault();
    const act = $(this).attr('data-share');
    if (act === 'reload') {
      try { localStorage.removeItem(storageKey()); } catch (err) { /* ignore */ }
      location.reload();
    } else if (act === 'overwrite') {
      share.version = share.conflictVersion || share.version;
      share.error = null;
      remoteSave(true);
    } else if (act === 'retry') {
      share.error = null;
      remoteSave();
    } else if (act === 'revert') {
      restore(JSON.parse(share.serverSnap));
      try { localStorage.removeItem(storageKey()); } catch (err) { /* ignore */ }
      renderAll();
      renderShareStatus();
    }
  });

  function showShareForm(show) {
    $('#form-share').toggle(show);
    $('#share-links').toggle(!show);
    $('#share-error').text('').hide();
    $('#share-password').removeClass('is-invalid');
    $('#share-progress').addClass('d-none');
    $('#share-submit').prop('disabled', false);
  }

  $('#btn-share').on('click', () => {
    if (!image.loaded) return;
    $('#share-img-name').text(image.name);
    $('#share-img-size').text((image.size / 1048576).toFixed(1) + ' MB');
    $('#share-host').text(location.host || 'the server');
    if (share.id) {
      $('#share-view-url').val(shareUrl(share.id));
      $('#share-edit-wrap').toggle(share.canEdit);
      if (share.canEdit) $('#share-edit-url').val(shareUrl(share.id, share.token));
      showShareForm(false);
    } else {
      showShareForm(true);
    }
    modalShare.show();
  });

  $('#modal-share').on('shown.bs.modal', () => { if ($('#form-share').is(':visible')) $('#share-password').trigger('focus'); });
  $('#share-new-toggle').on('click', () => { showShareForm(true); $('#share-password').trigger('focus'); });
  $('#modal-share').on('click', '[data-copy-from]', function () { copy($($(this).attr('data-copy-from')).val()); });

  $('#form-share').on('submit', e => {
    e.preventDefault();
    const fd = new FormData();
    fd.append('password', $('#share-password').val());
    fd.append('project', JSON.stringify(snapshot()));
    fd.append('image', image.file, image.name);
    const $bar = $('#share-progress').removeClass('d-none').find('.progress-bar').css('width', '0%');
    $('#share-submit').prop('disabled', true);
    $('#share-error').hide();
    $('#share-password').removeClass('is-invalid');

    $.ajax({
      url: API + '?action=create', method: 'POST', data: fd, processData: false, contentType: false, dataType: 'json',
      xhr: () => {
        const x = new XMLHttpRequest();
        x.upload.addEventListener('progress', ev => {
          if (ev.lengthComputable) $bar.css('width', (ev.loaded / ev.total * 100).toFixed(0) + '%');
        });
        return x;
      },
    }).done(res => {
      const local = snapshot();
      clearTimeout(share.timer);
      Object.assign(share, { id: res.id, token: res.editToken, version: res.version, canEdit: true,
                             serverSnap: JSON.stringify(local), saving: false, dirty: false, error: null });
      setToken(res.id, res.editToken);
      history.replaceState(null, '', '?p=' + res.id);
      saveLocal();
      renderShareStatus();
      $('#share-view-url').val(shareUrl(res.id));
      $('#share-edit-url').val(shareUrl(res.id, res.editToken));
      $('#share-edit-wrap').show();
      showShareForm(false);
      $('#share-view-url').trigger('focus').trigger('select');
      toast('Shared! Copy the links below.', 'success');
    }).fail(xhr => {
      $('#share-password').toggleClass('is-invalid', xhr.status === 403);
      $('#share-error').text(apiError(xhr, 'Upload failed')).show();
      $('#share-progress').addClass('d-none');
      $('#share-submit').prop('disabled', false);
    });
  });

  /* ---------- Init ---------- */

  renderMethodSelect();
  renderAll();
  LABEL_FONT_READY.then(() => { if (image.loaded) renderLabels(); });
  setMode('pan');

  const sharedId = new URLSearchParams(location.search).get('p');
  if (sharedId) {
    const m = location.hash.match(/edit=([0-9a-f]+)/);
    if (m) history.replaceState(null, '', '?p=' + encodeURIComponent(sharedId));   // keep the secret out of the address bar
    loadShare(sharedId, m && m[1]);
  }
});
