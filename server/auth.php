<?php
/*
 * Accounts: register (with email verification), log in/out, forgot/reset password,
 * account settings. Sessions are random tokens in an HttpOnly cookie; only their hash is stored.
 */
declare(strict_types=1);
defined('NADIR') || exit;

const SESSION_COOKIE = 'nadir_session';
const SESSION_DAYS = 30;
const VERIFY_HOURS = 48;
const RESET_MINUTES = 60;
const MIN_PASSWORD = 8;

function publicUser(array $u): array {
    return ['id' => (int) $u['id'], 'email' => $u['email'], 'name' => $u['name'], 'verified' => $u['verified_at'] !== null,
            'isAdmin' => !empty($u['is_admin'])];
}

function currentUser(): ?array {
    static $user = false;
    if ($user !== false) return $user;
    $user = null;
    $token = $_COOKIE[SESSION_COOKIE] ?? '';
    if (!is_string($token) || !preg_match('/^[0-9a-f]{64}$/', $token)) return null;
    $stmt = db()->prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                           WHERE s.id_hash = ? AND s.expires_at > ? AND u.disabled_at IS NULL');
    $stmt->execute([hash('sha256', $token), time()]);
    $user = $stmt->fetch() ?: null;
    return $user;
}

function requireUser(): array {
    $u = currentUser();
    if (!$u) fail(401, 'Please log in first');
    return $u;
}

function isAdmin(): bool {
    $u = currentUser();
    return $u !== null && !empty($u['is_admin']);
}

function requireAdmin(): array {
    $u = requireUser();
    if (empty($u['is_admin'])) fail(403, 'Admins only');
    return $u;
}

const DISABLED_MESSAGE = 'This account has been disabled. Please contact the site owner.';

function setSessionCookie(string $value, int $expires): void {
    setcookie(SESSION_COOKIE, $value, ['expires' => $expires, 'path' => '/', 'secure' => isHttps(),
                                        'httponly' => true, 'samesite' => 'Lax']);
}

function startSession(int $userId): void {
    $token = bin2hex(random_bytes(32));
    $expires = time() + SESSION_DAYS * 86400;
    db()->prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
        ->execute([hash('sha256', $token), $userId, time(), $expires, substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 200)]);
    if (random_int(1, 20) === 1) db()->prepare('DELETE FROM sessions WHERE expires_at < ?')->execute([time()]);
    db()->prepare('UPDATE users SET last_login_at = ? WHERE id = ?')->execute([gmdate('c'), $userId]);
    setSessionCookie($token, $expires);
}

function endSession(): void {
    $token = $_COOKIE[SESSION_COOKIE] ?? '';
    if (is_string($token) && $token !== '') db()->prepare('DELETE FROM sessions WHERE id_hash = ?')->execute([hash('sha256', $token)]);
    setSessionCookie('', time() - 3600);
}

// One-time links (email verification, password reset). Returns the raw token for the link.
function createToken(int $userId, string $purpose, int $ttl): string {
    db()->prepare('DELETE FROM tokens WHERE user_id = ? AND purpose = ?')->execute([$userId, $purpose]);
    $token = bin2hex(random_bytes(32));
    db()->prepare('INSERT INTO tokens (hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)')
        ->execute([hash('sha256', $token), $userId, $purpose, time() + $ttl]);
    return $token;
}

function useToken(string $token, string $purpose): ?array {
    if (!preg_match('/^[0-9a-f]{64}$/', $token)) return null;
    $stmt = db()->prepare('SELECT u.* FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.hash = ? AND t.purpose = ? AND t.expires_at > ?');
    $stmt->execute([hash('sha256', $token), $purpose, time()]);
    $user = $stmt->fetch() ?: null;
    if ($user) db()->prepare('DELETE FROM tokens WHERE hash = ?')->execute([hash('sha256', $token)]);
    return $user;
}

function findUserByEmail(string $email): ?array {
    $stmt = db()->prepare('SELECT * FROM users WHERE email = ?');
    $stmt->execute([$email]);
    return $stmt->fetch() ?: null;
}

function validEmail(mixed $email): string {
    $email = trim((string) $email);
    if (strlen($email) > 254 || !filter_var($email, FILTER_VALIDATE_EMAIL)) fail(400, 'Please enter a valid email address');
    return $email;
}

function validPassword(mixed $password): string {
    $password = (string) $password;
    if (strlen($password) < MIN_PASSWORD) fail(400, 'Use a password of at least ' . MIN_PASSWORD . ' characters');
    if (strlen($password) > 200) fail(400, 'That password is too long');
    return $password;
}

