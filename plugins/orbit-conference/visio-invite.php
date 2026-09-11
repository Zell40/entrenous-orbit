<?php
/*
 * visio-invite.php — account-bound conference invites for non-Orbit clients.
 *
 * Deploy beside visio-jwt.php under the SAME origin as Orbit:
 *   /app/plugins/third/orbit-conference/visio-invite.php
 *
 * Actions (JSON POST body "action", or ?action=):
 *   create  — Orbit starter (Bearer EXTJWT): register room + invited NickServ accounts
 *   add     — Orbit (Bearer EXTJWT): add more accounts to an existing session
 *   end     — Orbit starter (Bearer EXTJWT): remove session when visio stops
 *   mine    — WP server-to-server (X-Visio-Invite-Secret): list open invites for an account
 *   redeem  — WP server-to-server: consume invite → short-lived Jitsi JWT
 *
 * Secrets: same visio-jwt.local.php (+ $INVITE_SHARED_SECRET for WP).
 */
declare(strict_types=1);

$EXTJWT_SECRET = 'CHANGE_ME_EXTJWT_SECRET';
$JITSI_APP_ID = 'CHANGE_ME_JITSI_APP_ID';
$JITSI_APP_SECRET = 'CHANGE_ME_JITSI_APP_SECRET';
$JITSI_DOMAIN = 'visio.entrenous.chat';
$JWT_AUDIENCE = '';
$JWT_TTL = 300;
$ALLOWED_CLOCK_SKEW = 30;
$START_CMODES = ['q', 'a', 'o'];
$INVITE_SHARED_SECRET = 'CHANGE_ME_INVITE_SHARED_SECRET';
$INVITE_TTL = 3600; // session lifetime (1h)
// Writable data dir (plugin dir itself is often owned by deploy user, not www-data).
$INVITE_DATA_DIR = __DIR__ . '/visio-invite-data';
$INVITE_STORE = $INVITE_DATA_DIR . '/visio-invites.json';
$INVITE_MAX_REDEEMS = 10; // reconnects / retries without re-invite

$__local = __DIR__ . '/visio-jwt.local.php';
if (is_file($__local)
    && filesize($__local) < 8192
    && !str_contains((string)@file_get_contents($__local), 'function verify_extjwt')) {
  require $__local;
}
$INVITE_STORE = rtrim((string)$INVITE_DATA_DIR, "/\\") . '/visio-invites.json';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
  header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Visio-Invite-Secret');
  header('Access-Control-Allow-Methods: POST, OPTIONS');
  http_response_code(204);
  exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
  http_response_code(405);
  header('Allow: POST, OPTIONS');
  echo json_encode(['error' => 'post_only']);
  exit;
}

function base64url_encode(string $bin): string {
  return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}
function base64url_decode(string $data): string|false {
  $b64 = strtr($data, '-_', '+/');
  $pad = strlen($b64) % 4;
  if ($pad) $b64 .= str_repeat('=', 4 - $pad);
  return base64_decode($b64, true);
}
function verify_extjwt(string $token, string $secret): ?array {
  $parts = explode('.', $token);
  if (count($parts) !== 3) return null;
  [$h64, $p64, $s64] = $parts;
  $header = json_decode((string)base64url_decode($h64), true);
  if (!is_array($header) || strtoupper((string)($header['alg'] ?? '')) !== 'HS256') return null;
  $sig = base64url_decode($s64);
  if ($sig === false) return null;
  $calc = hash_hmac('sha256', "$h64.$p64", $secret, true);
  if (!hash_equals($calc, $sig)) return null;
  $payload = json_decode((string)base64url_decode($p64), true);
  if (!is_array($payload)) return null;
  if (isset($payload['exp']) && time() > (int)$payload['exp']) return null;
  return $payload;
}
function sign_jitsi_jwt(array $claims, string $secret): string {
  $header = ['alg' => 'HS256', 'typ' => 'JWT'];
  $h64 = base64url_encode(json_encode($header, JSON_UNESCAPED_SLASHES));
  $p64 = base64url_encode(json_encode($claims, JSON_UNESCAPED_SLASHES));
  $sig = hash_hmac('sha256', "$h64.$p64", $secret, true);
  return $h64 . '.' . $p64 . '.' . base64url_encode($sig);
}
function room_ok(string $room): bool {
  return $room !== '' && preg_match('/^[A-Za-z0-9._-]{1,90}$/', $room) === 1;
}
function chan_key(string $name): string {
  return strtolower(ltrim($name, '#&+!'));
}
function acct_key(string $account): string {
  return strtolower(trim($account));
}
function extjwt_cmodes(array $claims): array {
  $raw = $claims['cmodes'] ?? [];
  if (is_string($raw)) {
    return preg_split('//u', $raw, -1, PREG_SPLIT_NO_EMPTY) ?: [];
  }
  if (!is_array($raw)) return [];
  $out = [];
  foreach ($raw as $m) {
    $m = trim((string)$m);
    if ($m !== '') $out[] = $m;
  }
  return $out;
}
function is_jitsi_moderator(array $claims, array $startCmodes): bool {
  $channel = trim((string)($claims['channel'] ?? ''));
  if ($channel === '' || $channel === '*') return true;
  $have = extjwt_cmodes($claims);
  foreach ($startCmodes as $need) {
    $need = trim((string)$need);
    if ($need !== '' && in_array($need, $have, true)) return true;
  }
  return false;
}

