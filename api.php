<?php
/*
 * Shared projects for the nadir georeferencer.
 *
 *   POST api.php?action=create           multipart: password, image, project  -> {id, editToken, version}
 *   GET  api.php?action=get&p=ID         [X-Edit-Token]  -> {id, version, updated, image, project, canEdit}
 *   GET  api.php?action=image&p=ID       the uploaded image
 *   POST api.php?action=update&p=ID      X-Edit-Token, JSON {baseVersion, project} -> {version, updated}
 *   GET  api.php?action=osm&s=&w=&n=&e=  OpenStreetMap roads, buildings and water in a small area
 *                                        (fetched from Overpass, cached in DATA_DIR/osm)
 *
 * Data lives outside the web root (DATA_DIR), one directory per project:
 *   meta.json  (version, image info, sha256 of the edit token)
 *   project.json, image.<ext>, history/<version>.json (previous versions)
 * DATA_DIR/config.php returns ['password_hash' => password_hash('...', PASSWORD_DEFAULT)].
 */
declare(strict_types=1);

define('DATA_DIR', getenv('NADIR_DATA') ?: '/var/lib/nadir');
const MAX_IMAGE_BYTES = 60 * 1024 * 1024;
const MAX_PROJECT_BYTES = 2 * 1024 * 1024;
const KEEP_HISTORY = 30;
const IMAGE_TYPES = [IMAGETYPE_JPEG => ['jpg', 'image/jpeg'],
                     IMAGETYPE_PNG  => ['png', 'image/png'],
                     IMAGETYPE_WEBP => ['webp', 'image/webp']];

header('X-Content-Type-Options: nosniff');

function fail(int $code, string $msg, array $extra = []): never {
    http_response_code($code);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $msg] + $extra);
    exit;
}

function respond(array $data): never {
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function requirePost(): void {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'POST required');
}

function readJson(string $path): array {
    $data = json_decode((string) @file_get_contents($path), true);
    if (!is_array($data)) fail(500, 'Corrupt project data');
    return $data;
}

function writeAtomic(string $path, string $data): void {
    $tmp = $path . '.tmp' . bin2hex(random_bytes(4));
    if (file_put_contents($tmp, $data) === false || !rename($tmp, $path)) fail(500, 'Could not write project');
}

function encode(mixed $data): string {
    return json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
}

function projectDir(): string {
    $id = $_GET['p'] ?? '';
    if (!is_string($id) || !preg_match('/^[A-Za-z0-9]{10}$/', $id)) fail(400, 'Bad project id');
    $dir = DATA_DIR . "/projects/$id";
    if (!is_file("$dir/meta.json")) fail(404, 'Shared project not found');
    return $dir;
}

function canEdit(array $meta): bool {
    $token = $_SERVER['HTTP_X_EDIT_TOKEN'] ?? '';
    return is_string($token) && $token !== '' && hash_equals($meta['tokenHash'], hash('sha256', $token));
}

function validProject(mixed $project): array {
    if (!is_array($project)) fail(400, 'Project must be a JSON object');
    if (strlen(json_encode($project)) > MAX_PROJECT_BYTES) fail(413, 'Project data too large');
    return $project;
}

function randomId(int $len): string {
    $alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $s = '';
    for ($i = 0; $i < $len; $i++) $s .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    return $s;
}

function uploadError(int $code): string {
    return match ($code) {
        UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => 'Image is too large (max ' . (MAX_IMAGE_BYTES >> 20) . ' MB)',
        UPLOAD_ERR_PARTIAL => 'Upload was interrupted',
        UPLOAD_ERR_NO_FILE => 'No image received',
        default => 'Upload failed (code ' . $code . ')',
    };
}

/*
 * OpenStreetMap features for a bounding box, reduced to what the overlay draws:
 * [{c: category, n: name, g: [[lat, lon], ...]}]. The box is snapped outwards to a
 * grid so nearby requests share a cache entry, and its size is capped.
 */
const OSM_GRID = 0.005;
const OSM_MAX_SPAN = 0.05;
const OSM_TTL = 30 * 86400;
const OVERPASS = ['https://overpass-api.de/api/interpreter',
                  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
                  'https://overpass.private.coffee/api/interpreter'];

function osmCategory(array $tags): ?string {
    $hw = $tags['highway'] ?? null;
    if ($hw !== null) {
        if (preg_match('/^(motorway|trunk|primary|secondary|tertiary)(_link)?$/', $hw)) return 'major';
        if (in_array($hw, ['residential', 'unclassified', 'service', 'living_street', 'road'], true)) return 'minor';
        if (in_array($hw, ['track', 'path', 'footway', 'cycleway', 'bridleway', 'steps', 'pedestrian'], true)) return 'path';
        return null;
    }
    if (isset($tags['building'])) return 'building';
    if (($tags['natural'] ?? '') === 'water' || ($tags['natural'] ?? '') === 'coastline') return 'water';
    if (isset($tags['waterway'])) return 'waterway';
    return null;
}

