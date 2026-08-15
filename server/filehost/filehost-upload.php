<?php
/*
 * filehost-upload.php — same-origin /upload endpoint for Orbit's OWN,
 * built-in image/voice-message sharing (the composer's image button and the
 * voice recorder — see src/core/store/upload.ts). This is unrelated to the
 * room-gallery plugin's room-images.php; that one is only for channel
 * pictures. This one is core Orbit's general "/FILEHOST" upload feature.
 *
 * Why this exists / how the pieces fit together:
 *   - Orbit's client always does two things when a user attaches an image or
 *     records a voice note: it sends the raw IRC command `FILEHOST`, then —
 *     once it gets back a NOTICE containing a `token=` — it POSTs the file
 *     to its OWN origin's literal `/upload?token=...` path. Nothing about
 *     this is IRC-standard; Orbit only greps the NOTICE text for `token=`
 *     and ALWAYS posts to its own relative `/upload`, no matter what base
 *     URL an ircd module advertises.
 *   - The NOTICE/token side is handled by the ircv3_filehost InspIRCd v4
 *     module (m_ircv3_filehost.so, `/// $ModDesc: Provides the DRAFT
 *     FILEHOST IRCv3 extension`). On `/FILEHOST`, it checks the user is
 *     logged in to services, then signs an HS256 JWT (subject = the user's
 *     current nick, configurable issuer/secret/expiry via its `<filehost>`
 *     config block) and NOTICEs back `<website>/upload?token=<jwt>`.
 *   - THIS script is the other half: it verifies that same JWT and actually
 *     stores the file. It deliberately never reads or trusts the module's
 *     own `website` setting for anything at the HTTP layer — only
 *     $JWT_SECRET and $JWT_ISSUER below have to match the ircd's
 *     `<filehost>` config. Where files actually get stored/served from is
 *     entirely controlled by $UPLOAD_DIR/$PUBLIC_URL_PATH/$PUBLIC_ORIGIN
 *     below, so this keeps working correctly even if `website` is wrong,
 *     unset, or points somewhere unreachable — change constants here,
 *     nothing else. ($PUBLIC_URL_PATH defaults to `/files` to match the
 *     module's own hardcoded `<website>/files/<name>` assumption — see its
 *     OnUserPreMessage/requiressl logic — but Orbit itself doesn't care
 *     either way, it only ever reads the JSON `url` this script returns.)
 *   - The returned `url` MUST be absolute (`https://host/files/x.png`, not
 *     just `/files/x.png`): Orbit's own message renderer only turns
 *     `https?://...` runs into inline image/audio cards (see
 *     src/lib/format.tsx) — a bare path is shown as plain, unclickable
 *     text instead. $PUBLIC_ORIGIN below is auto-detected from the
 *     request by default; only set it if that guess is ever wrong.
 *
 * Deployment (Apache2 — see public/.htaccess for the matching rewrite):
 *   1. Drop this file at a path reachable under the SAME origin as the
 *      webchat (default assumption: the web root, next to room-images.php
 *      if you also use the room-gallery plugin). Make sure PHP can create
 *      the upload directory ($UPLOAD_DIR) next to it.
 *   2. Set $JWT_SECRET / $JWT_ISSUER below to EXACTLY match your ircd's
 *      `<filehost jwt_secret="..." jwt_issuer="...">` config block.
 *   3. Orbit always POSTs to the literal path `/upload` — it has no idea
 *      this file is even called filehost-upload.php. public/.htaccess
 *      rewrites `/upload` to this script; adjust it if you deploy this
 *      script somewhere other than the web root.
 *   4. Make sure php.ini's `upload_max_filesize` / `post_max_size` are both
 *      at least as big as $MAX_UPLOAD_BYTES, otherwise PHP silently drops
 *      the upload before this script ever runs.
 *   5. deploy.sh already excludes $UPLOAD_DIR's directory name from its
 *      rsync mirror step, so redeploying the app never wipes uploaded
 *      files — if you use a different deploy process, do the same.
 */

