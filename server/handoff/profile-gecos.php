<?php
/**
 * Same-origin ASL lookup for Orbit (WP profile = source of truth).
 *
 *   GET /accounts/api/profile_gecos/?account=Zell
 *   → { "ok": true, "realname": "40 - Homme - Paris" }
 *
 * Proxies the public WordPress REST profile used by Kiwi/avatars, so the
 * browser never needs CORS to reseau-entrenous.fr.
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'method']);
    exit;
}

$WP_PROFILE_URL = 'https://www.reseau-entrenous.fr/wp-json/entrenous/v1/profile';
$HTTP_TIMEOUT = 2.5;
$local = __DIR__ . '/chat-resume.local.php';
if (is_readable($local)) {
    /** @var array{wp_profile_url?:string} $cfg */
    $cfg = require $local;
    if (!empty($cfg['wp_profile_url']) && is_string($cfg['wp_profile_url'])) {
        $WP_PROFILE_URL = $cfg['wp_profile_url'];
    }
}

require __DIR__ . '/wp-profile-gecos.inc.php';

$account = isset($_GET['account']) ? trim((string) $_GET['account']) : '';
if ($account === '') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'missing_account']);
    exit;
}

$realname = entrenous_fetch_wp_gecos($account, $WP_PROFILE_URL, $HTTP_TIMEOUT);
if ($realname === '') {
    echo json_encode(['ok' => true, 'realname' => null, 'exists' => false], JSON_UNESCAPED_SLASHES);
    exit;
}
echo json_encode(['ok' => true, 'realname' => $realname, 'exists' => true], JSON_UNESCAPED_SLASHES);
