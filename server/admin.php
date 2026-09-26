<?php
/*
 * Admin panel API: overview numbers, all accounts, all projects, and management actions.
 * Every action requires a logged-in admin (users.is_admin, set with server/cli.php make-admin).
 */
declare(strict_types=1);
defined('NADIR') || exit;

function adminUserRow(int $id): array {
    $q = db()->prepare('SELECT * FROM users WHERE id = ?');
    $q->execute([$id]);
    return $q->fetch() ?: fail(404, 'Account not found');
}

function actionAdminStats(): never {
    requireAdmin();
    indexProjectFiles(db());
    $one = fn(string $sql, array $args = []) => (function () use ($sql, $args) {
        $q = db()->prepare($sql);
        $q->execute($args);
        return $q->fetchColumn();
    })();
    $since = fn(int $days) => gmdate('c', time() - $days * 86400);
    respond([
        'users' => [
            'total' => (int) $one('SELECT COUNT(*) FROM users'),
            'verified' => (int) $one('SELECT COUNT(*) FROM users WHERE verified_at IS NOT NULL'),
            'unverified' => (int) $one('SELECT COUNT(*) FROM users WHERE verified_at IS NULL'),
            'disabled' => (int) $one('SELECT COUNT(*) FROM users WHERE disabled_at IS NOT NULL'),
            'admins' => (int) $one('SELECT COUNT(*) FROM users WHERE is_admin = 1'),
            'new7' => (int) $one('SELECT COUNT(*) FROM users WHERE created_at >= ?', [$since(7)]),
            'new30' => (int) $one('SELECT COUNT(*) FROM users WHERE created_at >= ?', [$since(30)]),
            'active30' => (int) $one('SELECT COUNT(*) FROM users WHERE last_login_at >= ?', [$since(30)]),
        ],
        'projects' => [
            'total' => (int) $one('SELECT COUNT(*) FROM projects'),
            'unowned' => (int) $one('SELECT COUNT(*) FROM projects WHERE owner_id IS NULL'),
            'new30' => (int) $one('SELECT COUNT(*) FROM projects WHERE created_at >= ?', [$since(30)]),
            'bytes' => (int) $one('SELECT COALESCE(SUM(image_size), 0) FROM projects'),
        ],
        'disk' => ['free' => (int) @disk_free_space(DATA_DIR), 'total' => (int) @disk_total_space(DATA_DIR)],
        'mail' => config()['mail']['driver'] ?? 'log',
    ]);
}

