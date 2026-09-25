# Nadir — georeferencing drone photos

Static web app (HTML, jQuery 3.7, Bootstrap 5.3, Bootstrap Icons, Inter web font, all from CDNs; no build step) plus one PHP endpoint. Load a nadir (straight-down) drone photo, calibrate it with control points, then query coordinates, add labels, areas and measurements, overlay OpenStreetMap, show the user's live GPS position, export a labelled JPEG and share projects by link.

## Files

- `index.html`: all markup: toolbar, viewer, sidebar, modals (control point, label/area/measure, share, help).
- `js/georef.js`: pure maths, usable from Node (`module.exports`) for tests. It covers coordinate parsing (decimal, DMS, degrees + minutes), a local equirectangular frame, similarity/affine/projective fits as 3×3 matrices with Hartley normalisation, `polygonMetrics`, `pathMetrics`, and a 16-point `compass`.
- `js/app.js`: everything else, in one jQuery closure, with sections marked `/* ---------- Name ---------- */`.
- `css/app.css`
- `api.php`: shared projects and the OSM proxy (see below).
- `.user.ini`: raises PHP-FPM upload limits to 60 MB for the app directory.
- `Backa-2026-06-21.jpg`: the sample photo, 4022×3017, DJI Mini 4 Pro, over Bäcka by Orsasjön. It is in git. `backa-2026-09-23.jpg` is the user's newer photo and is untracked.

## Model and conventions (app.js)

- Image pixel coordinates are x right and y down. Everything is stored in pixels; lat/lon is always derived through `geo` (the current fit), so recalibrating updates everything.
- `state` = { controlPoints, queries, labels, areas, measures, method }. `snapshot()`/`restore()` handle (de)serialisation; the project JSON is the same object.
- Labels (point labels, area labels, measurement labels) share `labelGeom()` → `drawLabelSvg()` (screen) and `drawLabelCanvas()` (export). The body is sized from the *rendered* SVG text width (`getComputedTextLength`). Canvas measuring disagreed in Safari and text overflowed. Outlines are drawn first (at double width), then fills on top, so no line shows where the pointer meets the body.
- SVG layers in `#overlay`: `layer-osm` (clipped to the image), `layer-areas`, `layer-measures`, `layer-labels`, `layer-markers`. Markers and handles keep a constant on-screen size via `scale(1/view.s)`, and are re-rendered on zoom. OSM stroke widths are updated on zoom by `scaleOsm()`.
- Pointer handling: one `ptr` for click vs drag (4 px threshold), `touches`/`pinch` for two-finger zoom. `data-drag` types: cp, query, label, anchor, area, arealabel, measure, measurelabel, vertex, midpoint (`data-kind` = area|measure). Clicking an area or measure body shows its info (and dragging on it pans); in non-Pan modes those bodies are `pointer-events: none`.
- Info bubble: a single `bubble = {type: 'query'|'area'|'measure', id}`.
- Modes: pan, cp, query, label, area, measure. Shortcuts: P/Esc, C, Q, L, A, M, +/−/0. While drawing (`drawing` array), Enter finishes, Backspace undoes and Esc cancels.
- Persistence: localStorage per image (`nadir:v1:name:size:WxH`) or per share (`nadir:share:ID` with the server `base` version). Edit tokens live in `nadir:tokens` and OSM prefs in `nadir:osm`. localStorage is per origin, so monsym.se and nadirlab.online do not share it.

## Server (api.php)

- `create` (password-protected multipart upload), `get`, `image`, `update` (the X-Edit-Token header plus `baseVersion` gives optimistic concurrency, answering 409 on conflict), `osm`.
- Data lives outside the web root in `/var/lib/nadir` (owned by www-data, 750):
  - `config.php` holds only the upload password hash; see README for changing it.
  - `projects/<10-char id>/` holds meta.json (with the sha256 of the edit token), project.json, the image, and history/.
  - `osm/` is the Overpass cache.
- Share links: view `?p=ID`, edit `?p=ID#edit=TOKEN`. The token is stripped from the address bar and remembered locally.
- OSM proxy: the bbox is snapped outwards to a 0.005° grid, with a max span of 0.05° lat. It tries overpass-api.de, then the mail.ru mirror, then private.coffee, trims geometry to near the photo and caches for 30 days. Overpass rejects requests without a proper User-Agent (406), and the public servers are often slow or return 504.
- Server PHP is 8.3 (no curl extension; uses stream contexts). Local PHP is 8.5, so avoid 8.4+-only functions and don't use `$http_response_header`.

## Hosting (hetzner3 = 65.108.78.77, ssh config hosts `hetzner3` (root) / `hetzner3-kjell`)

- Apache with PHP-FPM (global `php8.3-fpm.conf`), `AllowOverride None`, Let's Encrypt via `certbot --apache`, which creates `*-le-ssl.conf` and renews through `certbot.timer`.
- **nadirlab.online** (primary, set up 2026-09-26): docroot `/var/www/nadirlab`, site `nadirlab.conf`, logs `nadirlab-*.log`. The domain is registered at Namecheap.
- **monsym.se/nadir** (original location): docroot `/var/www/monsym/nadir`. It shares `/var/lib/nadir` with nadirlab.online.
- Deploy: `rsync -rt index.html api.php .user.ini css js hetzner3:/var/www/nadirlab/`, then `chown -R root:root` and chmod 644/755 on the server. The Mac's rsync is openrsync, which has no `--chmod`.

## Testing

No test suite in the repo. Verification so far used Playwright (`playwright-core`, installed in the session scratchpad) driving system Chrome (`executablePath: /Applications/Google Chrome.app/...`) and Playwright WebKit (Safari engine, including `devices['iPhone 13']`), against `python3 -m http.server` or, for api.php, `NADIR_DATA=<dir> php -S localhost:PORT`. The tests use a synthetic calibration: 8 cm/px, image top facing 200°, centred on the EXIF position 61.128514, 14.535017.

Gotchas seen in tests:
- **Modals:** wait for `.modal-backdrop` to be detached before clicking the image, or the click lands on the fading backdrop.
- **Modifiers:** `mouse.click` ignores `modifiers`; hold Alt with `keyboard.down('Alt')`.
- **WebKit clicks:** at 25 % zoom one screen pixel is 4 image pixels, so WebKit results can be off by a pixel (for example 3,222 m² vs 3,200 m²).
- **Label selectors:** a label's shape appears twice (outline and fill), so use `.last()` in locators.

## Workflow so far

- GitHub: `git@github.com:kjepo/nadir.git`, branch `main`. Each feature has been committed, pushed and deployed once verified.
