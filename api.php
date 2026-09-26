<?php
/*
 * Nadir Lab server API. Every request is api.php?action=NAME; POSTs need the header
 * X-Nadir: 1. Data lives outside the web root in DATA_DIR (default /var/lib/nadir).
 *
 * Accounts (server/auth.php)
 *   GET  me                     -> {user|null, quota}
 *   POST register               {email, password, name}      (sends a confirmation email)
 *   POST verify                 {token}                      (confirms the email, logs in)
 *   POST resend-verification    {email}
 *   POST login                  {email, password}
 *   POST logout
 *   POST forgot                 {email}                      (sends a reset link)
 *   POST reset                  {token, password}            (logs in)
 *   POST update-account         {name}
 *   POST change-password        {current, password}
 *   POST delete-account         {password}                   (also deletes the user's projects)
 *
 * Projects (server/projects.php)
 *   POST create                 multipart: image, project, title, [thumb]   (logged in)
 *   GET  get&p=ID               [X-Edit-Token] -> {..., isOwner, canEdit}
 *   GET  image&p=ID, thumb&p=ID
 *   POST update&p=ID            {baseVersion, project}       (owner or X-Edit-Token)
 *   GET  mine                   the logged-in user's projects
 *   POST rename&p=ID {title}, delete-project&p=ID, new-edit-link&p=ID      (owner)
 *
 * Admin (server/admin.php), admins only
 *   GET  admin-stats, admin-users, admin-projects
 *   POST admin-user    {id, op: verify|send-reset|disable|enable|make-admin|remove-admin|delete|delete-with-projects}
 *   POST admin-project {id, op: owner, email} | {id, op: delete}
 *
 * Map (server/osm.php)
 *   GET  osm&s=&w=&n=&e=        OpenStreetMap features near a photo
 */
declare(strict_types=1);
const NADIR = true;

require __DIR__ . '/server/common.php';
require __DIR__ . '/server/mail.php';
require __DIR__ . '/server/auth.php';
require __DIR__ . '/server/projects.php';
require __DIR__ . '/server/osm.php';
require __DIR__ . '/server/admin.php';

header('X-Content-Type-Options: nosniff');

$routes = [
    'me' => 'actionMe', 'register' => 'actionRegister', 'verify' => 'actionVerify',
    'resend-verification' => 'actionResendVerification', 'login' => 'actionLogin', 'logout' => 'actionLogout',
    'forgot' => 'actionForgot', 'reset' => 'actionReset', 'update-account' => 'actionUpdateAccount',
    'change-password' => 'actionChangePassword', 'delete-account' => 'actionDeleteAccount',
    'create' => 'actionCreate', 'get' => 'actionGet', 'image' => 'actionImage', 'thumb' => 'actionThumb',
    'update' => 'actionUpdate', 'mine' => 'actionMine', 'rename' => 'actionRename',
    'delete-project' => 'actionDeleteProject', 'new-edit-link' => 'actionNewEditLink',
    'osm' => 'actionOsm',
    'admin-stats' => 'actionAdminStats', 'admin-users' => 'actionAdminUsers', 'admin-projects' => 'actionAdminProjects',
    'admin-user' => 'actionAdminUser', 'admin-project' => 'actionAdminProject',
];
$action = $_GET['action'] ?? '';
if (!is_string($action) || !isset($routes[$action])) fail(400, 'Unknown action');
$routes[$action]();