function validName(mixed $name): string {
    $name = trim(preg_replace('/\s+/u', ' ', (string) $name));
    if (mb_strlen($name) > 80) fail(400, 'Please use a shorter name');
    return $name;
}

// Limit how often mail is sent to one address and from one client.
function throttleMail(string $email): void {
    throttle('mail:' . strtolower($email), 5, 3600, 'Too many emails sent to this address. Please try again later.');
    throttle('mail-ip:' . clientIp(), 20, 3600, 'Too many emails requested. Please try again later.');
    recordAttempt('mail:' . strtolower($email));
    recordAttempt('mail-ip:' . clientIp());
}

function sendVerification(array $user): void {
    $link = config()['site_url'] . '?verify=' . createToken((int) $user['id'], 'verify', VERIFY_HOURS * 3600);
    sendActionMail($user['email'], 'Confirm your email for Nadir Lab', [
        'Hi' . ($user['name'] !== '' ? ' ' . $user['name'] : '') . ',',
        'Please confirm your email address to finish creating your Nadir Lab account.',
        'If you didn\'t sign up, you can ignore this email.',
    ], 'Confirm email address', $link);
}

function sendReset(array $user): void {
    $link = config()['site_url'] . '?reset=' . createToken((int) $user['id'], 'reset', RESET_MINUTES * 60);
    sendActionMail($user['email'], 'Reset your Nadir Lab password', [
        'Someone (hopefully you) asked to reset the password for your Nadir Lab account.',
        'The link below works once and expires in ' . RESET_MINUTES . ' minutes. If you didn\'t ask for this, you can ignore this email; your password stays the same.',
    ], 'Choose a new password', $link);
}

function meResponse(?array $user): array {
    if (!$user) return ['user' => null];
    $q = db()->prepare('SELECT COUNT(*) AS n, COALESCE(SUM(image_size), 0) AS bytes FROM projects WHERE owner_id = ?');
    $q->execute([$user['id']]);
    $usage = $q->fetch();
    return ['user' => publicUser($user), 'quota' => [
        'projects' => (int) $usage['n'], 'bytes' => (int) $usage['bytes'],
        'maxProjects' => (int) config()['quota_projects'], 'maxBytes' => (int) config()['quota_bytes'],
    ]];
}

/* ---------- Actions ---------- */

function actionMe(): never {
    respond(meResponse(currentUser()));
}

function actionRegister(): never {
    requirePost();
    $b = jsonBody();
    $email = validEmail($b['email'] ?? '');
    $password = validPassword($b['password'] ?? '');
    $name = validName($b['name'] ?? '');
    throttle('register:' . clientIp(), 10, 3600, 'Too many sign-ups from here. Please try again later.');
    recordAttempt('register:' . clientIp());

    $done = ['ok' => true, 'message' => "We've sent a confirmation link to $email. Click it to activate your account."];
    $existing = findUserByEmail($email);
    if ($existing) {
        // Same answer either way, so the form doesn't reveal who has an account.
        throttleMail($email);
        if ($existing['verified_at'] === null) {
            sendVerification($existing);
        } else {
            sendActionMail($existing['email'], 'You already have a Nadir Lab account', [
                'Someone tried to create a Nadir Lab account with this email address, but you already have one.',
                'If that was you, log in instead, or reset your password if you have forgotten it.',
            ], 'Go to Nadir Lab', config()['site_url']);
        }
        respond($done);
    }
    db()->prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
        ->execute([$email, $name, password_hash($password, PASSWORD_DEFAULT), gmdate('c')]);
    throttleMail($email);
    sendVerification(findUserByEmail($email));
    respond($done);
}

function actionVerify(): never {
    requirePost();
    $user = useToken((string) (jsonBody()['token'] ?? ''), 'verify');
    if (!$user) fail(400, 'This confirmation link is invalid or has expired. Log in to get a new one.');
    if ($user['disabled_at'] !== null) fail(403, DISABLED_MESSAGE);
    if ($user['verified_at'] === null) {
        db()->prepare('UPDATE users SET verified_at = ? WHERE id = ?')->execute([gmdate('c'), $user['id']]);
    }
    startSession((int) $user['id']);
    respond(meResponse(findUserByEmail($user['email'])));
}

function actionResendVerification(): never {
    requirePost();
    $email = validEmail(jsonBody()['email'] ?? '');
    $user = findUserByEmail($email);
    if ($user && $user['verified_at'] === null) {
        throttleMail($email);
        sendVerification($user);
    }
    respond(['ok' => true, 'message' => "If $email has an unconfirmed account, a new confirmation link is on its way."]);
}

