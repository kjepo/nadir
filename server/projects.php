<?php
/*
 * Projects stored on the server. Each lives in DATA_DIR/projects/<id>/ (meta.json with
 * the sha256 of its edit token, project.json, the image, thumb.jpg, history/), and is
 * indexed in the projects table with its owner. The owner can always edit; anyone with
 * the secret edit link can too; anyone with the id can view.
 */
declare(strict_types=1);
defined('NADIR') || exit;

function projectId(): string {
    $id = $_GET['p'] ?? '';
    if (!is_string($id) || !preg_match('/^[A-Za-z0-9]{10}$/', $id)) fail(400, 'Bad project id');
    if (!is_file(DATA_DIR . "/projects/$id/meta.json")) fail(404, 'Project not found');
    return $id;
}

function projectRow(string $id): ?array {
    $stmt = db()->prepare('SELECT * FROM projects WHERE id = ?');
    $stmt->execute([$id]);
    return $stmt->fetch() ?: null;
}

function isOwner(?array $row): bool {
    $user = currentUser();
    return $user && $row && (int) $row['owner_id'] === (int) $user['id'];
}

function hasEditToken(array $meta): bool {
    $token = $_SERVER['HTTP_X_EDIT_TOKEN'] ?? '';
    return is_string($token) && $token !== '' && hash_equals($meta['tokenHash'], hash('sha256', $token));
}

// The owner, or an admin, may manage a project.
function canManage(?array $row): bool {
    return isOwner($row) || isAdmin();
}

function requireOwnedProject(): array {
    requireUser();
    $id = projectId();
    $row = projectRow($id);
    if (!$row) fail(404, 'Project not found');
    if (!canManage($row)) fail(403, 'Only the owner can do that');
    return $row;
}

function validProject(mixed $project): array {
    if (!is_array($project)) fail(400, 'Project must be a JSON object');
    if (strlen(json_encode($project)) > MAX_PROJECT_BYTES) fail(413, 'Project data too large');
    return $project;
}

function validTitle(mixed $title, string $fallback): string {
    $title = trim(preg_replace('/\s+/u', ' ', (string) $title));
    if ($title === '') $title = $fallback;
    return mb_substr($title, 0, 120);
}

function uploadError(int $code): string {
    return match ($code) {
        UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => 'Image is too large (max ' . (MAX_IMAGE_BYTES >> 20) . ' MB)',
        UPLOAD_ERR_PARTIAL => 'Upload was interrupted',
        UPLOAD_ERR_NO_FILE => 'No image received',
        default => 'Upload failed (code ' . $code . ')',
    };
}

function deleteProjectFiles(string $id): void {
    if (!preg_match('/^[A-Za-z0-9]{10}$/', $id)) return;
    $dir = DATA_DIR . "/projects/$id";
    if (!is_dir($dir)) return;
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
                                        RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($it as $f) $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
    @rmdir($dir);
}

const IMAGEMAGICK = '/usr/bin/convert';

// Make thumb.jpg from the project image when it is missing (projects saved before thumbnails
// existed, or through the old monsym.se copy). JPEGs are decoded at reduced size, which keeps
// memory low even for large panoramas.
function ensureThumb(string $id): bool {
    $dir = DATA_DIR . "/projects/$id";
    $thumb = "$dir/thumb.jpg";
    if (is_file($thumb)) return true;
    if (!is_executable(IMAGEMAGICK)) return false;
    $meta = json_decode((string) @file_get_contents("$dir/meta.json"), true);
    $image = is_array($meta) ? "$dir/" . basename($meta['image']['file']) : '';
    if (!is_file($image)) return false;
    $tmp = "$dir/thumb.tmp" . bin2hex(random_bytes(4)) . '.jpg';
    exec(IMAGEMAGICK . ' -define jpeg:size=960x960 ' . escapeshellarg($image . '[0]')
         . ' -auto-orient -thumbnail 480x480 -strip -quality 80 ' . escapeshellarg($tmp) . ' 2>&1', $output, $status);
    if ($status !== 0 || !is_file($tmp)) { @unlink($tmp); return false; }
    return rename($tmp, $thumb);
}