$JWT_SECRET       = 'CHANGE_ME';    // must match your ircd's <filehost jwt_secret="...">
$JWT_ISSUER       = 'FILEHOST';     // must match your ircd's <filehost jwt_issuer="..."> (its own default)
$UPLOAD_DIR       = __DIR__ . '/files';   // where uploaded files are actually stored
$PUBLIC_URL_PATH  = '/files';              // <-- the ONLY thing to change if you move $UPLOAD_DIR or this script
// Scheme+host prepended to $PUBLIC_URL_PATH to build the URL returned to
// Orbit. MUST be an absolute http(s) URL, not just a path: Orbit's message
// renderer (src/lib/format.tsx) only turns `https?://...` runs into inline
// image/audio cards — a bare path like "/files/x.png" is shown as plain,
// non-clickable text instead (same origin or not doesn't matter, only the
// scheme prefix does). Leave empty to auto-detect from the request (right
// for the vast majority of setups, including behind a reverse proxy that
// sets X-Forwarded-Proto); override only if auto-detection guesses wrong
// (e.g. an unusual proxy setup).
$PUBLIC_ORIGIN    = '';
$MAX_UPLOAD_BYTES = 16 * 1024 * 1024;      // matches Orbit's own client-side cap (src/core/store/upload.ts)
$ALLOWED_UPLOAD_MIME = [
  // Images — Orbit's composer button accepts any `image/*`.
  'image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp',
  // Voice messages — whichever the browser's MediaRecorder produced (see
  // src/components/chat/composer/useVoiceRecorder.ts).
  'audio/webm' => 'webm', 'audio/ogg' => 'ogg', 'audio/mp4' => 'm4a',
];

// deploy.sh always overwrites THIS file with the latest version from git on
// every deploy (so bugfixes here reach you automatically) — which would
// normally wipe out $JWT_SECRET above back to the CHANGE_ME placeholder
// every time. To avoid that, put your real secret in a sibling
// filehost-upload.local.php instead (same directory, never touched by
// deploy.sh, not tracked by git — see .gitignore's `*.local.php`):
//   <?php
//   $JWT_SECRET = 'the-real-secret';
// It's simply require()'d here if present, and can override any of the
// variables above.
$__filehost_local = __DIR__ . '/filehost-upload.local.php';
if (is_file($__filehost_local)) require $__filehost_local;

header('Content-Type: application/json; charset=utf-8');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
  http_response_code(405); echo json_encode(['detail' => 'method_not_allowed']); exit;
}

// Auto-detects "scheme://host" from the request when $PUBLIC_ORIGIN is left
// empty, honouring X-Forwarded-Proto/Host from a reverse proxy if present.
function detect_origin(): string {
  $proto = $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '';
  $https = str_contains(strtolower($proto), 'https')
    || ((($_SERVER['HTTPS'] ?? '') !== '') && strtolower((string)$_SERVER['HTTPS']) !== 'off');
  $host = $_SERVER['HTTP_X_FORWARDED_HOST'] ?? $_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? 'localhost';
  return ($https ? 'https' : 'http') . '://' . $host;
}

function base64url_decode(string $data): string|false {
  $b64 = strtr($data, '-_', '+/');
  $pad = strlen($b64) % 4;
  if ($pad) $b64 .= str_repeat('=', 4 - $pad);
  return base64_decode($b64, true);
}

// Verifies the FILEHOST JWT (HS256 only, matching the ircv3_filehost
// module's jwt-cpp usage) and returns its claims, or null if invalid/
// expired/wrong issuer. Deliberately does NOT check the token's subject
// (the user's nick) — this endpoint doesn't need per-user authorization,
// only proof the ircd itself vouched for *someone* being logged in.
function verify_filehost_jwt(string $token, string $secret, string $issuer): ?array {
  $parts = explode('.', $token);
  if (count($parts) !== 3) return null;
  [$h64, $p64, $s64] = $parts;
  $header = json_decode((string)base64url_decode($h64), true);
  if (!is_array($header) || strtoupper($header['alg'] ?? '') !== 'HS256') return null;
  $sig = base64url_decode($s64);
  if ($sig === false) return null;
  $calc = hash_hmac('sha256', "$h64.$p64", $secret, true);
  if (!hash_equals($calc, $sig)) return null;
  $payload = json_decode((string)base64url_decode($p64), true);
  if (!is_array($payload)) return null;
  if (isset($payload['exp']) && time() > (int)$payload['exp']) return null;
  if ($issuer !== '' && (string)($payload['iss'] ?? '') !== $issuer) return null;
  return $payload;
}

$token = (string)($_GET['token'] ?? '');
if ($token === '') { http_response_code(401); echo json_encode(['detail' => 'missing_token']); exit; }

if ($JWT_SECRET === '' || str_starts_with($JWT_SECRET, 'CHANGE_ME')) {
  error_log('filehost-upload: $JWT_SECRET is still a CHANGE_ME placeholder — set it in filehost-upload.local.php (must match ircd <filehost jwt_secret>)');
  http_response_code(503); echo json_encode(['detail' => 'not_configured']); exit;
}

