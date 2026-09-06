<?php
/**
 * Mint a fresh SASL OAUTHBEARER JWT for Orbit session resume / reconnect.
 *
 * Orbit calls GET /app/accounts/api/chat_resume/ (Alias /app → WEBROOT) or
 * GET /accounts/api/chat_resume/ with cookies.
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

/** Every orbit_en_resume value on the request (host-only + Domain= duplicates). */
function orbit_resume_cookie_values(): array {
    $out = [];
    $hdr = (string)($_SERVER['HTTP_COOKIE'] ?? '');
    foreach (explode(';', $hdr) as $part) {
        $part = trim($part);
        $eq = strpos($part, '=');
        if ($eq === false) {
            continue;
        }
        if (trim(substr($part, 0, $eq)) !== 'orbit_en_resume') {
            continue;
        }
        $val = rawurldecode(trim(substr($part, $eq + 1)));
        if ($val !== '') {
            $out[] = $val;
        }
    }
    if (!$out && !empty($_COOKIE['orbit_en_resume'])) {
        $out[] = (string)$_COOKIE['orbit_en_resume'];
    }
    return array_values(array_unique($out));
}

/**
 * @return array{nick:string,account:string,realname:string}|null
 */
function orbit_parse_resume_cookie(string $raw, string $secret): ?array {
    $decoded = b64url_decode_str($raw);
    $parts = explode("\n", $decoded);
    $n = count($parts);
    // Legacy: nick \n account \n exp \n sig (4)
    // Current: nick \n account \n exp \n realname \n sig (5) — realname may be empty
    if ($n !== 4 && $n !== 5) {
        return null;
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
        return null;
    }
    return ['nick' => $nick, 'account' => $account, 'realname' => $realname];
}

$raws = orbit_resume_cookie_values();
if (!$raws) {
    // Expected when the tab was opened without a WordPress handoff (guest,
    // join form, leftover localStorage). Not an auth failure — Orbit just
    // keeps the in-memory JWT. HTTP 200 so the browser console stays clean.
    echo json_encode(['ok' => false, 'error' => 'no_session']);
    exit;
}

$parsed = null;
foreach ($raws as $raw) {
    $parsed = orbit_parse_resume_cookie($raw, $secret);
    if ($parsed !== null) {
        break;
    }
}
if ($parsed === null) {
    echo json_encode(['ok' => false, 'error' => 'expired']);
    exit;
}
$nick = $parsed['nick'];
$account = $parsed['account'];
$realname = $parsed['realname'];

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
    'account' => $account,
];
if ($realname !== '') {
    $out['realname'] = $realname;
}
echo json_encode($out, JSON_UNESCAPED_SLASHES);