function invite_load(string $path): array {
  if (!is_file($path)) return ['sessions' => []];
  $raw = @file_get_contents($path);
  $data = json_decode((string)$raw, true);
  if (!is_array($data) || !isset($data['sessions']) || !is_array($data['sessions'])) {
    return ['sessions' => []];
  }
  return $data;
}
function invite_ensure_dir(string $dir): bool {
  if (is_dir($dir)) return is_writable($dir);
  if (!@mkdir($dir, 02775, true) && !is_dir($dir)) return false;
  @chmod($dir, 02775);
  // Deny web access to JSON store if Apache allows .htaccess
  $ht = $dir . '/.htaccess';
  if (!is_file($ht)) {
    @file_put_contents($ht, "Require all denied\n");
  }
  return is_writable($dir);
}
function invite_save(string $path, array $data): bool {
  $dir = dirname($path);
  if (!invite_ensure_dir($dir)) {
    error_log('visio-invite: data dir not writable: ' . $dir);
    return false;
  }
  $json = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
  if ($json === false) return false;
  $tmp = $path . '.tmp.' . getmypid();
  if (@file_put_contents($tmp, $json, LOCK_EX) === false) {
    error_log('visio-invite: file_put_contents failed: ' . $tmp . ' — ' . (error_get_last()['message'] ?? ''));
    return false;
  }
  if (!@rename($tmp, $path)) {
    @unlink($tmp);
    error_log('visio-invite: rename failed to ' . $path);
    return false;
  }
  @chmod($path, 0664);
  return true;
}
function invite_purge(array &$data, int $now): void {
  $sessions = [];
  foreach ($data['sessions'] as $sess) {
    if (!is_array($sess)) continue;
    if ((int)($sess['exp'] ?? 0) < $now) continue;
    $sessions[] = $sess;
  }
  $data['sessions'] = $sessions;
}
function normalize_accounts(array $list): array {
  $out = [];
  foreach ($list as $a) {
    $a = trim((string)$a);
    if ($a === '' || strlen($a) > 64) continue;
    if (!preg_match('/^[A-Za-z0-9_\[\]\\\\^{|}`-]+$/', $a)) continue;
    $out[acct_key($a)] = $a;
  }
  return array_values($out);
}

if ($EXTJWT_SECRET === 'CHANGE_ME_EXTJWT_SECRET'
    || $JITSI_APP_ID === 'CHANGE_ME_JITSI_APP_ID'
    || $JITSI_APP_SECRET === 'CHANGE_ME_JITSI_APP_SECRET') {
  http_response_code(500);
  echo json_encode(['error' => 'server_not_configured']);
  exit;
}

$jwtAudience = $JWT_AUDIENCE !== '' ? $JWT_AUDIENCE : $JITSI_APP_ID;
$startCmodes = is_array($START_CMODES) ? $START_CMODES : ['q', 'a', 'o'];
$inviteTtl = max(300, (int)$INVITE_TTL);
$maxRedeems = max(1, (int)$INVITE_MAX_REDEEMS);
$inviteSecretConfigured = !($INVITE_SHARED_SECRET === 'CHANGE_ME_INVITE_SHARED_SECRET' || $INVITE_SHARED_SECRET === '');

$raw = file_get_contents('php://input');
$req = json_decode((string)$raw, true);
if (!is_array($req)) $req = [];
$action = strtolower(trim((string)($req['action'] ?? ($_GET['action'] ?? ''))));