function publicProject(array $row): array {
    return ['id' => $row['id'], 'title' => $row['title'], 'imageName' => $row['image_name'],
            'imageSize' => (int) $row['image_size'], 'created' => $row['created_at'], 'updated' => $row['updated_at'],
            'thumb' => "api.php?action=thumb&p={$row['id']}"];
}

/* ---------- Actions ---------- */

function actionCreate(): never {
    requirePost();
    // An oversized body makes PHP drop $_POST and $_FILES entirely.
    if (empty($_POST) && (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) fail(413, uploadError(UPLOAD_ERR_INI_SIZE));
    $user = requireUser();
    if ($user['verified_at'] === null) fail(403, 'Please confirm your email address first');

    $file = $_FILES['image'] ?? null;
    if (!$file || !is_int($file['error'])) fail(400, uploadError(UPLOAD_ERR_NO_FILE));
    if ($file['error'] !== UPLOAD_ERR_OK) fail(400, uploadError($file['error']));
    if ($file['size'] > MAX_IMAGE_BYTES) fail(413, uploadError(UPLOAD_ERR_INI_SIZE));
    $info = @getimagesize($file['tmp_name']);
    if (!$info || !isset(IMAGE_TYPES[$info[2]])) fail(415, 'Only JPEG, PNG or WebP images can be saved');
    [$ext, $mime] = IMAGE_TYPES[$info[2]];
    $project = validProject(json_decode((string) ($_POST['project'] ?? ''), true));

    $usage = meResponse($user)['quota'];
    if ($usage['projects'] >= $usage['maxProjects']) fail(403, "You've reached the limit of {$usage['maxProjects']} projects. Delete one to make room.");
    if ($usage['bytes'] + $file['size'] > $usage['maxBytes']) {
        fail(403, 'Not enough storage left in your account (' . round(($usage['maxBytes'] - $usage['bytes']) / 1048576) . ' MB free). Delete a project to make room.');
    }

    do {
        $id = randomId(10);
        $dir = DATA_DIR . "/projects/$id";
    } while (!@mkdir($dir, 0750, true) && is_dir($dir));
    if (!is_dir($dir)) fail(500, 'Could not create project');
    if (!move_uploaded_file($file['tmp_name'], "$dir/image.$ext")) fail(500, 'Could not store image');

    // Optional small preview for the My projects list, made by the browser.
    $thumb = $_FILES['thumb'] ?? null;
    if ($thumb && ($thumb['error'] ?? 1) === UPLOAD_ERR_OK && $thumb['size'] < 500 * 1024) {
        $t = @getimagesize($thumb['tmp_name']);
        if ($t && $t[2] === IMAGETYPE_JPEG && $t[0] <= 800 && $t[1] <= 800) move_uploaded_file($thumb['tmp_name'], "$dir/thumb.jpg");
    }

    $token = bin2hex(random_bytes(16));
    $now = gmdate('c');
    $name = preg_replace('/[^\w.\- ]+/u', '_', basename((string) $file['name'])) ?: "image.$ext";
    $title = validTitle($_POST['title'] ?? '', $name);
    $meta = [
        'id' => $id, 'created' => $now, 'updated' => $now, 'version' => 1,
        'tokenHash' => hash('sha256', $token),
        'image' => ['file' => "image.$ext", 'name' => $name, 'mime' => $mime,
                    'width' => $info[0], 'height' => $info[1], 'size' => $file['size']],
    ];
    writeAtomic("$dir/project.json", encode($project));
    writeAtomic("$dir/meta.json", encode($meta));
    db()->prepare('INSERT INTO projects (id, owner_id, title, image_name, image_size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        ->execute([$id, $user['id'], $title, $name, $file['size'], $now, $now]);
    respond(['id' => $id, 'editToken' => $token, 'version' => 1, 'updated' => $now, 'title' => $title]);
}

function actionGet(): never {
    $id = projectId();
    $dir = DATA_DIR . "/projects/$id";
    $meta = readJson("$dir/meta.json");
    $row = projectRow($id);
    $img = $meta['image'];
    respond([
        'id' => $id, 'version' => $meta['version'], 'updated' => $meta['updated'],
        'title' => $row['title'] ?? $img['name'],
        'isOwner' => canManage($row),
        'canEdit' => canManage($row) || hasEditToken($meta),
        'tokenValid' => hasEditToken($meta),
        'image' => ['name' => $img['name'], 'width' => $img['width'], 'height' => $img['height'],
                    'size' => $img['size'], 'url' => "api.php?action=image&p=$id"],
        'project' => readJson("$dir/project.json"),
    ]);
}

function serveFile(string $path, string $mime, string $filename): never {
    if (!is_file($path)) fail(404, 'Not found');
    $etag = '"' . md5($path . filesize($path) . filemtime($path)) . '"';
    header('ETag: ' . $etag);
    header('Cache-Control: public, max-age=31536000, immutable');   // a project's image never changes
    if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) { http_response_code(304); exit; }
    header('Content-Type: ' . $mime);
    header('Content-Length: ' . filesize($path));
    header('Content-Disposition: inline; filename="' . addcslashes($filename, '"\\') . '"');
    readfile($path);
    exit;
}

function actionImage(): never {
    $id = projectId();
    $img = readJson(DATA_DIR . "/projects/$id/meta.json")['image'];
    serveFile(DATA_DIR . "/projects/$id/" . basename($img['file']), $img['mime'], $img['name']);
}

function actionThumb(): never {
    $id = projectId();
    ensureThumb($id);
    serveFile(DATA_DIR . "/projects/$id/thumb.jpg", 'image/jpeg', "$id.jpg");
}

function actionUpdate(): never {
    requirePost();
    $id = projectId();
    $dir = DATA_DIR . "/projects/$id";
    $lock = fopen("$dir/.lock", 'c');
    if (!$lock || !flock($lock, LOCK_EX)) fail(500, 'Could not lock project');
    $meta = readJson("$dir/meta.json");
    if (!canManage(projectRow($id)) && !hasEditToken($meta)) fail(403, 'You are not allowed to edit this project');
    $body = jsonBody();
    $project = validProject($body['project'] ?? null);
    if ((int) ($body['baseVersion'] ?? 0) !== $meta['version']) {
        fail(409, 'Someone else saved changes to this project', ['version' => $meta['version']]);
    }

    @mkdir("$dir/history", 0750);
    @copy("$dir/project.json", "$dir/history/{$meta['version']}.json");
    foreach (glob("$dir/history/*.json") ?: [] as $old) {
        if ((int) basename($old, '.json') <= $meta['version'] - KEEP_HISTORY) @unlink($old);
    }
    writeAtomic("$dir/project.json", encode($project));
    $meta['version']++;
    $meta['updated'] = gmdate('c');
    writeAtomic("$dir/meta.json", encode($meta));
    db()->prepare('UPDATE projects SET updated_at = ? WHERE id = ?')->execute([$meta['updated'], $id]);
    respond(['version' => $meta['version'], 'updated' => $meta['updated']]);
}

function actionMine(): never {
    $user = requireUser();
    $q = db()->prepare('SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC');
    $q->execute([$user['id']]);
    respond(['projects' => array_map('publicProject', $q->fetchAll())] + meResponse($user));
}

function actionRename(): never {
    requirePost();
    $row = requireOwnedProject();
    $title = validTitle(jsonBody()['title'] ?? '', $row['image_name']);
    db()->prepare('UPDATE projects SET title = ? WHERE id = ?')->execute([$title, $row['id']]);
    respond(['title' => $title]);
}

function actionDeleteProject(): never {
    requirePost();
    $row = requireOwnedProject();
    deleteProjectFiles($row['id']);
    db()->prepare('DELETE FROM projects WHERE id = ?')->execute([$row['id']]);
    respond(['ok' => true]);
}

// Replace the project's edit link; the old one stops working.
function actionNewEditLink(): never {
    requirePost();
    $row = requireOwnedProject();
    $dir = DATA_DIR . "/projects/{$row['id']}";
    $lock = fopen("$dir/.lock", 'c');
    if (!$lock || !flock($lock, LOCK_EX)) fail(500, 'Could not lock project');
    $meta = readJson("$dir/meta.json");
    $token = bin2hex(random_bytes(16));
    $meta['tokenHash'] = hash('sha256', $token);
    writeAtomic("$dir/meta.json", encode($meta));
    respond(['editToken' => $token]);
}