function actionLogin(): never {
    requirePost();
    $b = jsonBody();
    $email = validEmail($b['email'] ?? '');
    $password = (string) ($b['password'] ?? '');
    $ipKey = 'login-ip:' . clientIp();
    $emailKey = 'login:' . strtolower($email);
    throttle($ipKey, 30, 900);
    throttle($emailKey, 8, 900, 'Too many failed attempts for this account. Please wait 15 minutes, or reset your password.');

    $user = findUserByEmail($email);
    // Verify against a dummy hash for unknown emails so both cases take the same time.
    $hash = $user['password_hash'] ?? '$2y$12$oxyGAON1mYjVnXp.YthXNe06E/imSU3.25XusH26n09ouskg5ghWy';   // hash of a random, discarded password
    if (!password_verify($password, $hash) || !$user) {
        recordAttempt($ipKey);
        recordAttempt($emailKey);
        fail(401, 'Wrong email or password');
    }
    clearAttempts($emailKey);
    if ($user['disabled_at'] !== null) fail(403, DISABLED_MESSAGE);
    if ($user['verified_at'] === null) {
        fail(403, 'Please confirm your email address first. Check your inbox for the confirmation link.', ['code' => 'unverified']);
    }
    if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
        db()->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([password_hash($password, PASSWORD_DEFAULT), $user['id']]);
    }
    startSession((int) $user['id']);
    respond(meResponse($user));
}

function actionLogout(): never {
    requirePost();
    endSession();
    respond(['user' => null]);
}

function actionForgot(): never {
    requirePost();
    $email = validEmail(jsonBody()['email'] ?? '');
    $user = findUserByEmail($email);
    if ($user) {
        throttleMail($email);
        sendReset($user);
    }
    respond(['ok' => true, 'message' => "If there's an account for $email, we've sent a link to reset its password."]);
}

function actionReset(): never {
    requirePost();
    $b = jsonBody();
    $password = validPassword($b['password'] ?? '');
    $user = useToken((string) ($b['token'] ?? ''), 'reset');
    if (!$user) fail(400, 'This reset link is invalid or has expired. Please ask for a new one.');
    if ($user['disabled_at'] !== null) fail(403, DISABLED_MESSAGE);
    // A reset link also proves the address works, so it confirms an unverified account.
    db()->prepare('UPDATE users SET password_hash = ?, verified_at = COALESCE(verified_at, ?) WHERE id = ?')
        ->execute([password_hash($password, PASSWORD_DEFAULT), gmdate('c'), $user['id']]);
    db()->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$user['id']]);
    clearAttempts('login:' . strtolower($user['email']));
    startSession((int) $user['id']);
    respond(meResponse(findUserByEmail($user['email'])));
}

function actionUpdateAccount(): never {
    requirePost();
    $user = requireUser();
    $name = validName(jsonBody()['name'] ?? '');
    db()->prepare('UPDATE users SET name = ? WHERE id = ?')->execute([$name, $user['id']]);
    respond(meResponse(findUserByEmail($user['email'])));
}

function actionChangePassword(): never {
    requirePost();
    $user = requireUser();
    $b = jsonBody();
    throttle('password:' . $user['id'], 8, 900);
    if (!password_verify((string) ($b['current'] ?? ''), $user['password_hash'])) {
        recordAttempt('password:' . $user['id']);
        fail(403, 'Your current password is not correct');
    }
    $password = validPassword($b['password'] ?? '');
    db()->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([password_hash($password, PASSWORD_DEFAULT), $user['id']]);
    // Log out everywhere else.
    db()->prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?')
        ->execute([$user['id'], hash('sha256', (string) ($_COOKIE[SESSION_COOKIE] ?? ''))]);
    respond(['ok' => true]);
}

function actionDeleteAccount(): never {
    requirePost();
    $user = requireUser();
    throttle('password:' . $user['id'], 8, 900);
    if (!password_verify((string) (jsonBody()['password'] ?? ''), $user['password_hash'])) {
        recordAttempt('password:' . $user['id']);
        fail(403, 'Your password is not correct');
    }
    $q = db()->prepare('SELECT id FROM projects WHERE owner_id = ?');
    $q->execute([$user['id']]);
    foreach ($q->fetchAll(PDO::FETCH_COLUMN) as $id) deleteProjectFiles($id);
    db()->prepare('DELETE FROM projects WHERE owner_id = ?')->execute([$user['id']]);
    db()->prepare('DELETE FROM users WHERE id = ?')->execute([$user['id']]);
    setSessionCookie('', time() - 3600);
    respond(['user' => null]);
}
