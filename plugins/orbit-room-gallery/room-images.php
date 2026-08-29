<?php
/*
 * room-images.php — tiny same-origin store for Orbit's room-gallery plugin
 * (sibling orbit-room-gallery.js in plugins/third/orbit-room-gallery/).
 * No database server needed:
 * a single JSON file on disk, guarded by a lock for concurrent writes.
 *
 * Why this exists: a channel founder's picture needs to be visible to every
 * Orbit user, but nothing about it should ever appear over IRC itself (so
 * KiwiIRC / any other IRC client never sees a trace of it). This endpoint is
 * the "somewhere else" the URL lives.
 *
 * Trust model: a write is only accepted if the caller presents a valid
 * EXTJWT (https://www.unrealircd.org/docs/Extjwt_block) requested for that
 * SPECIFIC channel (`EXTJWT #channel`, not `EXTJWT *`). The ircd itself signs
 * the token and embeds the requester's current channel modes (`cmodes`), so
 * this script never has to trust the client's word for who's the founder —
 * it just verifies the ircd's signature and checks the claim.
 *
 * Deployment:
 *   1. Drop this file (and let it create room-images.json next to itself —
 *      make sure this directory is writable by PHP) at a path reachable
 *      under the SAME origin Orbit is served from, so the plugin's fetch()
 *      calls need no CORS setup.
 *   2. Set $EXTJWT_SECRET to the exact `secret` configured in your ircd's
 *      `extjwt { ... }` block (the same value already used by
 *      kiwiirc-plugin-fileuploader's [JwtSecretsByIssuer] config) — put it in
 *      a sibling room-images.local.php instead of editing this file directly,
 *      since deploy.sh overwrites this file on every deploy (see the
 *      $__room_images_local block below).
 *   3. Set $FOUNDER_CMODE / $ADMIN_CMODE to your network's founder and
 *      channel-admin mode LETTERS (not the display prefixes!) — check
 *      ISUPPORT's PREFIX token, e.g. "PREFIX=(qaohv)~&@%+" means "~" is
 *      'q' (founder) and "&" is 'a' (admin). Both may add / change / remove
 *      a room picture.
 *   4. Point the plugin's ROOM_IMAGES_ENDPOINT constant at this file's URL.
 *   5. Make sure PHP can create the `room-images-uploads/` directory next to
 *      this file (same permissions as for room-images.json), and that your
 *      php.ini's `upload_max_filesize`/`post_max_size` are at least 8M
 *      (below $MAX_UPLOAD_BYTES) — otherwise PHP itself drops the upload
 *      before this script ever sees it.
 *
 * Uploads: the plugin used to hand this script an already-hosted URL,
 * obtained through Orbit's core `/FILEHOST` -> `/upload` pipeline (the one
 * behind the chat composer's image button). That pipeline is NOT a standard
 * ircd feature — Orbit expects an operator-run bot that answers a raw
 * `FILEHOST` command with a NOTICE token, which most ircds (including plain
 * InspIRCd/UnrealIRCd with no such bot) simply don't have, so it silently
 * times out. Rather than requiring that separate piece of infrastructure
 * just for a channel picture, this script now accepts the raw image file
 * itself (multipart/form-data, same EXTJWT founder check as before) and
 * hosts it itself, right here, next to room-images.json.
 */

$EXTJWT_SECRET   = 'CHANGE_ME';   // must match your ircd's extjwt {} secret
$FOUNDER_CMODE   = 'q';           // founder mode LETTER (PREFIX "~" on Unreal/Insp)
$ADMIN_CMODE     = 'a';           // channel-admin LETTER (PREFIX "&") — same write rights as founder
$MAX_URL_LEN     = 500;
$UPLOAD_DIR      = __DIR__ . '/room-images-uploads';
// The channel→url map used to live at WEBROOT/room-images.json. That path is
// often NOT writable by the web server user (www-data) even when the uploads
// directory is — so uploads "succeeded" (file on disk + URL returned to the
// client → /me showed the image) while the map stayed empty forever and GET
// returned [] (no picture in gallery/topbar/sidebar). Keep the map INSIDE
// the uploads dir, which we already require to be writable. The legacy path
// is still read once and migrated (see load_map_all below).
$DATA_FILE       = $UPLOAD_DIR . '/room-images.json';
$DATA_FILE_LEGACY = __DIR__ . '/room-images.json';
$MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8MB, matches the plugin's client-side cap
// Public URL *path* prefix for files saved to $UPLOAD_DIR, derived from this
// script's own URL so no extra config is needed — override if you move
// $UPLOAD_DIR somewhere not reachable at <this script's directory>/room-images-uploads.
// (Scheme+host is prepended separately below via detect_origin() so the
// final URL is always absolute — see its comment for why that matters.)
$UPLOAD_URL_PATH = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/app/plugins/third/orbit-room-gallery/room-images.php')), '/') . '/room-images-uploads';
$ALLOWED_UPLOAD_MIME = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp'];

