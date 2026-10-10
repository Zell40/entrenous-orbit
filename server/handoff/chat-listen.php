<?php
/**
 * Refresh orbit_en_listen *before* the IRC WebSocket opens.
 *
 * Apache on irc.* routes wss → InspIRCd CP (8197) or normal (8107) from this
 * cookie. Reconnects from the Orbit join form (parked NickServ password, guest
 * ASL) never hit chat_resume/handoff — without this endpoint an adult can stay
 * stuck on Websocket-CP after a leftover `cp` cookie.
 *
 *   GET /app/accounts/api/chat_listen/?account=Zell
 *   GET /accounts/api/chat_listen/?age=40
 *   → { "ok": true, "listen": "reg"|"cp" }
 *
 * Account (WP profile age) wins over a raw age= query when both are present.
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
/** @var array{wp_profile_url?:string,listen_cookie_domain?:string} $cfg */
$cfg = [];
if (is_readable($local)) {
    $cfg = require $local;
    if (!is_array($cfg)) {
        $cfg = [];
    }
    if (!empty($cfg['wp_profile_url']) && is_string($cfg['wp_profile_url'])) {
        $WP_PROFILE_URL = $cfg['wp_profile_url'];
    }
}

require __DIR__ . '/wp-profile-gecos.inc.php';

$account = isset($_GET['account']) ? trim((string) $_GET['account']) : '';
$ageParam = isset($_GET['age']) ? trim((string) $_GET['age']) : '';
$age = null;
if ($ageParam !== '' && preg_match('/^\d{1,3}$/', $ageParam)) {
    $n = (int) $ageParam;
    if ($n >= 1 && $n <= 120) {
        $age = $n;
    }
}

if ($account !== '') {
    $wpProfile = entrenous_fetch_wp_profile($account, $WP_PROFILE_URL, $HTTP_TIMEOUT);
    $gecos = $wpProfile !== null ? entrenous_build_gecos_from_profile($wpProfile) : '';
    $fromWp = entrenous_age_from_profile_or_gecos($wpProfile, $gecos);
    if ($fromWp !== null) {
        $age = $fromWp;
    }
}

if ($age === null && $account === '') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'missing_age_or_account']);
    exit;
}

$listen = entrenous_listen_from_age($age, $account);
$listenDomain = isset($cfg['listen_cookie_domain']) && is_string($cfg['listen_cookie_domain'])
    ? $cfg['listen_cookie_domain']
    : '.entrenous.chat';
$listenOpts = [];
if ($listenDomain !== '') {
    $listenOpts['domain'] = $listenDomain;
}
entrenous_set_listen_cookie($listen, $listenOpts);

echo json_encode([
    'ok' => true,
    'listen' => $listen,
    'age' => $age,
], JSON_UNESCAPED_SLASHES);
