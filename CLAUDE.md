# Nadir — georeferencing drone photos

Static web app (HTML, jQuery 3.7, Bootstrap 5.3, Bootstrap Icons, Inter web font, all from CDNs; no build step) plus one PHP endpoint. Load a nadir (straight-down) drone photo, calibrate it with control points, then query coordinates, add labels, areas and measurements, overlay OpenStreetMap, show the user's live GPS position, export a labelled JPEG and share projects by link.

## Files

- `index.html`: all markup: toolbar, viewer, sidebar, modals (control point, label/area/measure, share, help).
- `js/georef.js`: pure maths, usable from Node (`module.exports`) for tests. It covers coordinate parsing (decimal, DMS, degrees + minutes), a local equirectangular frame, similarity/affine/projective fits as 3×3 matrices with Hartley normalisation, `polygonMetrics`, `pathMetrics`, and a 16-point `compass`.
- `js/app.js`: everything else, in one jQuery closure, with sections marked `/* ---------- Name ---------- */`.
- `css/app.css`
- `api.php`: router for all server actions. The code is in `server/`: `common.php` (helpers, config, SQLite and migrations, rate limiting), `mail.php` (SES API v2 with a hand-rolled SigV4 checked against AWS test vectors, or a log file), `auth.php` (accounts and sessions), `projects.php`, `osm.php`, and `cli.php` (admin commands). Apache denies direct access to `server/`.
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

## Server (api.php + server/)

- Every call is `api.php?action=NAME`. POSTs must send the header `X-Nadir: 1` (a CSRF guard; the client sets it via `$.ajaxSetup`).
- **Accounts:** open sign-up with email confirmation. Sessions are a random token in the HttpOnly, Secure, SameSite=Lax cookie `nadir_session` (30 days), and only the sha256 is stored. One-time tokens (verify 48 h, reset 60 min) are also stored hashed. Logins are rate-limited per email and per IP, and emails per address and per IP. Register and forgot-password give the same answer whether or not an account exists.
- **Projects:** logged-in users only can create; the upload password is gone on nadirlab.online. Projects are indexed in the `projects` table with `owner_id`. The owner can always edit, rename, delete, and create a new edit link. The edit token still works for anyone who has it, and `get` returns `isOwner`, `canEdit` and `tokenValid`. Quotas per account are 1 GB and 100 projects, configurable. Deleting an account deletes its projects.
- **Data:** everything lives in `/var/lib/nadir` (owned by www-data, 750): `config.php` (see README; its old `password_hash` key is only used by the monsym.se copy), `nadir.sqlite`, `projects/<id>/`, `osm/`, and `mail.log` (the log mail driver) plus `mail-errors.log`. Files there must stay writable by www-data: an earlier `: > mail.log` run as root broke mail logging until it was chowned.
- **Email:** live since 2026-09-26 through Amazon SES in `eu-west-2` (London), with the account out of the sandbox. The sender is `Nadir Lab <no-reply@nadirlab.online>`. The domain identity is verified with Easy DKIM (3 CNAMEs at Namecheap) plus a DMARC TXT (`v=DMARC1; p=none;`). IAM user `nadirlab-ses` is limited to `ses:SendEmail` from that address, and its key lives in `/var/lib/nadir/config.php` (root:www-data 640), never in git.
- **Existing projects:** on first run, projects made before accounts were indexed without an owner. Hand them to an account with `sudo -u www-data php server/cli.php assign-unowned EMAIL`.
- **OSM proxy:** the bbox is snapped outwards to a 0.005° grid, with a max span of 0.05° lat. It tries overpass-api.de, then the mail.ru mirror, then private.coffee, trims geometry to near the photo and caches for 30 days. Overpass rejects requests without a proper User-Agent (406), and the public servers are often slow or return 504.
- **PHP versions:** the server has PHP 8.3 with `php8.3-sqlite3` and `php8.3-mbstring`, installed 2026-09-26, and no curl extension (it uses stream contexts). Local PHP is 8.5, so avoid 8.4+-only functions, don't use `$http_response_header`, and remember that local PHP has extensions the server may not.

## Hosting (hetzner3 = 65.108.78.77, ssh config hosts `hetzner3` (root) / `hetzner3-kjell`)

- Apache with PHP-FPM (global `php8.3-fpm.conf`), `AllowOverride None`, Let's Encrypt via `certbot --apache`, which creates `*-le-ssl.conf` and renews through `certbot.timer`.
- **nadirlab.online** (primary, live since 2026-09-26): docroot `/var/www/nadirlab`, sites `nadirlab.conf` (HTTP, 301 to https://nadirlab.online) and `nadirlab-le-ssl.conf` (HTTPS; www redirects to the bare domain). Let's Encrypt cert name `nadirlab.online` covers both names. Logs are `nadirlab-*.log`. DNS is at Namecheap BasicDNS: `@` A 65.108.78.77, `www` CNAME nadirlab.online.
- **monsym.se/nadir** (original location): docroot `/var/www/monsym/nadir`. It still runs the old single-file api.php (password-based sharing, no accounts) and shares `/var/lib/nadir/projects` with nadirlab.online. Keep it running unchanged for now: clients have links to it (decided 2026-09-26). Don't redirect it or remove `password_hash` from config.php without asking.
- Deploy: `rsync -rt index.html api.php .user.ini css js server hetzner3:/var/www/nadirlab/`, then `chown -R root:root` and chmod 644/755 on the server. The Mac's rsync is openrsync, which has no `--chmod`.

## Testing

No test suite in the repo. Verification so far used Playwright (`playwright-core`, installed in the session scratchpad) driving system Chrome (`executablePath: /Applications/Google Chrome.app/...`) and Playwright WebKit (Safari engine, including `devices['iPhone 13']`), against `python3 -m http.server` or, for api.php, `NADIR_DATA=<dir> php -S localhost:PORT`. The tests use a synthetic calibration: 8 cm/px, image top facing 200°, centred on the EXIF position 61.128514, 14.535017.

Account flows were tested the same way: the mail log driver writes to `NADIR_DATA/mail.log`, and tests read the `?verify=` and `?reset=` links from it.

Gotchas seen in tests:
- **Modals:** wait for `.modal-backdrop` to be detached before clicking the image, or the click lands on the fading backdrop.
- **Modifiers:** `mouse.click` ignores `modifiers`; hold Alt with `keyboard.down('Alt')`.
- **WebKit clicks:** at 25 % zoom one screen pixel is 4 image pixels, so WebKit results can be off by a pixel (for example 3,222 m² vs 3,200 m²).
- **Label selectors:** a label's shape appears twice (outline and fill), so use `.last()` in locators.

## Workflow so far

- GitHub: `git@github.com:kjepo/nadir.git`, branch `main`. Each feature has been committed, pushed and deployed once verified.
