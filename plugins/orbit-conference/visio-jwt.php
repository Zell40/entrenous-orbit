<?php
/*
 * visio-jwt.php — exchange an IRC EXTJWT proof for a short-lived Jitsi JWT.
 *
 * Deploy beside orbit-conference.js under the SAME origin as Orbit, e.g.:
 *   /app/plugins/third/orbit-conference/visio-jwt.php
 *
 * Flow:
 *   1. Orbit (or another trusted bridge) requests EXTJWT from the IRC server.
 *   2. It POSTs the desired room + the EXTJWT as Bearer auth to this endpoint.
 *   3. This script verifies the EXTJWT with the ircd's secret, then signs
 *      a Jitsi JWT that only grants access to that one room for a short TTL.
 *
 * This lets registered users on OTHER IRC clients participate too, as long as
 * they can obtain a valid EXTJWT proof from the ircd.
 */
declare(strict_types=1);

$EXTJWT_SECRET = 'CHANGE_ME_EXTJWT_SECRET';
$JITSI_APP_ID = 'CHANGE_ME_JITSI_APP_ID';
$JITSI_APP_SECRET = 'CHANGE_ME_JITSI_APP_SECRET';
$JITSI_DOMAIN = 'visio.entrenous.chat';
$JWT_AUDIENCE = '';
$JWT_TTL = 300; // 5 minutes
$ALLOWED_CLOCK_SKEW = 30;
// Channel mode letters that grant Jitsi moderator (ISUPPORT PREFIX, not display chars).
// PREFIX=(qaohv)~&@%+  →  q=~  a=&  o=@  — matches conference.startPrefixes ~&@
$START_CMODES = ['q', 'a', 'o'];

$__local = __DIR__ . '/visio-jwt.local.php';
if (is_file($__local)
    && filesize($__local) < 4096
    && !str_contains((string)@file_get_contents($__local), 'function verify_extjwt')) {
  require $__local;
}

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
  header('Access-Control-Allow-Headers: Content-Type, Authorization');
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
/** Salon ops only. Private queries (no channel in the proof) keep moderator. */
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

if ($EXTJWT_SECRET === 'CHANGE_ME_EXTJWT_SECRET' || $JITSI_APP_ID === 'CHANGE_ME_JITSI_APP_ID' || $JITSI_APP_SECRET === 'CHANGE_ME_JITSI_APP_SECRET') {
  http_response_code(500);
  echo json_encode(['error' => 'server_not_configured']);
  exit;
}
$jwtAudience = $JWT_AUDIENCE !== '' ? $JWT_AUDIENCE : $JITSI_APP_ID;

$authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
if (!preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) {
  http_response_code(401);
  echo json_encode(['error' => 'missing_token']);
  exit;
}
$proof = trim($m[1]);
$claims = verify_extjwt($proof, $EXTJWT_SECRET);
if (!$claims) {
  http_response_code(401);
  echo json_encode(['error' => 'invalid_extjwt']);
  exit;
}

$raw = file_get_contents('php://input');
$req = json_decode((string)$raw, true);
if (!is_array($req)) $req = [];
$room = trim((string)($req['room'] ?? ''));
$channel = trim((string)($req['channel'] ?? ''));
if (!room_ok($room)) {
  http_response_code(400);
  echo json_encode(['error' => 'invalid_room']);
  exit;
}

$proofChannel = trim((string)($claims['channel'] ?? ''));
if ($channel !== '' && $proofChannel !== '' && strcasecmp($channel, $proofChannel) !== 0) {
  http_response_code(403);
  echo json_encode(['error' => 'channel_mismatch']);
  exit;
}
$account = trim((string)($claims['account'] ?? ''));
if ($account === '') {
  http_response_code(403);
  echo json_encode(['error' => 'account_required']);
  exit;
}

$nick = trim((string)($claims['sub'] ?? $account));
$startCmodes = is_array($START_CMODES) ? $START_CMODES : ['q', 'a', 'o'];
$isMod = is_jitsi_moderator($claims, $startCmodes);
$now = time();
$jwtClaims = [
  'aud' => $jwtAudience,
  'iss' => $JITSI_APP_ID,
  'sub' => $JITSI_DOMAIN,
  'room' => $room,
  'moderator' => $isMod,
  'iat' => $now,
  'nbf' => $now - $ALLOWED_CLOCK_SKEW,
  'exp' => $now + max(60, (int)$JWT_TTL),
  'context' => [
    'user' => [
      'id' => $account,
      'name' => $nick,
      'avatar' => '',
      'moderator' => $isMod,
      'affiliation' => $isMod ? 'owner' : 'member',
    ],
  ],
];

echo json_encode([
  'token' => sign_jitsi_jwt($jwtClaims, $JITSI_APP_SECRET),
  'exp' => $jwtClaims['exp'],
  'room' => $room,
  'account' => $account,
  'moderator' => $isMod,
], JSON_UNESCAPED_SLASHES);
