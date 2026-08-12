<?php
/**
 * avatars.php — same-origin POST /accounts/api/avatars/ for Orbit.
 *
 * Orbit (src/platform/avatars.ts) batches account lookups:
 *   POST { "accounts": ["zell", "bob"] }
 *   →  { "avatars": { "zell": "https://…/photo.jpg", "bob": null } }
 *
 * Keys in the response MUST be lowercase (Orbit caches / resolves that way).
 *
 * EntreNous: resolve each NickServ / WP login via the existing public REST
 * endpoint used by KiwiIRC (wp-anope-sync):
 *   GET {WP}/wp-json/entrenous/v1/profile?account=<login>
 *
 * Deploy at webchat root as avatars.php; config/.htaccess rewrites the Orbit
 * path. Optional overrides in avatars.local.php (never overwritten by deploy).
 */
declare(strict_types=1);

// --- defaults (override in avatars.local.php) --------------------------------
$WP_PROFILE_URL = 'https://www.reseau-entrenous.fr/wp-json/entrenous/v1/profile';
$HTTP_TIMEOUT   = 2.5;   // seconds per WP request
$MAX_ACCOUNTS   = 200;   // matches Orbit client cap
$CACHE_TTL      = 1800;  // seconds (30 min) — busy channels re-batch often
$CACHE_DIR      = sys_get_temp_dir() . '/orbit-avatars-cache';

$__avatars_local = __DIR__ . '/avatars.local.php';
if (is_file($__avatars_local)) {
    require $__avatars_local;
}

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    echo json_encode(['detail' => 'method_not_allowed']);
    exit;
}

$raw = file_get_contents('php://input') ?: '';
$body = json_decode($raw, true);
if (!is_array($body) || !isset($body['accounts']) || !is_array($body['accounts'])) {
    http_response_code(400);
    echo json_encode(['detail' => 'expected_json_accounts']);
    exit;
}

$accounts = [];
foreach ($body['accounts'] as $a) {
    if (!is_string($a)) {
        continue;
    }
    $a = trim($a);
    if ($a === '') {
        continue;
    }
    // NickServ / WP login hygiene
    if (!preg_match('/^[A-Za-z0-9_\[\]\\`|^{}-]{1,50}$/', $a)) {
        continue;
    }
    $accounts[] = $a;
    if (count($accounts) >= $MAX_ACCOUNTS) {
        break;
    }
}

$out = [];
$need = [];
foreach ($accounts as $account) {
    $key = strtolower($account);
    $cached = avatar_cache_get($CACHE_DIR, $key, $CACHE_TTL);
    if ($cached !== false) {
        $out[$key] = $cached; // string URL or null
        continue;
    }
    $need[$key] = $account; // preserve original casing for WP lookup
}

if ($need) {
    $fetched = avatar_fetch_batch($WP_PROFILE_URL, $need, $HTTP_TIMEOUT);
    foreach ($need as $key => $_orig) {
        $url = array_key_exists($key, $fetched) ? $fetched[$key] : null;
        avatar_cache_set($CACHE_DIR, $key, $url);
        $out[$key] = $url;
    }
}

echo json_encode(['avatars' => $out], JSON_UNESCAPED_SLASHES);

// -----------------------------------------------------------------------------

/**
 * @param array<string,string> $need map lowercase => original account
 * @return array<string, string|null>
 */
function avatar_fetch_batch(string $profileUrl, array $need, float $timeout): array
{
    $result = [];
    if ($need === []) {
        return $result;
    }

    if (function_exists('curl_multi_init')) {
        $mh = curl_multi_init();
        $handles = [];
        foreach ($need as $key => $account) {
            $url = $profileUrl . '?account=' . rawurlencode($account);
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_TIMEOUT        => $timeout,
                CURLOPT_CONNECTTIMEOUT => min(2.0, $timeout),
                CURLOPT_HTTPHEADER     => ['Accept: application/json'],
                CURLOPT_USERAGENT      => 'Orbit-EntreNous-avatars/1.0',
            ]);
            curl_multi_add_handle($mh, $ch);
            $handles[$key] = $ch;
        }

        $running = null;
        do {
            $status = curl_multi_exec($mh, $running);
            if ($running) {
                curl_multi_select($mh, 0.2);
            }
        } while ($running && $status === CURLM_OK);

        foreach ($handles as $key => $ch) {
            $body = curl_multi_getcontent($ch);
            $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
            $result[$key] = avatar_parse_profile_body(is_string($body) ? $body : '', $code);
        }
        curl_multi_close($mh);
        return $result;
    }

    // Fallback: sequential file_get_contents
    $ctx = stream_context_create([
        'http' => [
            'method'  => 'GET',
            'timeout' => $timeout,
            'header'  => "Accept: application/json\r\nUser-Agent: Orbit-EntreNous-avatars/1.0\r\n",
        ],
    ]);
    foreach ($need as $key => $account) {
        $url = $profileUrl . '?account=' . rawurlencode($account);
        $body = @file_get_contents($url, false, $ctx);
        $code = 0;
        if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s/', $http_response_header[0], $m)) {
            $code = (int) $m[1];
        }
        $result[$key] = avatar_parse_profile_body(is_string($body) ? $body : '', $code);
    }
    return $result;
}

function avatar_parse_profile_body(string $body, int $httpCode): ?string
{
    if ($httpCode !== 200 || $body === '') {
        return null;
    }
    $data = json_decode($body, true);
    if (!is_array($data) || empty($data['exists'])) {
        return null;
    }
    $avatar = $data['avatar'] ?? null;
    if (!is_string($avatar) || $avatar === '') {
        return null;
    }
    // Absolute http(s) only — relative / data: / javascript: rejected
    if (!preg_match('#^https?://#i', $avatar)) {
        return null;
    }
    return $avatar;
}

/** @return string|null|false  false = miss */
function avatar_cache_get(string $dir, string $key, int $ttl)
{
    if (function_exists('apcu_fetch')) {
        $ok = false;
        $val = apcu_fetch('orbit-av:' . $key, $ok);
        if ($ok) {
            return $val; // may be null
        }
    }
    $path = $dir . '/' . hash('sha256', $key) . '.json';
    if (!is_file($path)) {
        return false;
    }
    $raw = @file_get_contents($path);
    if ($raw === false) {
        return false;
    }
    $data = json_decode($raw, true);
    if (!is_array($data) || !isset($data['t']) || !array_key_exists('u', $data)) {
        return false;
    }
    if ((time() - (int) $data['t']) > $ttl) {
        @unlink($path);
        return false;
    }
    return $data['u']; // string|null
}

function avatar_cache_set(string $dir, string $key, ?string $url): void
{
    if (function_exists('apcu_store')) {
        // TTL mirrored from caller defaults; APCu ignores if extension missing.
        apcu_store('orbit-av:' . $key, $url, 1800);
    }
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
    }
    $path = $dir . '/' . hash('sha256', $key) . '.json';
    @file_put_contents($path, json_encode(['t' => time(), 'u' => $url], JSON_UNESCAPED_SLASHES), LOCK_EX);
}
