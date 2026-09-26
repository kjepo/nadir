<?php
/*
 * Shared helpers: responses, request checks, configuration and the SQLite database.
 * Included by api.php only.
 */
declare(strict_types=1);
defined('NADIR') || exit;

define('DATA_DIR', getenv('NADIR_DATA') ?: '/var/lib/nadir');
const MAX_IMAGE_BYTES = 60 * 1024 * 1024;
const MAX_PROJECT_BYTES = 2 * 1024 * 1024;
const KEEP_HISTORY = 30;
const IMAGE_TYPES = [IMAGETYPE_JPEG => ['jpg', 'image/jpeg'],
                     IMAGETYPE_PNG  => ['png', 'image/png'],
                     IMAGETYPE_WEBP => ['webp', 'image/webp']];

function fail(int $code, string $msg, array $extra = []): never {
    http_response_code($code);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $msg] + $extra, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function respond(array $data): never {
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

// State-changing requests must be POSTs from our own pages. The custom header can't be
// sent cross-site without a CORS preflight, and the session cookie is SameSite=Lax.
function requirePost(): void {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'POST required');
    if (($_SERVER['HTTP_X_NADIR'] ?? '') !== '1') fail(400, 'Missing request header');
}

function jsonBody(): array {
    $body = json_decode((string) file_get_contents('php://input'), true);
    if (!is_array($body)) fail(400, 'Expected JSON body');
    return $body;
}

function readJson(string $path): array {
    $data = json_decode((string) @file_get_contents($path), true);
    if (!is_array($data)) fail(500, 'Corrupt project data');
    return $data;
}

function writeAtomic(string $path, string $data): void {
    $tmp = $path . '.tmp' . bin2hex(random_bytes(4));
    if (file_put_contents($tmp, $data) === false || !rename($tmp, $path)) fail(500, 'Could not write file');
}

function encode(mixed $data): string {
    return json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
}

function randomId(int $len): string {
    $alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $s = '';
    for ($i = 0; $i < $len; $i++) $s .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    return $s;
}

function clientIp(): string {
    return (string) ($_SERVER['REMOTE_ADDR'] ?? '');
}

function isHttps(): bool {
    return ($_SERVER['HTTPS'] ?? '') === 'on' || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
}

/*
 * DATA_DIR/config.php returns an array. Keys:
 *   site_url     base URL used in emails (default https://nadirlab.online/)
 *   mail         ['driver' => 'log'] or ['driver' => 'ses', 'region', 'key', 'secret', 'from']
 *   quota_bytes  image storage per account (default 1 GB); quota_projects (default 100)
 */
function config(): array {
    static $config = null;
    if ($config === null) {
        $file = DATA_DIR . '/config.php';
        $config = (is_file($file) ? require $file : []) + [
            'site_url' => 'https://nadirlab.online/',
            'mail' => ['driver' => 'log'],
            'quota_bytes' => 1024 * 1024 * 1024,
            'quota_projects' => 100,
        ];
    }
    return $config;
}

function db(): PDO {
    static $pdo = null;
    if ($pdo) return $pdo;
    $pdo = new PDO('sqlite:' . DATA_DIR . '/nadir.sqlite', null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    migrate($pdo);
    return $pdo;
}

// Schema versions are tracked with PRAGMA user_version; each step runs once.
function migrate(PDO $pdo): void {
    $version = (int) $pdo->query('PRAGMA user_version')->fetchColumn();
    if ($version < 1) migrateV1($pdo);
    if ($version < 2) {
        $pdo->beginTransaction();
        $pdo->exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE users ADD COLUMN last_login_at TEXT;
                    ALTER TABLE users ADD COLUMN disabled_at TEXT;
                    PRAGMA user_version = 2;");
        $pdo->commit();
    }
}

function migrateV1(PDO $pdo): void {
    $pdo->beginTransaction();
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            name TEXT NOT NULL DEFAULT '',
            password_hash TEXT NOT NULL,
            verified_at TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            user_agent TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS tokens (
            hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            purpose TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            title TEXT NOT NULL DEFAULT '',
            image_name TEXT NOT NULL DEFAULT '',
            image_size INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_id);
        CREATE TABLE IF NOT EXISTS attempts (key TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS attempts_key ON attempts(key, at);
    ");
    indexProjectFiles($pdo);   // projects shared before accounts existed start without an owner
    $pdo->exec('PRAGMA user_version = 1');
    $pdo->commit();
}

// Add projects that exist on disk but not in the index (e.g. uploaded through the old
// monsym.se copy, which knows nothing about accounts). They get no owner. Returns how many.
function indexProjectFiles(PDO $pdo): int {
    $insert = $pdo->prepare('INSERT OR IGNORE INTO projects (id, title, image_name, image_size, created_at, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?)');
    $added = 0;
    foreach (glob(DATA_DIR . '/projects/*/meta.json') ?: [] as $file) {
        $meta = json_decode((string) file_get_contents($file), true);
        if (!is_array($meta) || empty($meta['id'])) continue;
        $insert->execute([$meta['id'], $meta['title'] ?? $meta['image']['name'] ?? '', $meta['image']['name'] ?? '',
                          (int) ($meta['image']['size'] ?? 0), $meta['created'] ?? gmdate('c'), $meta['updated'] ?? gmdate('c')]);
        $added += $insert->rowCount();
    }
    return $added;
}

/*
 * Rate limiting: at most $max recorded attempts per $key within $window seconds.
 * throttle() only checks; recordAttempt() counts one.
 */
function throttle(string $key, int $max, int $window, string $message = 'Too many attempts. Please wait a few minutes and try again.'): void {
    $stmt = db()->prepare('SELECT COUNT(*) FROM attempts WHERE key = ? AND at > ?');
    $stmt->execute([$key, time() - $window]);
    if ((int) $stmt->fetchColumn() >= $max) fail(429, $message);
}

function recordAttempt(string $key): void {
    db()->prepare('INSERT INTO attempts (key, at) VALUES (?, ?)')->execute([$key, time()]);
    if (random_int(1, 50) === 1) db()->prepare('DELETE FROM attempts WHERE at < ?')->execute([time() - 86400]);
}

function clearAttempts(string $key): void {
    db()->prepare('DELETE FROM attempts WHERE key = ?')->execute([$key]);
}