function require_extjwt_auth(string $secret): array {
  $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
  if (!preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) {
    http_response_code(401);
    echo json_encode(['error' => 'missing_token']);
    exit;
  }
  $claims = verify_extjwt(trim($m[1]), $secret);
  if (!$claims) {
    http_response_code(401);
    echo json_encode(['error' => 'invalid_extjwt']);
    exit;
  }
  $account = trim((string)($claims['account'] ?? ''));
  if ($account === '') {
    http_response_code(403);
    echo json_encode(['error' => 'account_required']);
    exit;
  }
  return $claims;
}

function require_invite_secret(string $expected, bool $configured): void {
  if (!$configured) {
    http_response_code(500);
    echo json_encode(['error' => 'invite_secret_not_configured']);
    exit;
  }
  $got = trim((string)($_SERVER['HTTP_X_VISIO_INVITE_SECRET'] ?? ''));
  if ($got === '' || !hash_equals($expected, $got)) {
    http_response_code(401);
    echo json_encode(['error' => 'invalid_invite_secret']);
    exit;
  }
}

$now = time();
$data = invite_load($INVITE_STORE);
invite_purge($data, $now);

if ($action === 'create' || $action === 'add') {
  $claims = require_extjwt_auth($EXTJWT_SECRET);
  $room = trim((string)($req['room'] ?? ''));
  $channel = trim((string)($req['channel'] ?? ''));
  $accounts = $req['accounts'] ?? [];
  if (!is_array($accounts)) $accounts = [];
  if (!room_ok($room)) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid_room']);
    exit;
  }
  $proofChannel = trim((string)($claims['channel'] ?? ''));
  if ($channel !== '' && $proofChannel !== '' && $proofChannel !== '*'
      && strcasecmp(chan_key($channel), chan_key($proofChannel)) !== 0) {
    http_response_code(403);
    echo json_encode(['error' => 'channel_mismatch']);
    exit;
  }
  $starter = trim((string)($claims['account'] ?? ''));
  $normalized = normalize_accounts($accounts);
  // Always include the starter so they appear in "mine" if needed.
  if ($starter !== '') {
    $normalized = normalize_accounts(array_merge($normalized, [$starter]));
  }

  $foundIdx = null;
  foreach ($data['sessions'] as $i => $sess) {
    if (!is_array($sess)) continue;
    if (strcasecmp((string)($sess['room'] ?? ''), $room) === 0) {
      $foundIdx = $i;
      break;
    }
  }

  if ($action === 'create' || $foundIdx === null) {
    $invites = [];
    foreach ($normalized as $acct) {
      $invites[acct_key($acct)] = [
        'account' => $acct,
        'redeems' => 0,
      ];
    }
    $sess = [
      'room' => $room,
      'channel' => $channel !== '' ? $channel : ($proofChannel !== '*' ? $proofChannel : ''),
      'startedBy' => $starter,
      'created' => $now,
      'exp' => $now + $inviteTtl,
      'invites' => $invites,
    ];
    if ($foundIdx !== null) {
      // Refresh existing session on recreate.
      $data['sessions'][$foundIdx] = $sess;
    } else {
      $data['sessions'][] = $sess;
    }
  } else {
    $sess = $data['sessions'][$foundIdx];
    if (!isset($sess['invites']) || !is_array($sess['invites'])) $sess['invites'] = [];
    foreach ($normalized as $acct) {
      $k = acct_key($acct);
      if (!isset($sess['invites'][$k])) {
        $sess['invites'][$k] = ['account' => $acct, 'redeems' => 0];
      }
    }
    $sess['exp'] = max((int)($sess['exp'] ?? 0), $now + $inviteTtl);
    $data['sessions'][$foundIdx] = $sess;
  }

  if (!invite_save($INVITE_STORE, $data)) {
    http_response_code(500);
    echo json_encode(['error' => 'store_failed']);
    exit;
  }
  $outSess = $foundIdx !== null ? $data['sessions'][$foundIdx] : $data['sessions'][count($data['sessions']) - 1];
  // After create path, re-read last written
  foreach ($data['sessions'] as $s) {
    if (is_array($s) && strcasecmp((string)($s['room'] ?? ''), $room) === 0) $outSess = $s;
  }
  echo json_encode([
    'ok' => true,
    'room' => $room,
    'channel' => (string)($outSess['channel'] ?? $channel),
    'exp' => (int)($outSess['exp'] ?? ($now + $inviteTtl)),
    'accounts' => array_values(array_map(static function ($inv) {
      return (string)($inv['account'] ?? '');
    }, $outSess['invites'] ?? [])),
  ], JSON_UNESCAPED_SLASHES);
  exit;
}

