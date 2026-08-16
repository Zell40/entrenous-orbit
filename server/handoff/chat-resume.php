<?php
/**
 * Mint a fresh SASL OAUTHBEARER JWT for Orbit session resume / reconnect.
 *
 * Orbit calls GET /accounts/api/chat_resume/ (see config/.htaccess) with cookies.
 * The HttpOnly cookie `orbit_en_resume` is set by handoff.php at login.
 *
 * Secrets live in chat-resume.local.php (not in git) — same HS256 secret as
 * WordPress MonIdentité / InspIRCd oauthbearer.
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] !== 'GET' && $_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'method']);
    exit;
}

$local = __DIR__ . '/chat-resume.local.php';
if (!is_readable($local)) {
    http_response_code(503);
    echo json_encode(['ok' => false, 'error' => 'not_configured']);
    exit;
}
/** @var array{jwt_secret:string,issuer?:string,ttl?:int} $cfg */
$cfg = require $local;
$secret = (string)($cfg['jwt_secret'] ?? '');
$issuer = (string)($cfg['issuer'] ?? 'EntreNous');
$ttl = (int)($cfg['ttl'] ?? 3600);
if ($secret === '' || $ttl < 60) {
    http_response_code(503);
    echo json_encode(['ok' => false, 'error' => 'not_configured']);
    exit;
}

$raw = $_COOKIE['orbit_en_resume'] ?? '';
if ($raw === '') {
    http_response_code(401);
    echo json_encode(['ok' => false, 'error' => 'no_session']);
    exit;
}

function b64url_decode_str(string $s): string {
    $b = strtr($s, '-_', '+/');
    $pad = strlen($b) % 4;
    if ($pad) {
        $b .= str_repeat('=', 4 - $pad);
    }
    $out = base64_decode($b, true);
    return $out === false ? '' : $out;
}

function b64url_encode_bin(string $bin): string {
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

$decoded = b64url_decode_str($raw);
$parts = explode("\n", $decoded);
$n = count($parts);
// Legacy: nick \n account \n exp \n sig (4)
// Current: nick \n account \n exp \n realname \n sig (5) — realname may be empty
if ($n !== 4 && $n !== 5) {
    http_response_code(401);
    echo json_encode(['ok' => false, 'error' => 'bad_cookie']);
    exit;
}
$nick = $parts[0];
$account = $parts[1];
$expStr = $parts[2];
$realname = '';
if ($n === 5) {
    $realname = $parts[3];
    $sig = $parts[4];
    $payload = $nick . "\n" . $account . "\n" . $expStr . "\n" . $realname;
} else {
    $sig = $parts[3];
    $payload = $nick . "\n" . $account . "\n" . $expStr;
}
$exp = (int)$expStr;
$expect = hash_hmac('sha256', $payload, $secret);
if (!hash_equals($expect, $sig) || $exp < time() || $nick === '' || $account === '') {
    http_response_code(401);
    echo json_encode(['ok' => false, 'error' => 'expired']);
    exit;
}

// WordPress profile is the source of truth for âge / genre / ville (GECOS).
$WP_PROFILE_URL = 'https://www.reseau-entrenous.fr/wp-json/entrenous/v1/profile';
if (!empty($cfg['wp_profile_url']) && is_string($cfg['wp_profile_url'])) {
    $WP_PROFILE_URL = $cfg['wp_profile_url'];
}
require __DIR__ . '/wp-profile-gecos.inc.php';
$wpRealname = entrenous_fetch_wp_gecos($account, $WP_PROFILE_URL, 2.5);
if ($wpRealname !== '') {
    $realname = $wpRealname;
}

$header = b64url_encode_bin(json_encode(['alg' => 'HS256', 'typ' => 'JWT'], JSON_UNESCAPED_SLASHES));
$body = b64url_encode_bin(json_encode([
    'sub' => $account,
    'iss' => $issuer,
    'exp' => time() + $ttl,
], JSON_UNESCAPED_SLASHES));
$sigJwt = b64url_encode_bin(hash_hmac('sha256', $header . '.' . $body, $secret, true));
$jwt = $header . '.' . $body . '.' . $sigJwt;

$out = [
    'ok' => true,
    'keycard' => $jwt,
    'nick' => $nick,
];
if ($realname !== '') {
    $out['realname'] = $realname;
}
echo json_encode($out, JSON_UNESCAPED_SLASHES);
