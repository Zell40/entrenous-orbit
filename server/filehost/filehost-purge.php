<?php
/**
 * filehost-purge.php — delete expired composer uploads (images / voice notes).
 *
 * CLI only. Cron example (every 15 minutes, test webroot):
 *   */15 * * * * php /home/chat/irc/webchat-new/filehost-purge.php >/dev/null 2>&1
 *
 * A file is deleted when:
 *   - `{name}.expires` exists and now >= that unix timestamp, or
 *   - there is no sidecar and mtime is older than $RETENTION_HOURS (legacy files).
 *
 * Shares filehost-upload.local.php so $UPLOAD_DIR / $RETENTION_HOURS stay in sync.
 */
if (PHP_SAPI !== 'cli') {
  http_response_code(403);
  echo "cli only\n";
  exit(1);
}

$RETENTION_HOURS = 24;
$UPLOAD_DIR = __DIR__ . '/files';
$local = __DIR__ . '/filehost-upload.local.php';
if (is_file($local)) require $local;

$dir = $UPLOAD_DIR;
if (!is_dir($dir)) {
  fwrite(STDOUT, "filehost-purge: no dir $dir\n");
  exit(0);
}

$now = time();
$defaultTtl = max(1, (int)$RETENTION_HOURS) * 3600;
$deleted = 0;

foreach (scandir($dir) ?: [] as $fn) {
  if ($fn === '.' || $fn === '..' || $fn === '.htaccess') continue;
  if (str_ends_with($fn, '.expires')) continue;
  $path = $dir . '/' . $fn;
  if (!is_file($path)) continue;
  $expFile = $path . '.expires';
  if (is_file($expFile)) {
    $exp = (int)trim((string)file_get_contents($expFile));
  } else {
    $mtime = filemtime($path);
    $exp = $mtime !== false ? $mtime + $defaultTtl : 0;
  }
  if ($exp > 0 && $now >= $exp) {
    @unlink($path);
    @unlink($expFile);
    $deleted++;
  }
}

foreach (scandir($dir) ?: [] as $fn) {
  if (!str_ends_with($fn, '.expires')) continue;
  $base = substr($fn, 0, -strlen('.expires'));
  if (!is_file($dir . '/' . $base)) @unlink($dir . '/' . $fn);
}

fwrite(STDOUT, "filehost-purge: deleted $deleted file(s)\n");