if ($action === 'mine' || $action === 'redeem') {
  require_invite_secret($INVITE_SHARED_SECRET, $inviteSecretConfigured);
  $account = trim((string)($req['account'] ?? ''));
  if ($account === '' || strlen($account) > 64) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid_account']);
    exit;
  }
  $akey = acct_key($account);

  if ($action === 'mine') {
    $list = [];
    foreach ($data['sessions'] as $sess) {
      if (!is_array($sess)) continue;
      $inv = $sess['invites'][$akey] ?? null;
      if (!is_array($inv)) continue;
      $redeems = (int)($inv['redeems'] ?? 0);
      if ($redeems >= $maxRedeems) continue;
      $list[] = [
        'room' => (string)($sess['room'] ?? ''),
        'channel' => (string)($sess['channel'] ?? ''),
        'startedBy' => (string)($sess['startedBy'] ?? ''),
        'exp' => (int)($sess['exp'] ?? 0),
        'redeemsLeft' => $maxRedeems - $redeems,
      ];
    }
    echo json_encode(['ok' => true, 'invites' => $list], JSON_UNESCAPED_SLASHES);
    exit;
  }

  // redeem
  $room = trim((string)($req['room'] ?? ''));
  if (!room_ok($room)) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid_room']);
    exit;
  }
  $foundIdx = null;
  foreach ($data['sessions'] as $i => $sess) {
    if (!is_array($sess)) continue;
    if (strcasecmp((string)($sess['room'] ?? ''), $room) !== 0) continue;
    if (!isset($sess['invites'][$akey]) || !is_array($sess['invites'][$akey])) continue;
    $foundIdx = $i;
    break;
  }
  if ($foundIdx === null) {
    http_response_code(403);
    echo json_encode(['error' => 'no_invite']);
    exit;
  }
  $sess = $data['sessions'][$foundIdx];
  $inv = $sess['invites'][$akey];
  $redeems = (int)($inv['redeems'] ?? 0);
  if ($redeems >= $maxRedeems) {
    http_response_code(403);
    echo json_encode(['error' => 'invite_exhausted']);
    exit;
  }
  $sess['invites'][$akey]['redeems'] = $redeems + 1;
  $data['sessions'][$foundIdx] = $sess;
  if (!invite_save($INVITE_STORE, $data)) {
    http_response_code(500);
    echo json_encode(['error' => 'store_failed']);
    exit;
  }

  $displayName = trim((string)($inv['account'] ?? $account));
  $jwtClaims = [
    'aud' => $jwtAudience,
    'iss' => $JITSI_APP_ID,
    'sub' => $JITSI_DOMAIN,
    'room' => $room,
    'moderator' => false,
    'iat' => $now,
    'nbf' => $now - $ALLOWED_CLOCK_SKEW,
    'exp' => $now + max(60, (int)$JWT_TTL),
    'context' => [
      'user' => [
        'id' => $displayName,
        'name' => $displayName,
        'avatar' => '',
        'moderator' => false,
        'affiliation' => 'member',
      ],
    ],
  ];
  $token = sign_jitsi_jwt($jwtClaims, $JITSI_APP_SECRET);
  echo json_encode([
    'ok' => true,
    'token' => $token,
    'exp' => $jwtClaims['exp'],
    'room' => $room,
    'channel' => (string)($sess['channel'] ?? ''),
    'account' => $displayName,
    'domain' => $JITSI_DOMAIN,
    'url' => 'https://' . $JITSI_DOMAIN . '/' . rawurlencode($room) . '?jwt=' . rawurlencode($token),
  ], JSON_UNESCAPED_SLASHES);
  exit;
}

if ($action === 'end') {
  $claims = require_extjwt_auth($EXTJWT_SECRET);
  $room = trim((string)($req['room'] ?? ''));
  if (!room_ok($room)) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid_room']);
    exit;
  }
  $kept = [];
  $removed = false;
  foreach ($data['sessions'] as $sess) {
    if (!is_array($sess)) continue;
    if (strcasecmp((string)($sess['room'] ?? ''), $room) === 0) {
      $removed = true;
      continue;
    }
    $kept[] = $sess;
  }
  $data['sessions'] = $kept;
  if ($removed && !invite_save($INVITE_STORE, $data)) {
    http_response_code(500);
    echo json_encode(['error' => 'store_failed']);
    exit;
  }
  echo json_encode([
    'ok' => true,
    'removed' => $removed,
    'room' => $room,
    'by' => (string)($claims['account'] ?? ''),
  ], JSON_UNESCAPED_SLASHES);
  exit;
}

http_response_code(400);
echo json_encode(['error' => 'unknown_action', 'actions' => ['create', 'add', 'end', 'mine', 'redeem']]);
