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
    measures: [],        // {id, name, color, shape, scale, points: [[x, y], ...], ox, oy}
    method: 'similarity',
  };
  const image = { loaded: false, name: '', size: 0, W: 0, H: 0, url: null };
  const view = { s: 1, tx: 0, ty: 0 };
  const labelDefaults = { color: COLORS[0], shape: 'pill', scale: 1, opacity: 0.25, showSize: false };
  const measureDefaults = { color: '#ffd60a', shape: 'rounded', scale: 0.8 };
  let mode = 'pan';
  let geo = { ok: false };
  let nextId = 1;
  let queryCounter = 0;
  let bubble = null;        // what the info bubble shows: {type: 'query' | 'area' | 'measure', id}
  let drawing = null;       // points of the area or measurement being drawn, [[x, y], ...]
  let draftCursor = null;   // cursor position while drawing (rubber band)
  let draftGroup = null;
  // Shared project on the server. serverSnap is the JSON of the last version known to be saved there.
  const share = { id: null, token: null, version: 0, canEdit: false, isOwner: false, serverSnap: null,
                  saving: false, dirty: false, error: null, timer: null };

  const $vp = $('#viewport'), vp = $vp[0];
  const $stage = $('#stage'), photo = $('#photo')[0], overlay = $('#overlay')[0];
  const layerOsm = $('#layer-osm')[0];
  const layerAreas = $('#layer-areas')[0], layerMeasures = $('#layer-measures')[0], layerLabels = $('#layer-labels')[0], layerMarkers = $('#layer-markers')[0];
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
  function listOf(type) {
    return { cp: state.controlPoints, query: state.queries, label: state.labels,
             area: state.areas, measure: state.measures }[type];
  }
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
      queries: state.queries, labels: state.labels, areas: state.areas, measures: state.measures,
      labelDefaults, measureDefaults,
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
    state.measures = arr(data.measures).filter(m => Array.isArray(m.points) && m.points.length >= 2);
    if (data.measureDefaults) Object.assign(measureDefaults, data.measureDefaults);
    drawing = null;
    state.method = G.METHODS[data.method] ? data.method : 'similarity';
    if (data.labelDefaults) Object.assign(labelDefaults, data.labelDefaults);
    const all = [...state.controlPoints, ...state.queries, ...state.labels, ...state.areas, ...state.measures];
    nextId = all.reduce((m, o) => Math.max(m, o.id || 0), 0) + 1;
    all.forEach(o => { if (!o.id) o.id = nextId++; });
    queryCounter = state.queries.reduce((m, q) => Math.max(m, q.n || 0), 0);
    bubble = null;
  }

  /* ---------- Image loading ---------- */

  // sharedProject: the api.php 'get' response when opening a share; omitted for a local file.
  function openImage(file, sharedProject) {
    if (!file || !/^image\//.test(file.type)) { toast('That is not an image file', 'danger'); return; }
    const url = URL.createObjectURL(file);
    const probe = new Image();
    probe.onload = () => {
      if (image.url) URL.revokeObjectURL(image.url);
      stopLocate();
      resetOsm();
      Object.assign(image, { loaded: true, name: file.name, size: file.size, file,
                             W: probe.naturalWidth, H: probe.naturalHeight, url });
      photo.src = url;
      photo.width = image.W; photo.height = image.H;
      $(overlay).attr({ width: image.W, height: image.H, viewBox: `0 0 ${image.W} ${image.H}` });
      $('#clip-image-rect').attr({ width: image.W, height: image.H });
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
    scaleOsm();
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
  const touches = new Map();   // active pointers, for two-finger pinch zoom
  let pinch = null;

  function pinchState() {
    const [a, b] = [...touches.values()], r = vp.getBoundingClientRect();
    return { mx: (a[0] + b[0]) / 2 - r.left, my: (a[1] + b[1]) / 2 - r.top, d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1 };
  }
  function startPinch() {
    const p = pinchState();
    // Remember which image point is under the fingers, and keep it there.
    pinch = { d0: p.d, s0: view.s, ix: (p.mx - view.tx) / view.s, iy: (p.my - view.ty) / view.s };
    ptr = null;
    $vp.removeClass('panning');
  }
  function updatePinch() {
    const p = pinchState();
    view.s = Math.min(MAX_ZOOM, Math.max(fitScale() * 0.5, pinch.s0 * p.d / pinch.d0));
    view.tx = p.mx - pinch.ix * view.s;
    view.ty = p.my - pinch.iy * view.s;
    applyView();
  }

  vp.addEventListener('pointerdown', e => {
    if (!image.loaded || e.button !== 0 || $(e.target).closest('#bubble').length) return;
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (touches.size === 2) { startPinch(); return; }
    if (pinch) return;
    const $t = $(e.target).closest('[data-drag]');
    const start = clientToImage(e);
    ptr = { id: e.pointerId, cx: e.clientX, cy: e.clientY, moved: false, start,
            tx: view.tx, ty: view.ty };
    if ($t.length) {
      const type = $t.attr('data-drag'), id = +$t.attr('data-id');
      if (type === 'area' || type === 'measure') {
        ptr.click = { type, id };            // clicking shows its info; dragging on it pans
      } else {
        ptr.drag = { type, id, index: +$t.attr('data-index'), kind: $t.attr('data-kind') };
        const o = dragObject(ptr.drag);
        ptr.orig = !o || type === 'midpoint' ? null     // a midpoint becomes a corner once dragged
          : type === 'vertex' ? [...o.points[ptr.drag.index]]
          : type === 'arealabel' || type === 'measurelabel' ? { ox: o.ox || 0, oy: o.oy || 0 }
          : { x: o.x, y: o.y, lx: o.lx, ly: o.ly };
      }
    }
    try { vp.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
  });

  vp.addEventListener('pointermove', e => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch) { if (touches.size >= 2) updatePinch(); return; }
    if (image.loaded) {
      const pt = clientToImage(e);
      updateStatus(pt);
      if (drawing) {
        draftCursor = [pt.x, pt.y];
        renderDraft();
        if (mode === 'measure') updateHint();
      }
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
        ptr.drag = { type: 'vertex', id: a.id, index: i + 1, kind: ptr.drag.kind };
        ptr.orig = [...a.points[i + 1]];
      }
    }
    if (!ptr.moved) return;
    if (ptr.drag && ptr.orig) {
      const o = dragObject(ptr.drag);
      const ix = dx / view.s, iy = dy / view.s;
      const type = ptr.drag.type;
      if (type === 'label') { o.lx = ptr.orig.lx + ix; o.ly = ptr.orig.ly + iy; }
      else if (type === 'arealabel' || type === 'measurelabel') { o.ox = ptr.orig.ox + ix; o.oy = ptr.orig.oy + iy; }
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
    touches.delete(e.pointerId);
    if (pinch) { if (touches.size < 2) pinch = null; return; }   // a pinch never ends in a click
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
    if (d.type === 'vertex' || d.type === 'midpoint') return byId(listOf(d.kind || 'area'), d.id);
    if (d.type === 'area' || d.type === 'arealabel') return byId(state.areas, d.id);
    if (d.type === 'measure' || d.type === 'measurelabel') return byId(state.measures, d.id);
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
    else if (mode === 'measure') {
      if (geo.ok) addDraftPoint(x, y);
      else toast('Add 2 or more control points before measuring', 'warning');
    }
  }

  function objectClicked(d) {
    if (d.type === 'cp') openCpModal(d.id);
    else if (d.type === 'query') showBubble(d.id);
    else if (d.type === 'area' || d.type === 'arealabel') showAreaBubble(d.id);
    else if (d.type === 'measure' || d.type === 'measurelabel') openBubble('measure', d.id);
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
    if (drawing && m !== mode) cancelDraft();
    mode = m;
    $('#mode-' + m).prop('checked', true);
    $vp.removeClass('mode-pan mode-cp mode-query mode-label mode-area mode-measure').addClass('mode-' + m);
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
    if (mode === 'measure') {
      if (!geo.ok) h = 'Add 2 or more control points to measure distances.';
      else if (!drawing) h = 'Click to start measuring. Drag the points of a measurement to adjust it.';
      else {
        const m = measureMetrics(draftCursor ? [...drawing, draftCursor] : drawing);
        const seg = m && m.segments[m.segments.length - 1];
        h = seg ? `Total ${fmtDist(m.length)} · this segment ${fmtDist(seg.length)}, ${seg.bearing.toFixed(0)}° ${G.compass(seg.bearing)}`
                  + ' · double-click or Enter to finish'
                : 'Click the next point';
      }
    }
    $('#mode-hint').text(image.loaded ? h : '');
  }
  $('input[name=mode]').on('change', function () { setMode(this.value); });

  // Esc closes the open dialog even when focus has dropped out of it (for example after
  // the focused button was disabled or hidden while a request ran).
  $(document).on('keydown', e => {
    if (e.key !== 'Escape' || document.activeElement !== document.body) return;
    const open = $('.modal.show').last()[0];
    if (open) bootstrap.Modal.getInstance(open).hide();
  });

  $(document).on('keydown', e => {
    if ($(e.target).is('input, textarea, select') || $('.modal.show').length || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (drawing && (k === 'escape' || k === 'enter' || k === 'backspace')) {
      if (k === 'escape') cancelDraft();
      else if (k === 'enter') finishDraft();
      else { drawing.pop(); if (drawing.length) { renderMarkers(); updateHint(); } else cancelDraft(); }
      e.preventDefault();
      return;
    }
    if (k === 'escape' || k === 'p') { setMode('pan'); hideBubble(); }
    else if (k === 'a') setMode('area');
    else if (k === 'm') setMode('measure');
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
    state.measures.forEach(ms => drawLabelSvg(layerLabels, measureLabel(ms), null, ms.id, 'measurelabel'));
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

  /* ---------- Measurements ---------- */

  function measureMetrics(points) {
    if (!geo.ok) return null;
    const lls = points.map(([x, y]) => geo.toLatLon(x, y));
    return lls.every(Boolean) ? G.pathMetrics(lls) : null;
  }

  // The point halfway along a path, where its label sits.
  function pathMidpoint(pts) {
    const segs = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
    let half = segs.reduce((t, l) => t + l, 0) / 2;
    for (let i = 0; i < segs.length; i++) {
      if (half <= segs[i] || i === segs.length - 1) {
        const t = segs[i] ? Math.min(1, half / segs[i]) : 0;
        return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
      }
      half -= segs[i];
    }
    return pts[0];
  }

  function measureText(name, points) {
    const m = measureMetrics(points), len = m && fmtDist(m.length);
    return name && len ? `${name} · ${len}` : name || len || 'Measurement';
  }

  function measureLabel(ms) {
    const [x, y] = pathMidpoint(ms.points);
    return { name: measureText(ms.name, ms.points), color: ms.color, shape: ms.shape, scale: ms.scale,
             x, y, lx: x + (ms.ox || 0), ly: y + (ms.oy || 0), noDot: true };
  }

  function renderMeasures() {
    $(layerMeasures).empty();
    const sw = areaStrokeWidth();
    state.measures.forEach(ms => {
      const points = ms.points.map(p => p.join(',')).join(' ');
      const line = { points, fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'pointer-events': 'none' };
      svg('polyline', { ...line, stroke: AREA_HALO, 'stroke-width': sw * 2 }, layerMeasures);
      svg('polyline', { ...line, stroke: ms.color, 'stroke-width': sw }, layerMeasures);
      ms.points.forEach(([x, y]) => svg('circle', { cx: x, cy: y, r: sw * 1.4, fill: ms.color, stroke: AREA_HALO,
                                                    'stroke-width': sw * 0.6, 'pointer-events': 'none' }, layerMeasures));
      // A wide invisible stroke makes the thin line easy to click.
      svg('polyline', { points, fill: 'none', stroke: 'transparent', 'stroke-width': sw * 6, 'pointer-events': 'stroke',
                        class: 'measure-body', 'data-drag': 'measure', 'data-id': ms.id }, layerMeasures);
    });
  }

  function drawMeasuresCanvas(ctx) {
    const sw = areaStrokeWidth();
    state.measures.forEach(ms => {
      const path = new Path2D();
      ms.points.forEach(([x, y], i) => i ? path.lineTo(x, y) : path.moveTo(x, y));
      ctx.save();
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = AREA_HALO; ctx.lineWidth = sw * 2; ctx.stroke(path);
      ctx.strokeStyle = ms.color; ctx.lineWidth = sw; ctx.stroke(path);
      ms.points.forEach(([x, y]) => {
        ctx.beginPath(); ctx.arc(x, y, sw * 1.4, 0, Math.PI * 2);
        ctx.fillStyle = ms.color; ctx.fill();
        ctx.strokeStyle = AREA_HALO; ctx.lineWidth = sw * 0.6; ctx.stroke();
      });
      ctx.restore();
    });
  }

  function renderMeasureBubble(ms) {
    const m = measureMetrics(ms.points);
    const segs = m && m.segments;
    let detail = '';
    if (segs && segs.length === 1) {
      detail = `<div class="small text-secondary">bearing ${segs[0].bearing.toFixed(0)}° ${G.compass(segs[0].bearing)}</div>`;
    } else if (segs) {
      detail = `<div class="small text-secondary mt-1" style="max-height: 7.5rem; overflow-y: auto">${segs.map((g, i) =>
        `${i + 1}. ${fmtDist(g.length)} · ${g.bearing.toFixed(0)}° ${G.compass(g.bearing)}`).join('<br>')}</div>`;
    }
    $('#bubble').html(`<div class="card-body p-2">
      <div class="d-flex align-items-center mb-1 gap-2">
        <span class="swatch-line" style="background:${esc(ms.color)}"></span>
        <b class="text-truncate">${esc(ms.name || 'Measurement')}</b>
        <button type="button" class="btn-close btn-sm ms-auto" data-bubble="close"></button></div>
      ${m ? `<div class="fs-5 fw-semibold">${fmtDist(m.length)}</div>${detail}`
          : '<div class="text-secondary small">Add 2 or more control points to measure.</div>'}
      <div class="d-flex gap-1 mt-2">
        ${m ? '<button class="btn btn-sm btn-outline-secondary py-0" data-bubble="copy-measure"><i class="bi bi-clipboard"></i> Copy</button>' : ''}
        <button class="btn btn-sm btn-outline-secondary py-0" data-bubble="edit-measure"><i class="bi bi-pencil"></i> Name / style</button>
        <button class="btn btn-sm btn-outline-danger py-0 ms-auto" data-bubble="delete-measure" title="Delete"><i class="bi bi-trash"></i></button>
      </div>
    </div>`).removeClass('d-none');
    positionBubble();
  }

  // Point and midpoint handles for reshaping areas (closed) or measurements (open).
  function renderHandles(k, items, kind, closed) {
    items.forEach(a => {
      a.points.forEach(([x0, y0], i) => {
        if (!closed && i === a.points.length - 1) return;
        const [x1, y1] = a.points[(i + 1) % a.points.length];
        const m = svg('g', { transform: `translate(${(x0 + x1) / 2} ${(y0 + y1) / 2}) scale(${k})`,
                             'data-drag': 'midpoint', 'data-kind': kind, 'data-id': a.id, 'data-index': i }, layerMarkers);
        svg('circle', { r: 9, fill: 'transparent' }, m);
        svg('circle', { r: 4, fill: 'rgba(255,255,255,.75)', stroke: '#000', 'stroke-width': 1.25 }, m);
      });
      a.points.forEach(([x, y], i) => {
        const v = svg('g', { transform: `translate(${x} ${y}) scale(${k})`, 'data-drag': 'vertex', 'data-kind': kind,
                             'data-id': a.id, 'data-index': i }, layerMarkers);
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
    if (mode === 'area' && pts.length >= 3) svg('polygon', { points: str, fill: labelDefaults.color, 'fill-opacity': 0.2 }, draftGroup);
    svg('polyline', { points: str, fill: 'none', stroke: '#000', 'stroke-opacity': 0.6, 'stroke-width': 4 * k, 'stroke-linejoin': 'round' }, draftGroup);
    svg('polyline', { points: str, fill: 'none', stroke: '#fff', 'stroke-width': 2 * k, 'stroke-dasharray': `${6 * k} ${4 * k}` }, draftGroup);
    drawing.forEach(([x, y], i) => {
      const closing = mode === 'area' && i === 0 && drawing.length >= 3;
      svg('circle', { cx: x, cy: y, r: (closing ? 7 : 4.5) * k, fill: closing ? '#ffc107' : '#fff',
                      stroke: '#000', 'stroke-width': 1.5 * k }, draftGroup);
    });
  }

  function addDraftPoint(x, y) {
    drawing = drawing || [];
    const tol = 10 / view.s, near = p => Math.hypot(p[0] - x, p[1] - y) < tol;
    const last = drawing[drawing.length - 1];
    // Clicking the last point again (double-click) finishes; for an area, so does its first corner.
    const min = mode === 'measure' ? 2 : 3;
    if (drawing.length >= min && (near(last) || (mode === 'area' && near(drawing[0])))) { finishDraft(); return; }
    if (last && near(last)) return;
    drawing.push([x, y]);
    renderMarkers();
    updateHint();
  }

  function finishDraft() {
    if (mode === 'measure') {
      if (!drawing || drawing.length < 2) { toast('Click at least 2 points to measure'); return; }
      const ms = { id: nextId++, name: '', ...measureDefaults, points: drawing, ox: 0, oy: 0 };
      state.measures.push(ms);
      drawing = null; draftCursor = null;
      bubble = { type: 'measure', id: ms.id };
      renderAll(); save();
      return;
    }
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
    const a = dragObject(d), min = d.kind === 'measure' ? 2 : 3;
    if (a.points.length <= min) { toast(d.kind === 'measure' ? 'A measurement needs at least 2 points' : 'An area needs at least 3 corners'); return; }
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
                           class: 'mk' + (bubbleIs('query', q.id) ? ' selected' : '') }, layerMarkers);
      svg('circle', { r: 12, fill: 'transparent' }, g);
      svg('circle', { r: 7, fill: 'none', stroke: '#000', 'stroke-width': 4.5, opacity: 0.7 }, g);
      svg('circle', { r: 7, fill: 'none', stroke: '#0dcaf0', 'stroke-width': 2.25, class: 'mk-ring' }, g);
      svg('circle', { r: 1.6, fill: '#0dcaf0' }, g);
      const t = svg('text', { x: 10, y: -9, fill: '#0dcaf0', class: 'mk-text' }, g);
      t.textContent = 'Q' + q.n;
    });
    $vp.toggleClass('drawing', !!drawing);
    renderLocation(k);
    if (mode === 'area' && !drawing) renderHandles(k, state.areas, 'area', true);
    if (mode === 'measure' && !drawing) renderHandles(k, state.measures, 'measure', false);
    draftGroup = svg('g', { 'pointer-events': 'none' }, layerMarkers);
    renderDraft();
  }

  function renderOverlay() { renderAreas(); renderMeasures(); renderLabels(); renderMarkers(); }

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
      $ql.append(`<li class="list-group-item d-flex align-items-center gap-2 ${bubbleIs('query', q.id) ? 'active-row' : ''}">
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

    const $ml = $('#measure-list').empty();
    state.measures.forEach(ms => {
      const m = measureMetrics(ms.points), n = ms.points.length - 1;
      $ml.append(`<li class="list-group-item d-flex align-items-center gap-2">
        <span class="swatch-line" style="background:${esc(ms.color)}"></span>
        <div class="flex-grow-1 row-click min-w-0" data-center="measure:${ms.id}">
          <div class="text-truncate fw-semibold">${esc(ms.name || 'Measurement')}</div>
          <div class="text-secondary">${m ? fmtDist(m.length) + ' · ' : ''}${n} segment${n > 1 ? 's' : ''}</div>
        </div>
        <button class="icon-btn" data-edit="measure:${ms.id}" title="Name / style"><i class="bi bi-pencil"></i></button>
        <button class="icon-btn" data-del="measure:${ms.id}" title="Delete"><i class="bi bi-x-lg"></i></button></li>`);
    });
    if (!state.measures.length) $ml.append('<li class="list-group-item text-secondary">Use <i class="bi bi-rulers"></i> Measure mode and click along a route.</li>');

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
    $('#btn-locate').prop('disabled', !geo.ok);
    updateOsmUi();
    updateHint();
  }

  function renderAll() {
    computeFit();
    if (osm.on && osmKey() !== osm.key) renderOsm();   // calibration changed: re-project the map
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
      else if (type === 'area') { centerOn(...areaAnchor(o.points)); showAreaBubble(o.id); }
      else if (type === 'measure') { centerOn(...pathMidpoint(o.points)); openBubble('measure', o.id); }
      else centerOn(o.x, o.y);
      if (type === 'query') showBubble(o.id);
    })
    .on('click', '[data-edit]', function () {
      const [type, id] = $(this).attr('data-edit').split(':');
      if (type === 'cp') openCpModal(+id);
      else if (type === 'area') openAreaModal(+id);
      else if (type === 'measure') openMeasureModal(+id);
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
    const list = listOf(type);
    const i = list.findIndex(o => o.id === id);
    if (i < 0) return;
    list.splice(i, 1);
    if (bubbleIs(type, id)) bubble = null;
    renderAll(); save();
  }

  $('#area-draw').on('click', () => { if (image.loaded) setMode('area'); });
  $('#measure-draw').on('click', () => { if (image.loaded) setMode('measure'); });
  $('#q-clear').on('click', () => { state.queries = []; if (bubble && bubble.type === 'query') bubble = null; renderAll(); save(); });

  /* ---------- Queries & bubble ---------- */

  function addQuery(x, y, announce) {
    if (!geo.ok) {
      toast(geo.needed ? `Add ${geo.needed} more control point(s) before querying locations` : geo.error, 'warning');
      return null;
    }
    const q = { id: nextId++, n: ++queryCounter, x, y };
    state.queries.push(q);
    bubble = { type: 'query', id: q.id };
    renderAll(); save();
    if (announce) positionBubble();
    return q;
  }

  function bubbleIs(type, id) { return !!bubble && bubble.type === type && bubble.id === id; }
  function bubbleObject(type) {
    return bubble && bubble.type === type ? byId(listOf(type), bubble.id) : null;
  }
  function openBubble(type, id) { bubble = { type, id }; renderMarkers(); renderSidebar(); renderBubble(); }
  function showBubble(id) { openBubble('query', id); }
  function showAreaBubble(id) { openBubble('area', id); }
  function hideBubble() {
    if (!bubble) return;
    bubble = null;
    renderMarkers(); renderSidebar(); renderBubble();
  }

  function renderAreaBubble(a) {
    const m = areaMetrics(a.points);
    $('#bubble').html(`<div class="card-body p-2">
      <div class="d-flex align-items-center mb-1 gap-2">
        <span class="swatch-area" style="border-color:${esc(a.color)};background:${rgba(a.color, Math.max(a.opacity, 0.1))}"></span>
        <b class="text-truncate">${esc(a.name)}</b>
        <button type="button" class="btn-close btn-sm ms-auto" data-bubble="close"></button></div>
      ${m ? `<div class="fs-5 fw-semibold">${Math.round(m.area).toLocaleString()} m²</div>
             <div class="small text-secondary">${(m.area / 1e4).toFixed(m.area < 1e3 ? 3 : 2)} ha · perimeter ${fmtDist(m.perimeter)}</div>`
          : '<div class="text-secondary small">Add 2 or more control points to measure this area.</div>'}
      <div class="d-flex gap-1 mt-2">
        ${m ? '<button class="btn btn-sm btn-outline-secondary py-0" data-bubble="copy-area"><i class="bi bi-clipboard"></i> Copy</button>' : ''}
        <button class="btn btn-sm btn-outline-secondary py-0 ms-auto" data-bubble="edit-area"><i class="bi bi-pencil"></i> Edit</button>
      </div>
    </div>`).removeClass('d-none');
    positionBubble();
  }

  function renderBubble() {
    const a = bubbleObject('area');
    if (a) { renderAreaBubble(a); return; }
    const ms = bubbleObject('measure');
    if (ms) { renderMeasureBubble(ms); return; }
    const q = bubbleObject('query');
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
    let x, y;
    const a = bubbleObject('area'), ms = bubbleObject('measure'), q = bubbleObject('query');
    if (a || ms) {                 // above the area's or measurement's label
      const lb = a ? areaLabel(a) : measureLabel(ms);
      x = lb.lx; y = lb.ly - labelGeom(lb).h / 2;
    } else if (q) {
      x = q.x; y = q.y;
    } else return;
    $('#bubble').css({ left: x * view.s + view.tx, top: y * view.s + view.ty });
  }

  $('#bubble').on('pointerdown wheel', e => e.stopPropagation())
    .on('click', '[data-bubble]', function () {
      const act = $(this).attr('data-bubble');
      const a = bubbleObject('area'), ms = bubbleObject('measure');
      if (a && act === 'copy-area') { copy(Math.round(areaMetrics(a.points).area) + ' m²'); return; }
      if (a && act === 'edit-area') { openAreaModal(a.id); return; }
      if (ms && act === 'copy-measure') { copy(measureMetrics(ms.points).length.toFixed(1) + ' m'); return; }
      if (ms && act === 'edit-measure') { openMeasureModal(ms.id); return; }
      if (ms && act === 'delete-measure') { remove('measure', ms.id); return; }
      const q = bubbleObject('query');
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
    $('#label-name').prop('required', true);
    $('#label-location-block').show();
    $('#area-options').hide();
    renderPreview();
    modalLabel.show();
  }

  function openMeasureModal(id) {
    const ms = byId(state.measures, id);
    editingLabel = { kind: 'measure', id, points: ms.points };
    $('#label-title').text('Measurement');
    $('#label-name').val(ms.name || '').prop('required', false);
    renderSwatches(ms.color);
    $('#label-shape').val(ms.shape);
    $('#label-size').val(ms.scale);
    $('#label-delete').show();
    $('#label-location-block').hide();
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
    $('#label-name').prop('required', true);
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
    if (editingLabel && editingLabel.kind === 'measure') {
      const w = el.clientWidth || 400, line = [[14, 56], [w * 0.5, 22], [w - 14, 50]].map(p => p.join(',')).join(' ');
      svg('polyline', { points: line, fill: 'none', stroke: AREA_HALO, 'stroke-width': 6, 'stroke-linejoin': 'round' }, el);
      svg('polyline', { points: line, fill: 'none', stroke: f.color, 'stroke-width': 3, 'stroke-linejoin': 'round' }, el);
      drawLabelSvg(el, { ...f, name: measureText(f.name, editingLabel.points), x: w / 2, y: 35, lx: w / 2, ly: 35, noDot: true }, fs);
      $('#label-size-val').text(Math.round(baseFont() * f.scale) + ' px');
      return;
    }
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
    if (editingLabel.kind === 'measure') { saveMeasure(f); return; }
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

  function saveMeasure(f) {
    Object.assign(byId(state.measures, editingLabel.id), f);
    Object.assign(measureDefaults, { color: f.color, shape: f.shape, scale: f.scale });
    modalLabel.hide();
    renderAll(); save();
  }

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
      if (osm.on && osm.prefs.export) drawOsmCanvas(ctx);
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
      drawMeasuresCanvas(ctx);
      state.areas.forEach(a => drawLabelCanvas(ctx, areaLabel(a)));
      state.measures.forEach(ms => drawLabelCanvas(ctx, measureLabel(ms)));
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
    state.controlPoints = []; state.queries = []; state.labels = []; state.areas = []; state.measures = []; bubble = null;
    renderAll(); save();
  });

  /* ---------- My location ---------- */

  const locate = { watch: null, pos: null, centred: false };
  const $chip = $('#locate-chip');

  function locatePixel() {
    return locate.pos && geo.ok ? geo.toPixel(locate.pos.lat, locate.pos.lon) : null;
  }

  function startLocate() {
    if (!geo.ok) { toast('Add 2 or more control points first', 'warning'); return; }
    if (!navigator.geolocation) { toast('This browser cannot provide a location', 'danger'); return; }
    if (!window.isSecureContext) { toast('Location only works on a secure (https) page', 'danger'); return; }
    locate.centred = false;
    locate.watch = navigator.geolocation.watchPosition(onPosition, onPositionError,
                                                        { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
    $('#btn-locate').addClass('active');
    $chip.removeClass('d-none').html('<span class="spinner-border spinner-border-sm"></span> Finding your position…');
  }

  function stopLocate() {
    if (locate.watch != null) navigator.geolocation.clearWatch(locate.watch);
    locate.watch = null; locate.pos = null;
    $('#btn-locate').removeClass('active');
    $chip.addClass('d-none');
    renderMarkers();
  }

  function onPosition(p) {
    const c = p.coords;
    locate.pos = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, heading: c.heading, speed: c.speed };
    renderMarkers();
    renderLocateChip();
    const px = locatePixel();
    if (!locate.centred && px) {
      locate.centred = true;
      if (inImage(px.x, px.y)) centerOn(px.x, px.y);
    }
  }

  function onPositionError(err) {
    if (err.code === 1) { toast('Location access was denied', 'warning'); stopLocate(); }
    else if (!locate.pos) toast(err.code === 3 ? 'Still looking for your position…' : 'Your position is not available right now', 'warning');
  }

  function renderLocateChip() {
    const px = locatePixel();
    if (!px) return;
    const acc = `±${Math.round(locate.pos.acc)} m`;
    if (inImage(px.x, px.y)) {
      $chip.html(`<i class="bi bi-crosshair text-primary"></i> You are here · ${acc}`);
    } else {
      const seg = G.pathMetrics([geo.toLatLon(image.W / 2, image.H / 2), locate.pos]).segments[0];
      $chip.html(`<i class="bi bi-compass text-primary"></i> You are ${fmtDist(seg.length)} ${G.compass(seg.bearing)} of the photo · ${acc}`);
    }
  }

  // Blue dot (constant size) inside an accuracy circle (true size), plus a direction arrow when moving.
  function renderLocation(k) {
    const px = locatePixel();
    if (!px) return;
    const pos = locate.pos;
    if (geo.gsd) {
      svg('circle', { cx: px.x, cy: px.y, r: pos.acc / geo.gsd, fill: 'rgba(13,110,253,0.12)',
                      stroke: 'rgba(13,110,253,0.6)', 'stroke-width': 1.5 * k, 'pointer-events': 'none' }, layerMarkers);
    }
    const g = svg('g', { transform: `translate(${px.x} ${px.y}) scale(${k})`, 'pointer-events': 'none' }, layerMarkers);
    if (pos.heading != null && !isNaN(pos.heading) && pos.speed > 0.5 && geo.bearing != null) {
      // Compass heading relative to the direction the top of the image faces.
      svg('path', { d: 'M0 -24 L8 -9 L-8 -9 Z', fill: '#0d6efd', stroke: '#fff', 'stroke-width': 1.5,
                    transform: `rotate(${pos.heading - geo.bearing})` }, g);
    }
    svg('circle', { r: 10, fill: '#fff', stroke: 'rgba(0,0,0,.35)', 'stroke-width': 1 }, g);
    svg('circle', { r: 7, fill: '#0d6efd' }, g);
  }

  $('#btn-locate').on('click', () => { if (locate.watch != null) stopLocate(); else startLocate(); });
  $chip.on('click', () => {
    const px = locatePixel();
    if (px) centerOn(px.x, px.y);
  });

  /* ---------- Sharing ---------- */

  const API = 'api.php';
  const modalShare = new bootstrap.Modal('#modal-share');
  // State-changing requests must carry this header (the server rejects cross-site POSTs).
  $.ajaxSetup({ headers: { 'X-Nadir': '1' } });

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
    Object.assign(share, { id: null, token: null, version: 0, canEdit: false, isOwner: false, serverSnap: null,
                           saving: false, dirty: false, error: null, timer: null });
    history.replaceState(null, '', location.pathname);
    renderShareStatus();
  }

  // Called while the shared image is being opened: load the server's project,
  // or this browser's own changes to it if they are based on the current version.
  function applySharedProject(res) {
    Object.assign(share, { id: res.id, version: res.version, canEdit: res.canEdit, isOwner: res.isOwner,
                           title: res.title, dirty: false, error: null, saving: false });
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
        if (token && !res.tokenValid) {
          setToken(id, null);
          if (!res.canEdit) toast('That edit link is not valid (any more). Opened view-only.', 'warning');
        } else if (token) setToken(id, token);
        share.token = res.tokenValid ? token : null;
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
             headers: share.token ? { 'X-Edit-Token': share.token } : {}, dataType: 'json',
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

  // show: the form for saving a new project (or, when logged out, the log-in prompt) instead of the links.
  function showShareForm(show) {
    $('#form-share').toggle(show && !!me);
    $('#share-login-needed').toggle(show && !me);
    $('#share-links').toggle(!show);
    $('#share-error').text('');
    $('#share-progress').addClass('d-none');
    $('#share-submit').prop('disabled', false);
    if (show) $('#share-title').val(share.id && share.title ? share.title + ' (copy)' : image.name.replace(/\.[^.]+$/, ''));
  }

  function renderShareLinks() {
    $('#share-view-url').val(shareUrl(share.id));
    // The edit link needs the secret token; an owner on another device can make a new one.
    const hasLink = share.canEdit && !!share.token;
    $('#share-edit-wrap').toggle(hasLink || share.isOwner);
    $('#share-edit-url').val(hasLink ? shareUrl(share.id, share.token) : '').attr('placeholder', hasLink ? '' : 'No edit link on this device. Create one below.');
    $('#share-owner-tools').toggle(!!share.isOwner);
    $('#share-new-edit-link span').text(hasLink ? 'New edit link' : 'Create edit link');
  }

  $('#btn-share').on('click', () => {
    if (!image.loaded) return;
    $('#share-img-name').text(image.name);
    $('#share-img-size').text((image.size / 1048576).toFixed(1) + ' MB');
    if (share.id) {
      renderShareLinks();
      showShareForm(false);
    } else {
      showShareForm(true);
    }
    modalShare.show();
  });

  $('#modal-share').on('shown.bs.modal', () => { if ($('#form-share').is(':visible')) $('#share-title').trigger('focus').trigger('select'); });
  $('#share-new-toggle').on('click', () => { showShareForm(true); $('#share-title').trigger('focus'); });

  $('#share-new-edit-link').on('click', function () {
    const $b = $(this).prop('disabled', true);
    api('new-edit-link', {}, share.id)
      .done(res => {
        share.token = res.editToken;
        setToken(share.id, res.editToken);
        renderShareLinks();
        toast('New edit link created. The previous one no longer works.', 'success');
      })
      .fail(xhr => toast(apiError(xhr, 'Could not create an edit link'), 'danger'))
      .always(() => $b.prop('disabled', false));
  });

  // A small preview for the My projects list.
  function makeThumb() {
    return new Promise(resolve => {
      const k = Math.min(1, 480 / Math.max(image.W, image.H));
      const c = document.createElement('canvas');
      c.width = Math.round(image.W * k); c.height = Math.round(image.H * k);
      c.getContext('2d').drawImage(photo, 0, 0, c.width, c.height);
      c.toBlob(b => resolve(b), 'image/jpeg', 0.8);
    });
  }
  $('#modal-share').on('click', '[data-copy-from]', function () { copy($($(this).attr('data-copy-from')).val()); });

  $('#form-share').on('submit', async e => {
    e.preventDefault();
    const fd = new FormData();
    fd.append('title', $('#share-title').val());
    fd.append('project', JSON.stringify(snapshot()));
    fd.append('image', image.file, image.name);
    const thumb = await makeThumb().catch(() => null);
    if (thumb) fd.append('thumb', thumb, 'thumb.jpg');
    const $bar = $('#share-progress').removeClass('d-none').find('.progress-bar').css('width', '0%');
    $('#share-submit').prop('disabled', true);
    $('#share-error').text('');

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
      Object.assign(share, { id: res.id, token: res.editToken, version: res.version, canEdit: true, isOwner: true,
                             title: res.title, serverSnap: JSON.stringify(local), saving: false, dirty: false, error: null });
      setToken(res.id, res.editToken);
      history.replaceState(null, '', '?p=' + res.id);
      saveLocal();
      renderShareStatus();
      renderShareLinks();
      showShareForm(false);
      $('#share-view-url').trigger('focus').trigger('select');
      toast('Saved to My projects. Copy the links below to share it.', 'success');
      loadMe();
    }).fail(xhr => {
      if (xhr.status === 401) { setMe({ user: null }); showShareForm(true); }
      $('#share-error').text(apiError(xhr, 'Upload failed'));
      $('#share-progress').addClass('d-none');
      $('#share-submit').prop('disabled', false);
    });
  });

  /* ---------- Accounts ---------- */

  let me = null;             // the logged-in user {id, email, name, verified}, or null
  let quota = null;
  let authView = 'login';
  let resetToken = null;
  let afterAuth = null;      // what to do after logging in (e.g. reopen the Share dialog)
  const modalAuth = new bootstrap.Modal('#modal-auth');
  const modalAccount = new bootstrap.Modal('#modal-account');
  const modalProjects = new bootstrap.Modal('#modal-projects');

  function api(action, body, p) {
    return $.ajax({ url: API + '?action=' + action + (p ? '&p=' + encodeURIComponent(p) : ''), method: 'POST',
                    contentType: 'application/json', dataType: 'json', data: JSON.stringify(body || {}) });
  }

  function setMe(res) {
    me = res.user || null;
    quota = res.quota || null;
    $('#btn-login').toggleClass('d-none', !!me);
    $('#account-menu').toggleClass('d-none', !me);
    if (me) {
      $('#account-name').text(me.name || me.email.split('@')[0]);
      $('#account-email').text(me.email);
    }
  }

  function loadMe() {
    return $.ajax({ url: API, data: { action: 'me' }, dataType: 'json' }).done(setMe);
  }

  function showAuth(view) {
    authView = view;
    $('#auth-error, #auth-info').addClass('d-none');
    $('#btn-resend').addClass('d-none');
    $('#modal-auth form').removeClass('active');
    $('#form-' + view).addClass('active');
    $('#auth-title').text({ login: 'Log in', register: 'Create an account', forgot: 'Reset your password',
                            reset: 'Choose a new password' }[view]);
    if ($('#modal-auth').hasClass('show')) focusAuth(); else modalAuth.show();
  }
  function focusAuth() { $('#form-' + authView + ' input:not([hidden])').filter(function () { return !this.value; }).first().trigger('focus'); }
  function authMessage(kind, text) {
    $('#auth-error, #auth-info').addClass('d-none');
    $(kind === 'error' ? '#auth-error' : '#auth-info').text(text).removeClass('d-none');
  }
  // Disable a form's buttons while its request runs. If focus fell out of the dialog meanwhile
  // (a disabled or hidden button loses it), give it back so Esc and Tab keep working.
  function busy($form, request) {
    const $b = $form.find('button').prop('disabled', true);
    return request.always(() => {
      $b.prop('disabled', false);
      if (document.activeElement === document.body) $form.closest('.modal').trigger('focus');
    });
  }

  $('#modal-auth').on('shown.bs.modal', focusAuth)
    .on('hidden.bs.modal', () => { afterAuth = null; });
  $('#btn-login').on('click', () => showAuth('login'));
  $(document).on('click', '[data-auth-view]', function (e) {
    e.preventDefault();
    // Carry the email address over between the forms.
    const email = $('#modal-auth form.active input[type=email]').val();
    const view = $(this).attr('data-auth-view');
    if (email) $('#form-' + view + ' input[type=email]').val(email);
    showAuth(view);
  });
  $(document).on('click', '[data-auth-open]', function () {
    afterAuth = () => $('#btn-share').trigger('click');
    modalShare.hide();
    showAuth($(this).attr('data-auth-open'));
  });

  function loggedIn(res, message) {
    setMe(res);
    const next = afterAuth;
    afterAuth = null;
    modalAuth.hide();
    toast(message, 'success');
    // Reopen a project so ownership (edit rights) is picked up.
    if (share.id && !share.canEdit) setTimeout(() => location.reload(), 600);
    else if (next) $('#modal-auth').one('hidden.bs.modal', next);
  }

  $('#form-login').on('submit', function (e) {
    e.preventDefault();
    busy($(this), api('login', { email: $('#login-email').val(), password: $('#login-password').val() }))
      .done(res => { $('#login-password').val(''); loggedIn(res, `Welcome${res.user.name ? ', ' + res.user.name : ''}!`); })
      .fail(xhr => {
        authMessage('error', apiError(xhr, 'Could not log in'));
        $('#btn-resend').toggleClass('d-none', !(xhr.responseJSON && xhr.responseJSON.code === 'unverified'));
      });
  });
  $('#btn-resend').on('click', function () {
    busy($('#form-login'), api('resend-verification', { email: $('#login-email').val() }))
      .done(res => { authMessage('info', res.message); $('#btn-resend').addClass('d-none'); })
      .fail(xhr => authMessage('error', apiError(xhr, 'Could not send the email')));
  });
  $('#form-register').on('submit', function (e) {
    e.preventDefault();
    busy($(this), api('register', { name: $('#register-name').val(), email: $('#register-email').val(),
                                    password: $('#register-password').val() }))
      .done(res => {
        $('#login-email').val($('#register-email').val());
        $('#register-password').val('');
        showAuth('login');
        authMessage('info', res.message);
      })
      .fail(xhr => authMessage('error', apiError(xhr, 'Could not create the account')));
  });
  $('#form-forgot').on('submit', function (e) {
    e.preventDefault();
    busy($(this), api('forgot', { email: $('#forgot-email').val() }))
      .done(res => authMessage('info', res.message))
      .fail(xhr => authMessage('error', apiError(xhr, 'Could not send the email')));
  });
  $('#form-reset').on('submit', function (e) {
    e.preventDefault();
    busy($(this), api('reset', { token: resetToken, password: $('#reset-password').val() }))
      .done(res => { resetToken = null; loggedIn(res, 'Your password has been changed and you are logged in.'); })
      .fail(xhr => authMessage('error', apiError(xhr, 'Could not change the password')));
  });

  $('#btn-logout').on('click', () => {
    api('logout').always(() => {
      setMe({ user: null });
      toast('You are logged out.');
      if (share.id && share.isOwner && !share.token) setTimeout(() => location.reload(), 600);
    });
  });

  /* Account settings */

  function accountMessage(kind, text) {
    $('#acct-msg').removeClass('d-none alert-success alert-danger').addClass(kind === 'error' ? 'alert-danger' : 'alert-success').text(text);
  }
  $('#btn-account').on('click', () => {
    if (!me) return;
    $('#acct-email').text(me.email);
    $('#acct-username').val(me.email);
    $('#acct-name').val(me.name);
    $('#acct-current, #acct-new, #acct-delete-password').val('');
    $('#acct-delete-confirm').prop('checked', false);
    $('#acct-delete-btn').prop('disabled', true);
    $('#acct-msg').addClass('d-none');
    modalAccount.show();
  });
  $('#form-name').on('submit', function (e) {
    e.preventDefault();
    busy($(this), api('update-account', { name: $('#acct-name').val() }))
      .done(res => { setMe(res); accountMessage('info', 'Name saved.'); })
      .fail(xhr => accountMessage('error', apiError(xhr, 'Could not save')));
  });
  $('#form-password').on('submit', function (e) {
    e.preventDefault();
    busy($(this), api('change-password', { current: $('#acct-current').val(), password: $('#acct-new').val() }))
      .done(() => { $('#acct-current, #acct-new').val(''); accountMessage('info', 'Password changed.'); })
      .fail(xhr => accountMessage('error', apiError(xhr, 'Could not change the password')));
  });
  $('#acct-delete-confirm').on('change', function () { $('#acct-delete-btn').prop('disabled', !this.checked); });
  $('#form-delete-account').on('submit', function (e) {
    e.preventDefault();
    busy($(this), api('delete-account', { password: $('#acct-delete-password').val() }))
      .done(() => {
        setMe({ user: null });
        modalAccount.hide();
        toast('Your account and projects have been deleted.');
        if (share.id && share.isOwner) setTimeout(() => { location.href = location.pathname; }, 800);
      })
      .fail(xhr => accountMessage('error', apiError(xhr, 'Could not delete the account')));
  });

  /* My projects */

  const fmtMB = b => b >= 1e9 ? (b / 1073741824).toFixed(1) + ' GB' : (b / 1048576).toFixed(1) + ' MB';

  // Replacing the focused element (a renamed title, a deleted card) drops focus out of the dialog.
  function refocusProjects() {
    if (document.activeElement === document.body && $('#modal-projects').hasClass('show')) $('#modal-projects').trigger('focus');
  }

  function renderProjects(res) {
    setMe(res);
    const q = res.quota;
    $('#quota-text').text(`${q.projects} of ${q.maxProjects} projects · ${fmtMB(q.bytes)} of ${fmtMB(q.maxBytes)} used`);
    $('#quota-bar').css('width', Math.min(100, Math.max(q.bytes / q.maxBytes, q.projects / q.maxProjects) * 100) + '%');
    const $list = $('#project-list').empty();
    if (!res.projects.length) {
      $list.append('<p class="text-secondary">No projects yet. Open a photo and use <i class="bi bi-share"></i> <b>Share</b> to save it here.</p>');
      return;
    }
    res.projects.forEach(pr => {
      const updated = new Date(pr.updated).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      $list.append(`<div class="col-sm-6 col-lg-4" data-project="${esc(pr.id)}"><div class="card project-card h-100">
        ${pr.thumb ? `<img class="thumb" src="${esc(pr.thumb)}" alt="" loading="lazy">` : '<div class="thumb-empty"><i class="bi bi-image"></i></div>'}
        <div class="card-body p-2">
          <div class="card-title fw-semibold text-truncate mb-0" title="${esc(pr.title)}">${esc(pr.title)}</div>
          <div class="small text-secondary text-truncate">${esc(pr.imageName)} · ${fmtMB(pr.imageSize)}</div>
          <div class="small text-secondary">Updated ${esc(updated)}</div>
        </div>
        <div class="card-footer bg-transparent p-2 d-flex gap-1">
          <a class="btn btn-sm btn-primary" href="?p=${encodeURIComponent(pr.id)}">Open</a>
          <button class="btn btn-sm btn-outline-secondary" data-copy-link title="Copy view link"><i class="bi bi-link-45deg"></i></button>
          <button class="btn btn-sm btn-outline-secondary" data-rename title="Rename"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-outline-danger ms-auto" data-delete title="Delete"><i class="bi bi-trash"></i></button>
        </div></div></div>`);
    });
    // A preview that can't be made shows the placeholder instead.
    $list.find('img.thumb').on('error', function () {
      $(this).replaceWith('<div class="thumb-empty"><i class="bi bi-image"></i></div>');
    });
  }

  function loadProjects() {
    $('#project-list').html('<div class="text-secondary"><span class="spinner-border spinner-border-sm"></span> Loading…</div>');
    $.ajax({ url: API, data: { action: 'mine' }, dataType: 'json' })
      .done(res => { renderProjects(res); refocusProjects(); })
      .fail(xhr => $('#project-list').html(`<p class="text-danger">${esc(apiError(xhr, 'Could not load your projects'))}</p>`));
  }

  $('#btn-my-projects').on('click', () => { loadProjects(); modalProjects.show(); });

  $('#project-list')
    .on('click', '.card-title', function () { location.href = '?p=' + encodeURIComponent($(this).closest('[data-project]').attr('data-project')); })
    .on('click', '[data-copy-link]', function () { copy(shareUrl($(this).closest('[data-project]').attr('data-project'))); })
    .on('click', '[data-rename]', function () {
      const $col = $(this).closest('[data-project]'), id = $col.attr('data-project'), $title = $col.find('.card-title');
      const $input = $('<input type="text" class="form-control form-control-sm mb-1" maxlength="120">').val($title.text());
      $title.replaceWith($input);
      $input.trigger('focus').trigger('select');
      let done = false;
      const finish = save => {
        if (done) return;
        done = true;
        const title = $input.val();
        const put = t => {
          $input.replaceWith($('<div class="card-title fw-semibold text-truncate mb-0"></div>').text(t).attr('title', t));
          refocusProjects();
        };
        if (!save) { put($title.text()); return; }
        api('rename', { title }, id)
          .done(res => { put(res.title); if (share.id === id) share.title = res.title; })
          .fail(xhr => { put($title.text()); toast(apiError(xhr, 'Could not rename'), 'danger'); });
      };
      $input.on('keydown', e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') { e.stopPropagation(); finish(false); } })
            .on('blur', () => finish(true));
    })
    .on('click', '[data-delete]', function () {
      const $b = $(this), id = $b.closest('[data-project]').attr('data-project');
      if (!$b.hasClass('armed')) {   // first click asks, second click deletes
        $b.addClass('armed btn-danger').removeClass('btn-outline-danger').html('Delete?');
        setTimeout(() => $b.removeClass('armed btn-danger').addClass('btn-outline-danger').html('<i class="bi bi-trash"></i>'), 3000);
        return;
      }
      api('delete-project', {}, id)
        .done(() => {
          toast('Project deleted.');
          if (share.id === id) { setToken(id, null); leaveShare(); }
          loadProjects();
        })
        .fail(xhr => toast(apiError(xhr, 'Could not delete'), 'danger'));
    });

  /* ---------- OpenStreetMap overlay ---------- */

  // Widths and dashes are in screen pixels; the overlay keeps them constant while zooming.
  const OSM_STYLE = {
    water:    { fill: 'rgba(64, 170, 255, 0.25)', stroke: '#3fa9ff', width: 2 },
    waterway: { stroke: '#3fa9ff', width: 2 },
    building: { fill: 'rgba(255, 77, 196, 0.25)', stroke: '#ff4dc4', width: 1.5 },
    path:     { stroke: '#ffe066', width: 2, dash: [6, 4], halo: true },
    minor:    { stroke: '#ffffff', width: 3, halo: true },
    major:    { stroke: '#ffb347', width: 4, halo: true },
  };
  const OSM_LAYER_OF = { water: 'water', waterway: 'water', building: 'buildings', path: 'roads', minor: 'roads', major: 'roads' };
  const OSM_HALO = 'rgba(0, 0, 0, 0.45)';
  const osm = { on: false, loading: false, features: null, bbox: null, key: null,
                prefs: { roads: true, buildings: true, water: true, opacity: 0.9, export: false } };
  try { Object.assign(osm.prefs, JSON.parse(localStorage.getItem('nadir:osm') || '{}')); } catch (e) { /* ignore */ }

  function osmKey() { return geo.ok ? JSON.stringify(geo.H) : ''; }

  function photoBBox() {
    const lls = [[0, 0], [image.W, 0], [0, image.H], [image.W, image.H]].map(([x, y]) => geo.toLatLon(x, y));
    if (lls.some(ll => !ll)) return null;
    const lat = lls.map(ll => ll.lat), lon = lls.map(ll => ll.lon);
    return { s: Math.min(...lat), n: Math.max(...lat), w: Math.min(...lon), e: Math.max(...lon) };
  }

  function loadOsm() {
    const need = photoBBox();
    if (!need) return $.Deferred().reject().promise();
    const b = osm.bbox;
    if (osm.features && b.s <= need.s && b.w <= need.w && b.n >= need.n && b.e >= need.e) return $.Deferred().resolve().promise();
    osm.loading = true;
    updateOsmUi();
    return $.ajax({ url: API, dataType: 'json', timeout: 240000,
                    data: { action: 'osm', s: need.s.toFixed(5), w: need.w.toFixed(5), n: need.n.toFixed(5), e: need.e.toFixed(5) } })
      .done(res => {
        const [s, w, n, e] = res.bbox.split(',').map(Number);
        osm.features = res.features;
        osm.bbox = { s, w, n, e };
      })
      .fail(xhr => toast(apiError(xhr, 'Could not load map data'), 'warning'))
      .always(() => { osm.loading = false; updateOsmUi(); });
  }

  function toggleOsm() {
    if (osm.loading) return;
    if (osm.on) { osm.on = false; renderOsm(); updateOsmUi(); return; }
    if (!geo.ok) { toast('Add 2 or more control points first', 'warning'); return; }
    loadOsm().done(() => { osm.on = true; renderOsm(); updateOsmUi(); });
  }

  function resetOsm() {
    Object.assign(osm, { on: false, features: null, bbox: null, key: null });
    renderOsm();
    updateOsmUi();
  }

  function osmPathData(f) {
    let d = '';
    for (const [lat, lon] of f.g) {
      const p = geo.toPixel(lat, lon);
      if (!p) return null;
      d += (d ? 'L' : 'M') + p.x.toFixed(1) + ' ' + p.y.toFixed(1);
    }
    const [a, z] = [f.g[0], f.g[f.g.length - 1]];
    return f.g.length > 2 && a[0] === z[0] && a[1] === z[1] ? d + 'Z' : d;
  }

  // Features to draw, in drawing order (water below buildings below roads).
  function osmVisible() {
    const order = ['water', 'waterway', 'building', 'path', 'minor', 'major'];
    return order.map(c => ({ c, style: OSM_STYLE[c],
                             paths: osm.prefs[OSM_LAYER_OF[c]] ? osm.features.filter(f => f.c === c).map(osmPathData).filter(Boolean) : [] }))
                .filter(g => g.paths.length);
  }

  function renderOsm() {
    $(layerOsm).empty();
    osm.key = osmKey();
    const show = osm.on && osm.features && geo.ok;
    $('#osm-attrib').toggleClass('d-none', !show);
    if (!show) return;
    layerOsm.setAttribute('opacity', osm.prefs.opacity);
    for (const { style, paths } of osmVisible()) {
      const groups = [];
      if (style.halo) groups.push(svg('g', { fill: 'none', stroke: OSM_HALO, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
                                             'data-w': style.width + 2 }, layerOsm));
      groups.push(svg('g', { fill: 'none', stroke: style.stroke, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
                             'data-w': style.width, 'data-dash': style.dash ? style.dash.join(' ') : '' }, layerOsm));
      for (const d of paths) {
        groups.forEach((g, i) => svg('path', { d, fill: style.fill && d.endsWith('Z') && i === groups.length - 1 ? style.fill : 'none' }, g));
      }
    }
    scaleOsm();
  }

  function scaleOsm() {
    $(layerOsm).children('g').each(function () {
      this.setAttribute('stroke-width', this.getAttribute('data-w') / view.s);
      const dash = this.getAttribute('data-dash');
      if (dash) this.setAttribute('stroke-dasharray', dash.split(' ').map(v => v / view.s).join(' '));
    });
  }

  function drawOsmCanvas(ctx) {
    if (!osm.features || !geo.ok) return;
    const k = baseFont() / 20;   // screen pixel -> export pixel
    ctx.save();
    ctx.globalAlpha = osm.prefs.opacity;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const { style, paths } of osmVisible()) {
      const p2 = paths.map(d => [d, new Path2D(d)]);
      if (style.halo) {
        ctx.setLineDash([]); ctx.strokeStyle = OSM_HALO; ctx.lineWidth = (style.width + 2) * k;
        p2.forEach(([, p]) => ctx.stroke(p));
      }
      ctx.setLineDash(style.dash ? style.dash.map(v => v * k) : []);
      ctx.strokeStyle = style.stroke; ctx.lineWidth = style.width * k;
      p2.forEach(([d, p]) => {
        if (style.fill && d.endsWith('Z')) { ctx.fillStyle = style.fill; ctx.fill(p); }
        ctx.stroke(p);
      });
    }
    ctx.restore();
    // Attribution required by the OpenStreetMap licence.
    const fs = Math.round(baseFont() * 0.4), text = 'Map data © OpenStreetMap contributors';
    ctx.save();
    ctx.font = `600 ${fs}px ${FONT_FAMILY}`;
    const w = ctx.measureText(text).width + fs, h = fs * 1.6;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'; ctx.fillRect(image.W - w, image.H - h, w, h);
    ctx.fillStyle = '#333'; ctx.textBaseline = 'middle'; ctx.fillText(text, image.W - w + fs / 2, image.H - h / 2);
    ctx.restore();
  }

  function updateOsmUi() {
    $('#btn-osm').toggleClass('active', osm.on).prop('disabled', !geo.ok && !osm.on);
    $('#btn-osm-menu').prop('disabled', !geo.ok);
    $('#btn-osm .osm-icon').toggleClass('d-none', osm.loading);
    $('#btn-osm .spinner-border').toggleClass('d-none', !osm.loading);
    $('#osm-status').text(osm.loading ? 'Loading map data… The first load for a new place can take up to a minute.'
                          : osm.features ? `${osm.features.length} map features loaded.` : '');
    $('.osm-pref').each(function () {
      const v = osm.prefs[$(this).attr('data-pref')];
      if (this.type === 'checkbox') this.checked = !!v; else this.value = v;
    });
  }

  $('#btn-osm').on('click', toggleOsm);
  $('.osm-pref').on('input change', function () {
    osm.prefs[$(this).attr('data-pref')] = this.type === 'checkbox' ? this.checked : +this.value;
    try { localStorage.setItem('nadir:osm', JSON.stringify(osm.prefs)); } catch (e) { /* ignore */ }
    renderOsm();
  });

  /* ---------- Init ---------- */

  renderMethodSelect();
  renderAll();
  LABEL_FONT_READY.then(() => { if (image.loaded) renderLabels(); });
  setMode('pan');

  // Links from account emails: ?verify=TOKEN confirms the address, ?reset=TOKEN sets a new password.
  const params = new URLSearchParams(location.search);
  loadMe().always(() => {
    const verify = params.get('verify'), reset = params.get('reset');
    if (verify || reset) history.replaceState(null, '', location.pathname);
    if (verify) {
      api('verify', { token: verify })
        .done(res => { setMe(res); toast('Thanks, your email is confirmed and you are logged in.', 'success'); })
        .fail(xhr => toast(apiError(xhr, 'Could not confirm your email'), 'danger'));
    }
    if (reset) { resetToken = reset; showAuth('reset'); }
  });

  const sharedId = params.get('p');
  if (sharedId) {
    const m = location.hash.match(/edit=([0-9a-f]+)/);
    if (m) history.replaceState(null, '', '?p=' + encodeURIComponent(sharedId));   // keep the secret out of the address bar
    loadShare(sharedId, m && m[1]);
  }
});