function actionAdminUsers(): never {
    requireAdmin();
    $rows = db()->query('SELECT u.id, u.email, u.name, u.verified_at, u.created_at, u.last_login_at, u.disabled_at, u.is_admin,
                                COUNT(p.id) AS projects, COALESCE(SUM(p.image_size), 0) AS bytes
                         FROM users u LEFT JOIN projects p ON p.owner_id = u.id
                         GROUP BY u.id ORDER BY u.created_at DESC')->fetchAll();
    respond(['users' => array_map(fn($u) => [
        'id' => (int) $u['id'], 'email' => $u['email'], 'name' => $u['name'],
        'verified' => $u['verified_at'] !== null, 'disabled' => $u['disabled_at'] !== null, 'isAdmin' => (bool) $u['is_admin'],
        'created' => $u['created_at'], 'lastLogin' => $u['last_login_at'],
        'projects' => (int) $u['projects'], 'bytes' => (int) $u['bytes'],
    ], $rows), 'me' => (int) currentUser()['id']]);
}

function actionAdminProjects(): never {
    requireAdmin();
    indexProjectFiles(db());
    $rows = db()->query('SELECT p.*, u.email AS owner_email FROM projects p LEFT JOIN users u ON u.id = p.owner_id
                         ORDER BY p.updated_at DESC')->fetchAll();
    respond(['projects' => array_map(fn($r) => publicProject($r) + [
        'ownerId' => $r['owner_id'] === null ? null : (int) $r['owner_id'], 'ownerEmail' => $r['owner_email'],
    ], $rows)]);
}

// POST {id, op}: verify | send-reset | disable | enable | make-admin | remove-admin | delete | delete-with-projects
function actionAdminUser(): never {
    requirePost();
    $admin = requireAdmin();
    $b = jsonBody();
    $user = adminUserRow((int) ($b['id'] ?? 0));
    $op = (string) ($b['op'] ?? '');
    $self = (int) $user['id'] === (int) $admin['id'];
    if ($self && in_array($op, ['disable', 'remove-admin', 'delete', 'delete-with-projects'], true)) {
        fail(400, "You can't do that to your own account here.");
    }
    $set = fn(string $sql) => db()->prepare($sql)->execute([$user['id']]);
    switch ($op) {
        case 'verify':
            db()->prepare('UPDATE users SET verified_at = COALESCE(verified_at, ?) WHERE id = ?')->execute([gmdate('c'), $user['id']]);
            respond(['ok' => true, 'message' => "{$user['email']} is now confirmed."]);
        case 'send-reset':
            sendReset($user);
            respond(['ok' => true, 'message' => "Password reset link sent to {$user['email']}."]);
        case 'disable':
            db()->prepare('UPDATE users SET disabled_at = ? WHERE id = ?')->execute([gmdate('c'), $user['id']]);
            $set('DELETE FROM sessions WHERE user_id = ?');
            respond(['ok' => true, 'message' => "{$user['email']} is disabled and logged out everywhere."]);
        case 'enable':
            $set('UPDATE users SET disabled_at = NULL WHERE id = ?');
            respond(['ok' => true, 'message' => "{$user['email']} can log in again."]);
        case 'make-admin':
            $set('UPDATE users SET is_admin = 1 WHERE id = ?');
            respond(['ok' => true, 'message' => "{$user['email']} is now an admin."]);
        case 'remove-admin':
            $set('UPDATE users SET is_admin = 0 WHERE id = ?');
            respond(['ok' => true, 'message' => "{$user['email']} is no longer an admin."]);
        case 'delete':
        case 'delete-with-projects':
            $q = db()->prepare('SELECT id FROM projects WHERE owner_id = ?');
            $q->execute([$user['id']]);
            $ids = $q->fetchAll(PDO::FETCH_COLUMN);
            if ($op === 'delete-with-projects') {
                foreach ($ids as $id) deleteProjectFiles($id);
                $set('DELETE FROM projects WHERE owner_id = ?');
            }
            $set('DELETE FROM users WHERE id = ?');   // remaining projects lose their owner (ON DELETE SET NULL)
            respond(['ok' => true, 'message' => "{$user['email']} was deleted" . ($ids
                ? ($op === 'delete-with-projects' ? ' with ' . count($ids) . ' project(s).' : '; ' . count($ids) . ' project(s) now have no owner.')
                : '.')]);
    }
    fail(400, 'Unknown operation');
}

// POST {id, op: 'owner', email} (email '' = no owner) or {id, op: 'delete'}
function actionAdminProject(): never {
    requirePost();
    requireAdmin();
    $b = jsonBody();
    $_GET['p'] = (string) ($b['id'] ?? '');
    $id = projectId();
    $op = (string) ($b['op'] ?? '');
    if ($op === 'delete') {
        deleteProjectFiles($id);
        db()->prepare('DELETE FROM projects WHERE id = ?')->execute([$id]);
        respond(['ok' => true, 'message' => 'Project deleted.']);
    }
    if ($op === 'owner') {
        $email = trim((string) ($b['email'] ?? ''));
        $owner = null;
        if ($email !== '') {
            $owner = findUserByEmail($email);
            if (!$owner) fail(404, "There is no account for $email");
        }
        db()->prepare('UPDATE projects SET owner_id = ? WHERE id = ?')->execute([$owner['id'] ?? null, $id]);
        respond(['ok' => true, 'message' => $owner ? "Project now belongs to {$owner['email']}." : 'Project now has no owner.']);
    }
    fail(400, 'Unknown operation');
}
