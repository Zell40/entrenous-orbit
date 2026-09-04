<?php
/*
 * chanserv-rpc.php — INFO / STATUS / BOTLIST via Anope JSON-RPC (no IRC PMs).
 *
 * Same origin as Orbit:
 *   /app/plugins/third/orbit-chanserv/chanserv-rpc.php
 *
 * Secrets in chanserv-rpc.local.php (never overwrite on deploy).
 * Read-only: the browser cannot run OP/KICK/REGISTER through this endpoint.
 */
declare(strict_types=1);

$ANOPE_RPC_URL = '';
$ANOPE_RPC_TOKEN = '';
$ANOPE_RPC_BEARER_B64 = true;

$__local = __DIR__ . '/chanserv-rpc.local.php';
$__local_state = 'missing';
if (!is_file($__local)) {
  $__local_state = 'missing';
} elseif (filesize($__local) >= 8192) {
  $__local_state = 'too_large';
} else {
  $__local_raw = (string) @file_get_contents($__local);
  // A full copy of this script would recurse; secrets-only files are fine.
  if (str_contains($__local_raw, 'function anope_rpc') || str_contains($__local_raw, 'function flatten_rpc')) {
    $__local_state = 'skipped_copy';
  } else {
    require $__local;
    $__local_state = 'loaded';
  }
}
if ($ANOPE_RPC_URL === '' && defined('WP_ANOPE_RPC_URL')) {
  $ANOPE_RPC_URL = (string) WP_ANOPE_RPC_URL;
}
if ($ANOPE_RPC_TOKEN === '' && defined('WP_ANOPE_RPC_TOKEN')) {
  $ANOPE_RPC_TOKEN = (string) WP_ANOPE_RPC_TOKEN;
}

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
  header('Access-Control-Allow-Headers: Content-Type');
  header('Access-Control-Allow-Methods: POST, OPTIONS');
  http_response_code(204);
  exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
  http_response_code(405);
  header('Allow: POST, OPTIONS');
  echo json_encode(['ok' => false, 'error' => 'post_only']);
  exit;
}

function fail(int $code, string $error): void {
  http_response_code($code);
  echo json_encode(['ok' => false, 'error' => $error]);
  exit;
}

function valid_account(string $s): bool {
  return (bool) preg_match('/^[A-Za-z0-9_\\-\\[\\]\\\\^{}|`]{1,32}$/', $s);
}

function valid_channel(string $s): bool {
  return (bool) preg_match('/^[#&][^\x00-\x20\x07,]{1,64}$/', $s);
}

function flatten_rpc($value): string {
  if (is_string($value) || is_int($value) || is_float($value)) {
    return trim((string) $value);
  }
  if (!is_array($value)) {
    return '';
  }
  $lines = [];
  foreach ($value as $item) {
    if (is_string($item) || is_int($item) || is_float($item)) {
      $lines[] = trim((string) $item);
      continue;
    }
    if (is_array($item)) {
      if (isset($item['message'])) {
        $lines[] = trim((string) $item['message']);
      } elseif (isset($item['text'])) {
        $lines[] = trim((string) $item['text']);
      } else {
        $nested = flatten_rpc($item);
        if ($nested !== '') {
          $lines[] = $nested;
        }
      }
    }
  }
  return implode("\n", array_values(array_filter($lines, static fn($s) => $s !== '')));
}

function anope_rpc(string $url, string $token, bool $bearerB64, string $method, array $params): mixed {
  if (!function_exists('curl_init')) {
    throw new RuntimeException('curl');
  }
  $payload = json_encode([
    'jsonrpc' => '2.0',
    'method' => $method,
    'params' => array_map(static fn($p) => (string) $p, $params),
    'id' => bin2hex(random_bytes(8)),
  ], JSON_UNESCAPED_SLASHES);
  if ($payload === false) {
    throw new RuntimeException('json');
  }
  $headers = ['Content-Type: application/json'];
  if ($token !== '') {
    $headers[] = 'Authorization: Bearer ' . ($bearerB64 ? base64_encode($token) : $token);
  }
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_HTTPHEADER => $headers,
    CURLOPT_TIMEOUT => 8,
    CURLOPT_CONNECTTIMEOUT => 4,
  ]);
  $response = curl_exec($ch);
  $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
  $cerr = curl_error($ch);
  curl_close($ch);
  if ($response === false) {
    throw new RuntimeException($cerr !== '' ? 'curl' : 'empty');
  }
  if ($status < 200 || $status >= 300) {
    throw new RuntimeException('http');
  }
  $data = json_decode($response, true, 512, JSON_BIGINT_AS_STRING);
  if (!is_array($data)) {
    throw new RuntimeException('decode');
  }
  if (isset($data['error'])) {
    $msg = is_array($data['error']) ? (string) ($data['error']['message'] ?? 'rpc') : 'rpc';
    throw new RuntimeException('rpc:' . $msg);
  }
  return $data['result'] ?? null;
}

$url = trim((string) $ANOPE_RPC_URL);
$token = trim((string) $ANOPE_RPC_TOKEN);
if (stripos($token, 'CHANGE_ME') !== false) {
  $token = '';
}
if ($url === '' || $token === '') {
  http_response_code(200);
  echo json_encode([
    'ok' => false,
    'error' => 'not_configured',
    'detail' => $__local_state,
    'dir' => __DIR__,
    'file' => is_file($__local) ? 'chanserv-rpc.local.php' : '',
  ], JSON_UNESCAPED_SLASHES);
  exit;
}

$raw = file_get_contents('php://input') ?: '';
$body = json_decode($raw, true);
if (!is_array($body)) {
  fail(400, 'bad_json');
}

$account = trim((string) ($body['account'] ?? ''));
$channel = trim((string) ($body['channel'] ?? ''));
$action = strtolower(trim((string) ($body['action'] ?? 'probe')));
if (!valid_account($account) || !valid_channel($channel)) {
  fail(400, 'bad_params');
}
if ($action !== 'probe' && $action !== 'botlist') {
  fail(400, 'bad_action');
}

try {
  if ($action === 'botlist') {
    $bots = flatten_rpc(anope_rpc($url, $token, $ANOPE_RPC_BEARER_B64, 'anope.command', [
      $account, 'BotServ', 'BOTLIST',
    ]));
    echo json_encode(['ok' => true, 'bots' => $bots], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
  }
  $info = flatten_rpc(anope_rpc($url, $token, $ANOPE_RPC_BEARER_B64, 'anope.command', [
    $account, 'ChanServ', 'INFO', $channel,
  ]));
  $status = flatten_rpc(anope_rpc($url, $token, $ANOPE_RPC_BEARER_B64, 'anope.command', [
    $account, 'ChanServ', 'STATUS', $channel,
  ]));
  echo json_encode([
    'ok' => true,
    'info' => $info,
    'status' => $status,
  ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
  fail(502, 'rpc_failed');
}
