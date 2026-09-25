<?php
/*
 * OpenStreetMap overlay data: roads, buildings and water near a photo, fetched from
 * Overpass (with fallback servers), trimmed to the area and cached for 30 days.
 */
declare(strict_types=1);
defined('NADIR') || exit;

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

function actionOsm(): never {
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
            'header' => "Content-Type: application/x-www-form-urlencoded\r\nUser-Agent: nadir-georeferencer (https://nadirlab.online/)\r\n",
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