// deploy.sh always overwrites THIS file with the latest version from git on
// every deploy (so bugfixes here reach you automatically) — which would
// normally wipe out $EXTJWT_SECRET above back to the CHANGE_ME placeholder
// every time. To avoid that, put your real secret in a sibling
// room-images.local.php instead (same directory, never touched by
// deploy.sh, not tracked by git — see .gitignore's `*.local.php`):
//   <?php
//   $EXTJWT_SECRET = 'the-real-secret';
// It's simply require()'d here if present, and can override any of the
// variables above.
$__room_images_local = __DIR__ . '/room-images.local.php';
// Refuse a "local" that is actually a full copy of this script (would
// recurse forever via the require below → HTTP 500). Secrets files are tiny.
if (is_file($__room_images_local)
    && filesize($__room_images_local) < 4096
    && !str_contains((string)@file_get_contents($__room_images_local), 'function verify_extjwt')) {
  require $__room_images_local;
} elseif (is_file($__room_images_local)) {
  error_log('room-images: refusing to require room-images.local.php — it looks like a full script copy, not a secrets stub');
}

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store'); // this map changes at any time; never let a browser/proxy serve a stale GET
// Uncomment and adjust if Orbit's static build is served from a different
// origin than this script (otherwise same-origin needs nothing extra):
// header('Access-Control-Allow-Origin: https://your-orbit-origin.example');
// header('Access-Control-Allow-Headers: Content-Type, Authorization');
// header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }

// IRC channel names are case-insensitive (RFC 1459 casemapping) but this
// script previously stored/looked them up as plain string keys — a founder
// setting a picture while their buffer name is "#MonChan" would silently
// never match a LIST result reported as "#monchan" (or vice versa), so the
// picture looked "saved" (the POST succeeds) but never showed up anywhere.
// Canonicalize to lowercase on every read/write so this can't happen.
function canon_channel(string $c): string { return strtolower($c); }

/** Normalize EXTJWT `cmodes` (array of letters, or a packed string like "qa"). */
function extjwt_cmodes($raw): array {
  if (is_string($raw)) {
    return preg_split('//u', ltrim($raw, '+'), -1, PREG_SPLIT_NO_EMPTY) ?: [];
  }
  if (!is_array($raw)) return [];
  $out = [];
  foreach ($raw as $m) {
    $m = ltrim(trim((string)$m), '+');
    if ($m !== '') $out[] = $m;
  }
  return $out;
}

function can_write_room_image(array $cmodes): bool {
  global $FOUNDER_CMODE, $ADMIN_CMODE;
  foreach ([$FOUNDER_CMODE, $ADMIN_CMODE] as $letter) {
    $letter = trim((string)$letter);
    if ($letter !== '' && in_array($letter, $cmodes, true)) return true;
  }
  return false;
}

// Auto-detects "scheme://host" from the request, same rationale as
// filehost-upload.php: the URL handed back to the plugin is later reused
// as-is when sharing a "channel picture updated" announcement in-channel,
// and Orbit's own message renderer (src/lib/format.tsx) only turns
// `https?://...` runs into inline image cards — a bare path wouldn't embed
// there (CSS background-image doesn't care, but that renderer does).
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

// Verifies an EXTJWT (HS256 only) and returns its claims array, or null if
// the signature doesn't check out or the token has expired.
function verify_extjwt(string $token, string $secret): ?array {
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
  return $payload;
}