// Trim a line to the part near the box (plus one point either side), so a big lake
// contributes only its nearby shoreline. Returns null if it doesn't come near.
function osmTrim(array $geometry, array $b): ?array {
    $ms = ($b['n'] - $b['s']) / 2; $mw = ($b['e'] - $b['w']) / 2;
    $pts = array_map(fn($p) => [round($p['lat'], 6), round($p['lon'], 6)], $geometry);
    $first = $last = null;
    foreach ($pts as $i => [$lat, $lon]) {
        if ($lat >= $b['s'] - $ms && $lat <= $b['n'] + $ms && $lon >= $b['w'] - $mw && $lon <= $b['e'] + $mw) {
            $first ??= $i;
            $last = $i;
        }
    }
    if ($first === null) return null;
    $from = max(0, $first - 1);
    return array_slice($pts, $from, min(count($pts) - 1, $last + 1) - $from + 1);
}

function osmFeatures(array $elements, array $b): array {
    $out = [];
    $add = function (string $cat, string $name, array $geometry) use (&$out, $b) {
        $g = osmTrim($geometry, $b);
        if ($g && count($g) > 1) $out[] = ['c' => $cat, 'n' => $name, 'g' => $g];
    };
    foreach ($elements as $e) {
        $cat = osmCategory($e['tags'] ?? []);
        if (!$cat) continue;
        $name = $e['tags']['name'] ?? '';
        if ($e['type'] === 'way' && !empty($e['geometry'])) {
            $add($cat, $name, $e['geometry']);
        } elseif ($e['type'] === 'relation') {
            // Multipolygon members are drawn as separate outlines.
            foreach ($e['members'] ?? [] as $m) {
                if (!empty($m['geometry'])) $add($cat, $name, $m['geometry']);
            }
        }
    }
    return $out;
}

$action = $_GET['action'] ?? '';

