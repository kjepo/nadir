<?php
/*
 * Command-line admin tasks, run on the server as www-data:
 *   sudo -u www-data php server/cli.php users
 *   sudo -u www-data php server/cli.php assign-unowned EMAIL   (give projects without an owner to EMAIL)
 *   sudo -u www-data php server/cli.php make-admin EMAIL | remove-admin EMAIL
 */
declare(strict_types=1);
if (PHP_SAPI !== 'cli') exit;
const NADIR = true;
require __DIR__ . '/common.php';

$cmd = $argv[1] ?? '';
if ($cmd === 'users') {
    foreach (db()->query('SELECT u.id, u.email, u.name, u.verified_at, u.created_at, u.is_admin, u.disabled_at, COUNT(p.id) AS projects
                          FROM users u LEFT JOIN projects p ON p.owner_id = u.id GROUP BY u.id ORDER BY u.id') as $u) {
        printf("%4d  %-35s %-20s %-10s %s  %d projects%s%s\n", $u['id'], $u['email'], $u['name'],
               $u['verified_at'] ? 'verified' : 'UNVERIFIED', substr($u['created_at'], 0, 10), $u['projects'],
               $u['is_admin'] ? '  ADMIN' : '', $u['disabled_at'] ? '  DISABLED' : '');
    }
} elseif ($cmd === 'assign-unowned' && isset($argv[2])) {
    $q = db()->prepare('SELECT id FROM users WHERE email = ?');
    $q->execute([$argv[2]]);
    $userId = $q->fetchColumn();
    if (!$userId) { fwrite(STDERR, "No user {$argv[2]}\n"); exit(1); }
    $n = db()->prepare('UPDATE projects SET owner_id = ? WHERE owner_id IS NULL');
    $n->execute([$userId]);
    echo $n->rowCount(), " project(s) assigned to {$argv[2]}\n";
} elseif (($cmd === 'make-admin' || $cmd === 'remove-admin') && isset($argv[2])) {
    $n = db()->prepare('UPDATE users SET is_admin = ? WHERE email = ?');
    $n->execute([$cmd === 'make-admin' ? 1 : 0, $argv[2]]);
    if (!$n->rowCount()) { fwrite(STDERR, "No user {$argv[2]}\n"); exit(1); }
    echo $argv[2], $cmd === 'make-admin' ? " is now an admin\n" : " is no longer an admin\n";
} else {
    fwrite(STDERR, "Usage: php server/cli.php users | assign-unowned EMAIL | make-admin EMAIL | remove-admin EMAIL\n");
    exit(1);
}