$claims = verify_filehost_jwt($token, $JWT_SECRET, $JWT_ISSUER);
if (!$claims) {
  http_response_code(401); echo json_encode(['detail' => 'invalid_token']); exit;
}

// When the SPA lives under /app (Apache Alias), uploaded files are usually
// reachable as /app/files/... rather than bare /files/...
$reqUri = (string)($_SERVER['REQUEST_URI'] ?? '');
$ref = (string)($_SERVER['HTTP_REFERER'] ?? '');
if ($PUBLIC_URL_PATH === '/files' && (
  str_contains($reqUri, '/app/') || str_starts_with($reqUri, '/app/')
  || str_contains($ref, '/app/')
)) {
  $PUBLIC_URL_PATH = '/app/files';
}

if (!isset($_FILES['file'])) {
  // post_max_size exceeded → PHP empties $_FILES and $_POST entirely.
  $cl = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
  $postMax = ini_get('post_max_size');
  error_log("filehost-upload: missing \$_FILES['file'] (CONTENT_LENGTH=$cl, post_max_size=$postMax, upload_max_filesize=" . ini_get('upload_max_filesize') . ')');
  http_response_code(400);
  echo json_encode([
    'detail' => $cl > 0 ? 'post_too_large' : 'no_file',
    'post_max_size' => $postMax,
    'upload_max_filesize' => ini_get('upload_max_filesize'),
  ]);
  exit;
}
$uploadErr = (int)$_FILES['file']['error'];
if ($uploadErr !== UPLOAD_ERR_OK) {
  error_log("filehost-upload: \$_FILES error=$uploadErr (upload_max_filesize=" . ini_get('upload_max_filesize') . ')');
  if ($uploadErr === UPLOAD_ERR_INI_SIZE || $uploadErr === UPLOAD_ERR_FORM_SIZE) {
    http_response_code(413);
    echo json_encode(['detail' => 'too_large', 'upload_max_filesize' => ini_get('upload_max_filesize')]);
    exit;
  }
  http_response_code(400);
  echo json_encode(['detail' => 'upload_failed', 'php_error' => $uploadErr]);
  exit;
}
$file = $_FILES['file'];
if ($file['size'] <= 0 || $file['size'] > $MAX_UPLOAD_BYTES) {
  http_response_code(413); echo json_encode(['detail' => 'too_large']); exit;
}

$mime = null;
if (function_exists('finfo_open')) {
  $finfo = finfo_open(FILEINFO_MIME_TYPE);
  $mime = finfo_file($finfo, $file['tmp_name']) ?: null;
  finfo_close($finfo);
}
$ext = $ALLOWED_UPLOAD_MIME[$mime] ?? null;
if ($ext === null) { http_response_code(415); echo json_encode(['detail' => 'invalid_type']); exit; }

$freshDir = !is_dir($UPLOAD_DIR);
if ($freshDir && !mkdir($UPLOAD_DIR, 0755, true) && !is_dir($UPLOAD_DIR)) {
  // The client only ever sees the generic "save_failed" — the real reason
  // (almost always a permissions mismatch: the web server's user, e.g.
  // www-data, can't write into WEBROOT to create this directory) goes to
  // the server's own PHP/Apache error log so it's actually diagnosable.
  // See server/filehost/README.md's "save_failed" troubleshooting section.
  error_log("filehost-upload: mkdir('$UPLOAD_DIR') failed — " . (error_get_last()['message'] ?? 'unknown error'));
  http_response_code(500); echo json_encode(['detail' => 'save_failed']); exit;
}
if ($freshDir) {
  // Defense in depth: uploads are already restricted by mime-sniffed
  // extension above, but make doubly sure nothing dropped in here can ever
  // be executed, and that the directory listing isn't browsable.
  file_put_contents($UPLOAD_DIR . '/.htaccess', "Options -Indexes\nphp_flag engine off\n<FilesMatch \"\\.ph(p[3457]?|t|tml)$\">\n  Require all denied\n</FilesMatch>\n");
}
$name = bin2hex(random_bytes(16)) . '.' . $ext;
if (!move_uploaded_file($file['tmp_name'], "$UPLOAD_DIR/$name")) {
  error_log("filehost-upload: move_uploaded_file() into '$UPLOAD_DIR' failed — " . (error_get_last()['message'] ?? 'unknown error'));
  http_response_code(500); echo json_encode(['detail' => 'save_failed']); exit;
}

$origin = $PUBLIC_ORIGIN !== '' ? rtrim($PUBLIC_ORIGIN, '/') : detect_origin();
echo json_encode(['url' => "$origin$PUBLIC_URL_PATH/$name"]);