function load_map(string $file): array {
  if (!file_exists($file)) return [];
  $fh = fopen($file, 'r');
  if (!$fh) return [];
  flock($fh, LOCK_SH);
  $raw = stream_get_contents($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  $data = json_decode((string)$raw, true);
  return is_array($data) ? $data : [];
}

function save_map(string $file, array $map): bool {
  $dir = dirname($file);
  if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
    error_log("room-images: mkdir('$dir') for map failed — " . (error_get_last()['message'] ?? 'unknown error'));
    return false;
  }
  // Ensure the map stays group-writable: deploy/migration often creates it as
  // 0644 owned by `chat`, then www-data (group users) can create new images
  // in the setgid dir but cannot update this existing JSON → save_failed.
  if (file_exists($file)) {
    @chmod($file, 0664);
  }
  $fh = fopen($file, 'c+');
  if (!$fh) {
    error_log("room-images: fopen('$file') for write failed — " . (error_get_last()['message'] ?? 'unknown error'));
    return false;
  }
  if (!file_exists($file) || (fileperms($file) & 0666) !== 0664) {
    @chmod($file, 0664);
  }
  flock($fh, LOCK_EX);
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($map, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  @chmod($file, 0664);
  return true;
}

// Prefer the writable uploads-dir map; if only the legacy WEBROOT copy
// exists (from before this fix), migrate it over so we don't lose entries
// and so subsequent writes land somewhere www-data can actually update.
function load_map_all(string $file, string $legacy): array {
  $map = load_map($file);
  if ($map) return $map;
  $old = load_map($legacy);
  if (!$old) return [];
  if (save_map($file, $old)) {
    // Best-effort cleanup of the unwritable legacy path — ignore failure.
    @unlink($legacy);
  }
  return $old;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// Public: everyone (including guests) can read the map to render the gallery.
if ($method === 'GET') {
  $map = load_map_all($DATA_FILE, $DATA_FILE_LEGACY);
  $urls = [];
  foreach ($map as $chan => $entry) {
    // Defensive: every entry written by THIS version of the script is always
    // an array (['url','by','at']), but a stray value from a much earlier
    // iteration of this feature (e.g. a plain url string, written before the
    // array shape existed) sitting untouched in room-images.json — it's
    // deliberately never wiped by a deploy — used to make a strictly-typed
    // `array_map(fn(array $e) => …)` throw a TypeError on THAT ONE entry,
    // silently breaking every GET response (and therefore every picture,
    // everywhere) for everyone, forever, until that one bad entry was found
    // by hand. Tolerate both shapes instead of ever fataling on this.
    $url = is_array($entry) ? ($entry['url'] ?? null) : (is_string($entry) ? $entry : null);
    if ($url !== null && $url !== '') $urls[canon_channel((string)$chan)] = $url;
  }
  // Always an object (`{}` when empty), never a JSON array — the plugin
  // walks Object.keys() and a bare `[]` from an empty PHP array confused
  // debugging ("is the endpoint broken or just empty?").
  echo json_encode($urls ?: new stdClass());
  exit;
}

if ($method === 'POST') {
  $channel = canon_channel(trim((string)($_GET['channel'] ?? '')));
  if ($channel === '') { http_response_code(400); echo json_encode(['error' => 'missing_channel']); exit; }

  $authHeader = $_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
  if (!preg_match('/^Bearer\s+(.+)$/i', $authHeader, $m)) {
    http_response_code(401); echo json_encode(['error' => 'missing_token']); exit;
  }

  $claims = verify_extjwt($m[1], $EXTJWT_SECRET);
  if (!$claims) { http_response_code(401); echo json_encode(['error' => 'invalid_token']); exit; }
  if (strcasecmp((string)($claims['channel'] ?? ''), $channel) !== 0) {
    http_response_code(403); echo json_encode(['error' => 'channel_mismatch']); exit;
  }
  $cmodes = extjwt_cmodes($claims['cmodes'] ?? null);
  if (!can_write_room_image($cmodes)) {
    http_response_code(403); echo json_encode(['error' => 'not_founder']); exit;
  }

  $by = $claims['account'] ?? $claims['sub'] ?? '';

  // Path A: the founder picked a file — it arrives here directly as
  // multipart/form-data (field "file"), no core /FILEHOST -> /upload
  // round-trip involved. Store it ourselves and record its URL.
  $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
  if (stripos($contentType, 'multipart/form-data') !== false) {
    if (!isset($_FILES['file'])) {
      http_response_code(400); echo json_encode(['error' => 'upload_failed', 'detail' => 'no_file']); exit;
    }
    $uploadErr = (int)$_FILES['file']['error'];
    if ($uploadErr !== UPLOAD_ERR_OK) {
      // Surface the common php.ini case (default upload_max_filesize=2M) as
      // too_large so the UI can say something useful instead of a generic fail.
      if ($uploadErr === UPLOAD_ERR_INI_SIZE || $uploadErr === UPLOAD_ERR_FORM_SIZE) {
        http_response_code(413); echo json_encode(['error' => 'too_large']); exit;
      }
      http_response_code(400); echo json_encode(['error' => 'upload_failed', 'detail' => $uploadErr]); exit;
    }
    $file = $_FILES['file'];
    if ($file['size'] <= 0 || $file['size'] > $MAX_UPLOAD_BYTES) {
      http_response_code(413); echo json_encode(['error' => 'too_large']); exit;
    }
    $mime = null;
    if (function_exists('finfo_open')) {
      $finfo = finfo_open(FILEINFO_MIME_TYPE);
      $mime = finfo_file($finfo, $file['tmp_name']) ?: null;
      finfo_close($finfo);
    }
    $ext = $ALLOWED_UPLOAD_MIME[$mime] ?? null;
    if ($ext === null) { http_response_code(415); echo json_encode(['error' => 'invalid_type']); exit; }
    $freshDir = !is_dir($UPLOAD_DIR);
    if ($freshDir && !mkdir($UPLOAD_DIR, 0755, true) && !is_dir($UPLOAD_DIR)) {
      // The client only ever sees the generic "save_failed" — the real
      // reason (almost always a permissions mismatch: the web server's
      // user, e.g. www-data, can't write into WEBROOT to create this
      // directory) goes to the server's own PHP/Apache error log instead.
      error_log("room-images: mkdir('$UPLOAD_DIR') failed — " . (error_get_last()['message'] ?? 'unknown error'));
      http_response_code(500); echo json_encode(['error' => 'save_failed']); exit;
    }
    if ($freshDir) {
      // Defense in depth: uploads are already restricted by mime-sniffed
      // extension above, but make doubly sure nothing dropped in here can
      // ever be executed, and that the directory listing isn't browsable.
      file_put_contents($UPLOAD_DIR . '/.htaccess', "Options -Indexes\nphp_flag engine off\n<FilesMatch \"\\.ph(p[3457]?|t|tml)$\">\n  Require all denied\n</FilesMatch>\n");
    }
    $name = bin2hex(random_bytes(16)) . '.' . $ext;
    if (!move_uploaded_file($file['tmp_name'], "$UPLOAD_DIR/$name")) {
      error_log("room-images: move_uploaded_file() into '$UPLOAD_DIR' failed — " . (error_get_last()['message'] ?? 'unknown error'));
      http_response_code(500); echo json_encode(['error' => 'save_failed']); exit;
    }
    $url = detect_origin() . "$UPLOAD_URL_PATH/$name";
    $map = load_map_all($DATA_FILE, $DATA_FILE_LEGACY);
    $map[$channel] = ['url' => $url, 'by' => $by, 'at' => time()];
    if (!save_map($DATA_FILE, $map)) {
      // File is on disk but the channel→url map couldn't be persisted — the
      // founder would see their /me image (we already returned the URL) and
      // nobody else's gallery/topbar/sidebar would ever pick it up. Fail
      // loudly instead of that silent half-success.
      @unlink("$UPLOAD_DIR/$name");
      http_response_code(500); echo json_encode(['error' => 'save_failed']); exit;
    }
    echo json_encode(['ok' => true, 'url' => $url]);
    exit;
  }

  // Path B: a plain JSON body — set an already-hosted URL directly, or
  // clear the picture with `{ "url": null }` (used by the "Retirer" button).
  $body = json_decode((string)file_get_contents('php://input'), true);
  $url = is_array($body) ? ($body['url'] ?? null) : null;

  $map = load_map_all($DATA_FILE, $DATA_FILE_LEGACY);
  if ($url === null || $url === '') {
    unset($map[$channel]);
  } else {
    if (!is_string($url) || strlen($url) > $MAX_URL_LEN || !preg_match('#^https?://#i', $url)) {
      http_response_code(400); echo json_encode(['error' => 'invalid_url']); exit;
    }
    $map[$channel] = ['url' => $url, 'by' => $by, 'at' => time()];
  }
  if (!save_map($DATA_FILE, $map)) {
    http_response_code(500); echo json_encode(['error' => 'save_failed']); exit;
  }
  echo json_encode(['ok' => true]);
  exit;
}

http_response_code(405);
echo json_encode(['error' => 'method_not_allowed']);
