<?php
/**
 * Expire the HttpOnly `orbit_en_resume` cookie (leave chat / /logout).
 * JS cannot delete HttpOnly cookies; Orbit POSTs here from clearResume().
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST' && ($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'method']);
    exit;
}

$clear = [
    'expires'  => time() - 3600,
    'path'     => '/',
    'secure'   => true,
    'httponly' => true,
    'samesite' => 'Lax',
];
setcookie('orbit_en_resume', '', $clear);
$local = __DIR__ . '/chat-resume.local.php';
$domain = '';
if (is_readable($local)) {
    $cfg = require $local;
    if (is_array($cfg) && isset($cfg['listen_cookie_domain']) && is_string($cfg['listen_cookie_domain'])) {
        $domain = $cfg['listen_cookie_domain'];
    }
}
if ($domain === '') {
    $domain = '.entrenous.chat';
}
if ($domain !== '') {
    setcookie('orbit_en_resume', '', $clear + ['domain' => $domain]);
}

echo json_encode(['ok' => true]);
