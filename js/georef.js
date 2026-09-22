/*
 * Georeferencing math for nadir images.
 *
 * Control points pair an image pixel (x right, y down) with a WGS-84
 * latitude/longitude. Lat/lon is projected onto a local east/north plane in
 * metres (equirectangular around the control points' centroid, which is
 * accurate to well under a centimetre across a drone photo), and a planar
 * transform pixel -> metres is fitted by least squares:
 *
 *   similarity  (>= 2 points)  scale + rotation + shift. The right model for a
 *                              true nadir shot over flat ground.
 *   affine      (>= 3 points)  also allows shear / unequal axis scale.
 *   projective  (>= 4 points)  homography; corrects a slightly tilted camera.
 *
 * Every model is stored as a 3x3 matrix so applying and inverting is shared.
 */
(function (root) {
  'use strict';

  const EARTH_R = 6371008.8;                 // mean Earth radius, metres
  const M_PER_DEG = Math.PI / 180 * EARTH_R;

  const METHODS = {
    similarity: { label: 'Similarity (scale + rotation)', min: 2, dof: 4 },
    affine:     { label: 'Affine',                        min: 3, dof: 6 },
    projective: { label: 'Projective (tilt correction)',  min: 4, dof: 8 },
  };

  /* ---------- Coordinate parsing & formatting ---------- */

  // Accepts the formats people actually paste:
  //   61.128514, 14.535017                (Google Maps)
  //   61.128514 14.535017 / 61.128514;14.535017
  //   61°7'42.65"N 14°32'6.06"E           (Google Maps / EXIF style DMS)
  //   N 61° 7.7108' E 14° 32.101'         (degrees + decimal minutes)
  //   61 7 42.65 N, 14 32 6.06 E
  // Returns {lat, lon} or null.
  function parseLatLon(input) {
    if (input == null) return null;
    const s = String(input).trim()
      .replace(/[()\[\]]/g, ' ')
      .replace(/[−–]/g, '-');      // unicode minus / en dash
    if (!s) return null;

    const plain = s.match(/^([-+]?\d+(?:\.\d+)?)\s*[,;\s]\s*([-+]?\d+(?:\.\d+)?)$/);
    if (plain) return validate(+plain[1], +plain[2]);

    // Tokenise into numbers and hemisphere letters, in order.
    const tokens = [];
    const re = /([NSEWnsew])(?![a-z])|([-+]?\d+(?:\.\d+)?)/g;
    let m;
    while ((m = re.exec(s))) {
      if (m[1]) tokens.push({ hemi: m[1].toUpperCase() });
      else tokens.push({ num: parseFloat(m[2]) });
    }
    const nums = tokens.filter(t => 'num' in t);
    const hemis = tokens.filter(t => 'hemi' in t);
    if (nums.length < 2) return null;

    let groups;
    if (hemis.length === 2) {
      // Letters either trail ("61 7 42 N 14 32 6 E") or lead ("N61 7 42 E14 32 6").
      const trailing = !('hemi' in tokens[0]);
      groups = [];
      let cur = { nums: [] };
      for (const t of tokens) {
        if ('num' in t) { cur.nums.push(t.num); continue; }
        if (trailing) { cur.hemi = t.hemi; groups.push(cur); cur = { nums: [] }; }
        else { if (cur.hemi || cur.nums.length) groups.push(cur); cur = { nums: [], hemi: t.hemi }; }
      }
      if (!trailing) groups.push(cur);
      if (groups.length !== 2) return null;
    } else if (hemis.length === 0 && nums.length % 2 === 0 && nums.length <= 6) {
      const half = nums.length / 2;
      groups = [{ nums: nums.slice(0, half).map(t => t.num) },
                { nums: nums.slice(half).map(t => t.num) }];
    } else {
      return null;
    }

    const vals = groups.map(g => {
      if (g.nums.length < 1 || g.nums.length > 3) return NaN;
      const [d, mi = 0, se = 0] = g.nums;
      if (mi < 0 || mi >= 60 || se < 0 || se >= 60) return NaN;
      let v = Math.abs(d) + mi / 60 + se / 3600;
      if (d < 0 || g.hemi === 'S' || g.hemi === 'W') v = -v;
      return v;
    });
    if (vals.some(isNaN)) return null;

    let lat = vals[0], lon = vals[1];
    const h0 = groups[0].hemi, h1 = groups[1].hemi;
    if ((h0 === 'E' || h0 === 'W') && (h1 === 'N' || h1 === 'S')) { lat = vals[1]; lon = vals[0]; }
    else if (h0 && h1 && isLat(h0) === isLat(h1)) return null;
    return validate(lat, lon);

    function isLat(h) { return h === 'N' || h === 'S'; }
  }

  function validate(lat, lon) {
    if (!isFinite(lat) || !isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon };
  }

  function formatDecimal(ll, digits) {
    const d = digits == null ? 6 : digits;
    return ll.lat.toFixed(d) + ', ' + ll.lon.toFixed(d);
  }

  function formatDMS(ll) {
    return part(ll.lat, 'N', 'S') + ' ' + part(ll.lon, 'E', 'W');
    function part(v, pos, neg) {
      const a = Math.abs(v);
      let d = Math.floor(a), m = Math.floor((a - d) * 60);
      let s = ((a - d) * 60 - m) * 60;
      if (s >= 59.995) { s = 0; m += 1; }
      if (m >= 60) { m = 0; d += 1; }
      return d + '°' + m + '\'' + s.toFixed(2) + '"' + (v < 0 ? neg : pos);
    }
  }

  /* ---------- Local metric frame ---------- */

  function makeFrame(points) {
    const lat0 = points.reduce((a, p) => a + p.lat, 0) / points.length;
    const lon0 = points.reduce((a, p) => a + p.lon, 0) / points.length;
    const cos0 = Math.cos(lat0 * Math.PI / 180);
    return {
      toLocal: (lat, lon) => [(lon - lon0) * M_PER_DEG * cos0, (lat - lat0) * M_PER_DEG],
      toLatLon: (e, n) => ({ lat: lat0 + n / M_PER_DEG, lon: lon0 + e / (M_PER_DEG * cos0) }),
    };
  }

  /* ---------- Linear algebra ---------- */

  // Solve M x = b (M is n x n, arrays of rows) with partial pivoting.
  function solve(M, b) {
    const n = b.length;
    const A = M.map((row, i) => row.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null;
      [A[c], A[p]] = [A[p], A[c]];
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
      }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) {
      let s = A[r][n];
      for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
      x[r] = s / A[r][r];
    }
    return x;
  }

  // Least squares: rows of A (m x n), b (m) -> x (n) via normal equations.
  function leastSquares(rows, b) {
    const n = rows[0].length;
    const AtA = Array.from({ length: n }, () => new Array(n).fill(0));
    const Atb = new Array(n).fill(0);
    rows.forEach((r, i) => {
      for (let j = 0; j < n; j++) {
        Atb[j] += r[j] * b[i];
        for (let k = 0; k < n; k++) AtA[j][k] += r[j] * r[k];
      }
    });
    return solve(AtA, Atb);
  }

  function mul3(A, B) {
    return A.map((row, i) => [0, 1, 2].map(j => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
  }

  function inv3(M) {
    const [[a, b, c], [d, e, f], [g, h, i]] = M;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-18) return null;
    return [
      [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
      [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
      [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
    ];
  }

  function apply(H, x, y) {
    const w = H[2][0] * x + H[2][1] * y + H[2][2];
    if (Math.abs(w) < 1e-12) return null;
    return [(H[0][0] * x + H[0][1] * y + H[0][2]) / w,
            (H[1][0] * x + H[1][1] * y + H[1][2]) / w];
  }

  // Hartley normalisation: centroid to origin, mean distance sqrt(2).
  function normaliser(pts) {
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const md = pts.reduce((a, p) => a + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length;
    const s = md > 0 ? Math.SQRT2 / md : 1;
    return [[s, 0, -s * cx], [0, s, -s * cy], [0, 0, 1]];
  }

  /* ---------- Model fitting (in normalised coordinates) ---------- */

  function fitSimilarityN(src, dst) {
    // Image y points down while north points up, so the map is a rotation +
    // scale composed with a reflection:  E = a*x + b*y,  N = b*x - a*y
    // (both point sets are centred by the normaliser, so no translation).
    let sa = 0, sb = 0, ss = 0;
    src.forEach(([x, y], i) => {
      const [E, N] = dst[i];
      const yu = -y;
      sa += E * x + N * yu;
      sb += N * x - E * yu;
      ss += x * x + yu * yu;
    });
    if (ss < 1e-12) return null;
    const a = sa / ss, b = sb / ss;
    return [[a, b, 0], [b, -a, 0], [0, 0, 1]];
  }

  function fitAffineN(src, dst) {
    const rows = src.map(([x, y]) => [x, y, 1]);
    const e = leastSquares(rows, dst.map(d => d[0]));
    const n = leastSquares(rows, dst.map(d => d[1]));
    if (!e || !n) return null;
    return [e, n, [0, 0, 1]];
  }

  function fitProjectiveN(src, dst) {
    const rows = [], b = [];
    src.forEach(([x, y], i) => {
      const [E, N] = dst[i];
      rows.push([x, y, 1, 0, 0, 0, -x * E, -y * E]); b.push(E);
      rows.push([0, 0, 0, x, y, 1, -x * N, -y * N]); b.push(N);
    });
    const h = leastSquares(rows, b);
    if (!h) return null;
    return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
  }

  /*
   * Fit a model to control points [{x, y, lat, lon}].
   * Returns {ok:false, error} or a georeference object with
   * toLatLon(x, y), toPixel(lat, lon), residuals, rms, gsd, bearing.
   */
  function fit(points, method, imageCenter) {
    const spec = METHODS[method];
    if (!spec) return { ok: false, error: 'Unknown method' };
    if (points.length < spec.min) {
      return { ok: false, needed: spec.min - points.length,
               error: `Needs ${spec.min} control points (${points.length} so far)` };
    }
    const frame = makeFrame(points);
    const src = points.map(p => [p.x, p.y]);
    const dst = points.map(p => frame.toLocal(p.lat, p.lon));
    const Ts = normaliser(src), Td = normaliser(dst);
    const srcN = src.map(p => apply(Ts, p[0], p[1]));
    const dstN = dst.map(p => apply(Td, p[0], p[1]));

    const Hn = method === 'similarity' ? fitSimilarityN(srcN, dstN)
             : method === 'affine' ? fitAffineN(srcN, dstN)
             : fitProjectiveN(srcN, dstN);
    const TdInv = inv3(Td);
    const H = Hn && TdInv ? mul3(TdInv, mul3(Hn, Ts)) : null;
    const Hinv = H && inv3(H);
    const degenerate = !H || !Hinv || H.flat().some(v => !isFinite(v));
    if (degenerate) {
      return { ok: false, error: 'Control points are too close together or in a line' };
    }

    const residuals = points.map((p, i) => {
      const q = apply(H, p.x, p.y);
      return q ? Math.hypot(q[0] - dst[i][0], q[1] - dst[i][1]) : Infinity;
    });
    const redundant = points.length * 2 > spec.dof;
    const rms = redundant
      ? Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / points.length) : null;

    // Ground sample distance and heading, measured at the image centre.
    const [cx, cy] = imageCenter || [src[0][0], src[0][1]];
    const c0 = apply(H, cx, cy), cxp = apply(H, cx + 1, cy), cyp = apply(H, cx, cy - 1);
    let gsd = null, bearing = null;
    if (c0 && cxp && cyp) {
      gsd = (Math.hypot(cxp[0] - c0[0], cxp[1] - c0[1]) + Math.hypot(cyp[0] - c0[0], cyp[1] - c0[1])) / 2;
      bearing = (Math.atan2(cyp[0] - c0[0], cyp[1] - c0[1]) * 180 / Math.PI + 360) % 360;
    }

    return {
      ok: true, method, H, Hinv, residuals, rms, redundant, gsd, bearing,
      toLatLon(x, y) {
        const q = apply(H, x, y);
        return q ? frame.toLatLon(q[0], q[1]) : null;
      },
      toPixel(lat, lon) {
        const [e, n] = frame.toLocal(lat, lon);
        const q = apply(Hinv, e, n);
        return q ? { x: q[0], y: q[1] } : null;
      },
    };
  }

  // Area (m²) and perimeter (m) of a polygon given as [{lat, lon}, ...].
  function polygonMetrics(latlons) {
    if (latlons.length < 3) return { area: 0, perimeter: 0 };
    const frame = makeFrame(latlons);
    const pts = latlons.map(p => frame.toLocal(p.lat, p.lon));
    let twice = 0, perimeter = 0;
    pts.forEach(([x0, y0], i) => {
      const [x1, y1] = pts[(i + 1) % pts.length];
      twice += x0 * y1 - x1 * y0;
      perimeter += Math.hypot(x1 - x0, y1 - y0);
    });
    return { area: Math.abs(twice) / 2, perimeter };
  }

  function compass(deg) {
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return names[Math.round(deg / 45) % 8];
  }

  const api = { METHODS, parseLatLon, formatDecimal, formatDMS, fit, compass, polygonMetrics };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Georef = api;
})(this);