if ($action === 'osm') {
    $b = [];
    foreach (['s', 'w', 'n', 'e'] as $k) {
        if (!isset($_GET[$k]) || !is_numeric($_GET[$k])) fail(400, 'Bad bounding box');
        $b[$k] = (float) $_GET[$k];
    }
    $b['s'] = floor($b['s'] / OSM_GRID) * OSM_GRID; $b['w'] = floor($b['w'] / OSM_GRID) * OSM_GRID;
    $b['n'] = ceil($b['n'] / OSM_GRID) * OSM_GRID;  $b['e'] = ceil($b['e'] / OSM_GRID) * OSM_GRID;
    if ($b['n'] <= $b['s'] || $b['e'] <= $b['w'] || $b['s'] < -90 || $b['n'] > 90 || $b['w'] < -180 || $b['e'] > 180
        || $b['n'] - $b['s'] > OSM_MAX_SPAN || $b['e'] - $b['w'] > 2 * OSM_MAX_SPAN) {
        fail(400, 'Area too large for the map overlay');
    }
    $bbox = sprintf('%.3f,%.3f,%.3f,%.3f', $b['s'], $b['w'], $b['n'], $b['e']);
    $cacheDir = DATA_DIR . '/osm';
    $cache = "$cacheDir/" . str_replace(',', '_', $bbox) . '.json';
    if (is_file($cache) && filemtime($cache) > time() - OSM_TTL) {
        header('X-Cache: hit');
        header('Content-Type: application/json');
        header('Cache-Control: public, max-age=86400');
        readfile($cache);
        exit;
    }

    set_time_limit(200);
    $query = "[out:json][timeout:60];("
           . "way[highway]($bbox);way[building]($bbox);way[natural=water]($bbox);relation[natural=water]($bbox);"
           . "way[waterway]($bbox);way[natural=coastline]($bbox););out geom;";
    $data = null;
    foreach (OVERPASS as $url) {
        $ctx = stream_context_create(['http' => [
            'method' => 'POST', 'timeout' => 60, 'ignore_errors' => true,
            'header' => "Content-Type: application/x-www-form-urlencoded\r\nUser-Agent: nadir-georeferencer (https://monsym.se/nadir/)\r\n",
            'content' => http_build_query(['data' => $query]),
        ]]);
        // Busy servers answer with an HTML error page; only a JSON result with elements counts.
        $json = json_decode((string) @file_get_contents($url, false, $ctx), true);
        if (is_array($json) && isset($json['elements'])) { $data = $json; break; }
    }
    if (!$data) fail(503, 'The OpenStreetMap servers are busy. Please try again in a minute.');

    $result = json_encode(['bbox' => $bbox, 'fetched' => gmdate('c'), 'features' => osmFeatures($data['elements'], $b)],
                          JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    @mkdir($cacheDir, 0750);
    writeAtomic($cache, $result);
    header('X-Cache: miss');
    header('Content-Type: application/json');
    header('Cache-Control: public, max-age=86400');
    echo $result;
    exit;
}

if ($action === 'create') {
    requirePost();
    // An oversized body makes PHP drop $_POST and $_FILES entirely.
    if (empty($_POST) && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) fail(413, uploadError(UPLOAD_ERR_INI_SIZE));
    $config = require DATA_DIR . '/config.php';
    if (!password_verify((string) ($_POST['password'] ?? ''), $config['password_hash'])) {
        sleep(2);
        fail(403, 'Wrong upload password');
    }
    $file = $_FILES['image'] ?? null;
    if (!$file || !is_int($file['error'])) fail(400, uploadError(UPLOAD_ERR_NO_FILE));
    if ($file['error'] !== UPLOAD_ERR_OK) fail(400, uploadError($file['error']));
    if ($file['size'] > MAX_IMAGE_BYTES) fail(413, uploadError(UPLOAD_ERR_INI_SIZE));
    $info = @getimagesize($file['tmp_name']);
    if (!$info || !isset(IMAGE_TYPES[$info[2]])) fail(415, 'Only JPEG, PNG or WebP images can be shared');
    [$ext, $mime] = IMAGE_TYPES[$info[2]];
    $project = validProject(json_decode((string) ($_POST['project'] ?? ''), true));

    do {
        $id = randomId(10);
        $dir = DATA_DIR . "/projects/$id";
    } while (!@mkdir($dir, 0750, true) && is_dir($dir));
    if (!is_dir($dir)) fail(500, 'Could not create project');
    if (!move_uploaded_file($file['tmp_name'], "$dir/image.$ext")) fail(500, 'Could not store image');

    $token = bin2hex(random_bytes(16));
    $now = gmdate('c');
    $name = preg_replace('/[^\w.\- ]+/u', '_', basename((string) $file['name'])) ?: "image.$ext";
    $meta = [
        'id' => $id, 'created' => $now, 'updated' => $now, 'version' => 1,
        'tokenHash' => hash('sha256', $token),
        'image' => ['file' => "image.$ext", 'name' => $name, 'mime' => $mime,
                    'width' => $info[0], 'height' => $info[1], 'size' => $file['size']],
    ];
    writeAtomic("$dir/project.json", encode($project));
    writeAtomic("$dir/meta.json", encode($meta));
    respond(['id' => $id, 'editToken' => $token, 'version' => 1, 'updated' => $now]);
}

if ($action === 'get') {
    $dir = projectDir();
    $meta = readJson("$dir/meta.json");
    $img = $meta['image'];
    respond([
        'id' => $meta['id'], 'version' => $meta['version'], 'updated' => $meta['updated'],
        'canEdit' => canEdit($meta),
        'image' => ['name' => $img['name'], 'width' => $img['width'], 'height' => $img['height'],
                    'size' => $img['size'], 'url' => 'api.php?action=image&p=' . $meta['id']],
        'project' => readJson("$dir/project.json"),
    ]);
}

if ($action === 'image') {
    $dir = projectDir();
    $img = readJson("$dir/meta.json")['image'];
    $path = "$dir/" . basename($img['file']);
    $etag = '"' . md5($path . filesize($path) . filemtime($path)) . '"';
    header('ETag: ' . $etag);
    header('Cache-Control: public, max-age=31536000, immutable');   // a project's image never changes
    if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) { http_response_code(304); exit; }
    header('Content-Type: ' . $img['mime']);
    header('Content-Length: ' . filesize($path));
    header('Content-Disposition: inline; filename="' . addcslashes($img['name'], '"\\') . '"');
    readfile($path);
    exit;
}

if ($action === 'update') {
    requirePost();
    $dir = projectDir();
    $lock = fopen("$dir/.lock", 'c');
    if (!$lock || !flock($lock, LOCK_EX)) fail(500, 'Could not lock project');
    $meta = readJson("$dir/meta.json");
    if (!canEdit($meta)) fail(403, 'This link does not allow editing');
    $body = json_decode((string) file_get_contents('php://input'), true);
    if (!is_array($body)) fail(400, 'Expected JSON body');
    $project = validProject($body['project'] ?? null);
    if ((int) ($body['baseVersion'] ?? 0) !== $meta['version']) {
        fail(409, 'Someone else saved changes to this project', ['version' => $meta['version']]);
    }

    @mkdir("$dir/history", 0750);
    @copy("$dir/project.json", "$dir/history/{$meta['version']}.json");
    foreach (glob("$dir/history/*.json") as $old) {
        if ((int) basename($old, '.json') <= $meta['version'] - KEEP_HISTORY) @unlink($old);
    }
    writeAtomic("$dir/project.json", encode($project));
    $meta['version']++;
    $meta['updated'] = gmdate('c');
    writeAtomic("$dir/meta.json", encode($meta));
    respond(['version' => $meta['version'], 'updated' => $meta['updated']]);
}

fail(400, 'Unknown action');
