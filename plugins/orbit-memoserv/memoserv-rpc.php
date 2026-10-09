<?php
/*
 * memoserv-rpc.php — MemoServ via Anope JSON-RPC (anope.command).
 *
 * Same origin as Orbit:
 *   /app/plugins/third/orbit-memoserv/memoserv-rpc.php
 *
 * Secrets: memoserv-rpc.local.php (same URL + token as ChanServ).
 * If that file is absent, the ChanServ local file next door is used.
 * Commands allowed: LIST, READ, SEND, RSEND, DEL,
 * CHECK, CANCEL, IGNORE. SENDALL / STAFF stay on IRC for opers.
 * action=suggest : pseudos en ligne et identifiés (avec leur compte), ou salons enregistrés.
 * action=group : compte NickServ d’un pseudo, et les pseudos de ce compte.
 */
declare(strict_types=1);

$ANOPE_RPC_URL = '';
$ANOPE_RPC_TOKEN = '';
$ANOPE_RPC_BEARER_B64 = true;

$__locals = [
  __DIR__ . '/memoserv-rpc.local.php',
  __DIR__ . '/../orbit-chanserv/chanserv-rpc.local.php',
];
foreach ($__locals as $__local) {
  if (!is_file($__local) || filesize($__local) >= 8192) {
    continue;
  }
  $__raw = (string) @file_get_contents($__local);
  if (str_contains($__raw, 'function anope_rpc') || str_contains($__raw, 'function flatten_rpc')) {
    continue;
  }
  require $__local;
  break;
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

function valid_target(string $s): bool {
  if (is_channel($s)) {
    return true;
  }
  return (bool) preg_match('/^[A-Za-z0-9_\\-\\[\\]\\\\^{}|`]{1,32}$/', $s);
}

function is_channel(string $s): bool {
  return (bool) preg_match('/^[#&][^\x00-\x20\x07,]{1,50}$/', $s);
}

function valid_service(string $s): bool {
  return in_array($s, ['Message', 'MemoServ'], true);
}

function valid_numlist(string $s, bool $words): bool {
  if ($words && preg_match('/^(NEW|LAST|ALL)$/i', $s)) {
    return true;
  }
  if (!$words && preg_match('/^(LAST|ALL)$/i', $s)) {
    return true;
  }
  return (bool) preg_match('/^\d{1,4}(?:-\d{1,4})?(?:,\d{1,4}(?:-\d{1,4})?)*$/', $s);
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
      $line = trim((string) $item);
      if ($line !== '') {
        $lines[] = $line;
      }
      continue;
    }
    if (is_array($item)) {
      $nested = flatten_rpc($item['message'] ?? $item['text'] ?? $item);
      if ($nested !== '') {
        $lines[] = $nested;
      }
    }
  }
  return implode("\n", $lines);
}

function strip_fmt(string $s): string {
  $s = preg_replace('/\x03(?:\d{1,2}(?:,\d{1,2})?)?|[\x02\x1f\x16\x1d\x0f]/', '', $s) ?? $s;
  return trim($s);
}

function is_service_nick(string $nick): bool {
  return (bool) preg_match('/^(?:nick|chan|memo|bot|oper|host|help|stat)serv$|^message$|^global$/i', $nick);
}

function memo_cache_path(string $key): string {
  return sys_get_temp_dir() . '/orbit-memo-' . hash('sha256', $key) . '.json';
}

function memo_cache_get(string $key, int $ttl): ?array {
  $path = memo_cache_path($key);
  if (!is_file($path)) {
    return null;
  }
  $age = time() - (int) @filemtime($path);
  if ($age < 0 || $age > $ttl) {
    return null;
  }
  $data = json_decode((string) @file_get_contents($path), true);
  return is_array($data) ? $data : null;
}

function memo_cache_put(string $key, array $data): void {
  @file_put_contents(memo_cache_path($key), json_encode($data, JSON_UNESCAPED_UNICODE));
}

function account_label($acc): string {
  if (is_string($acc) || is_numeric($acc)) {
    return trim((string) $acc);
  }
  if (!is_array($acc)) {
    return '';
  }
  foreach (['display', 'name', 'account'] as $k) {
    if (isset($acc[$k]) && is_string($acc[$k]) && trim($acc[$k]) !== '') {
      return trim($acc[$k]);
    }
  }
  return '';
}

function starts_ci(string $value, string $prefix): bool {
  if ($prefix === '') {
    return false;
  }
  return strncasecmp($value, $prefix, strlen($prefix)) === 0;
}

/** Pseudos présents et identifiés (compte Anope), sans les services. */
function online_identified_nicks(string $url, string $token, bool $bearerB64): array {
  $hit = memo_cache_get('identified-online-v2', 20);
  if (is_array($hit)) {
    return $hit;
  }
  $data = anope_rpc($url, $token, $bearerB64, 'anope.listUsers', ['full']);
  $nicks = [];
  if (is_array($data)) {
    foreach ($data as $key => $info) {
      if (!is_array($info)) {
        continue;
      }
      $acc = account_label($info['account'] ?? null);
      if ($acc === '') {
        continue;
      }
      $nick = '';
      if (isset($info['nick']) && is_string($info['nick'])) {
        $nick = $info['nick'];
      } elseif (is_string($key)) {
        $nick = $key;
      }
      $nick = trim($nick);
      if ($nick === '' || is_service_nick($nick)) {
        continue;
      }
      $nicks[$nick] = ['nick' => $nick, 'account' => $acc];
    }
  }
  $list = array_values($nicks);
  usort($list, static function ($a, $b) {
    return strcasecmp((string) ($a['nick'] ?? ''), (string) ($b['nick'] ?? ''));
  });
  memo_cache_put('identified-online-v2', $list);
  return $list;
}

/** Noms de pseudos d’un compte Anope, sans e-mail ni autre champ. */
function account_nicks($info): array {
  $display = '';
  $names = [];
  if (is_array($info)) {
    $display = trim((string) ($info['display'] ?? ''));
    $raw = $info['nicks'] ?? [];
    if (is_array($raw)) {
      foreach ($raw as $key => $val) {
        $name = '';
        if (is_string($key) && !preg_match('/^\d+$/', $key)) {
          $name = $key;
        } elseif (is_array($val) && isset($val['nick']) && is_string($val['nick'])) {
          $name = $val['nick'];
        } elseif (is_string($val)) {
          $name = $val;
        }
        $name = trim($name);
        if ($name !== '' && !is_service_nick($name)) {
          $names[$name] = $name;
        }
      }
    }
  }
  if ($display === '' && $names) {
    $display = array_values($names)[0];
  }
  $list = array_values($names);
  sort($list, SORT_FLAG_CASE | SORT_STRING);
  return ['display' => $display, 'nicks' => $list];
}

function group_lookup(string $url, string $token, bool $bearerB64, string $q): array {
  $onlineAccount = '';
  foreach (online_identified_nicks($url, $token, $bearerB64) as $row) {
    if (is_array($row) && strcasecmp((string) ($row['nick'] ?? ''), $q) === 0) {
      $onlineAccount = trim((string) ($row['account'] ?? ''));
      break;
    }
  }
  $try = [];
  if ($onlineAccount !== '') {
    $try[] = $onlineAccount;
  }
  if ($onlineAccount === '' || strcasecmp($onlineAccount, $q) !== 0) {
    $try[] = $q;
  }
  $found = ['display' => '', 'nicks' => []];
  foreach ($try as $name) {
    if ($name === '' || !valid_account($name)) {
      continue;
    }
    $cacheKey = 'acct:' . strtolower($name);
    $hit = memo_cache_get($cacheKey, 20);
    if (is_array($hit) && array_key_exists('display', $hit)) {
      $parsed = [
        'display' => trim((string) ($hit['display'] ?? '')),
        'nicks' => is_array($hit['nicks'] ?? null) ? $hit['nicks'] : [],
      ];
    } else {
      try {
        $parsed = account_nicks(anope_rpc($url, $token, $bearerB64, 'anope.account', [$name]));
      } catch (Throwable $e) {
        $parsed = ['display' => '', 'nicks' => []];
      }
      memo_cache_put($cacheKey, $parsed);
    }
    if ($parsed['display'] !== '' || $parsed['nicks']) {
      $found = $parsed;
      break;
    }
  }
  $display = (string) $found['display'];
  if ($display === '' && $onlineAccount !== '') {
    $display = $onlineAccount;
  }
  $nicks = [];
  foreach ($found['nicks'] as $name) {
    $name = trim((string) $name);
    if ($name !== '') {
      $nicks[] = $name;
    }
  }
  $registered = false;
  foreach ($nicks as $name) {
    if (strcasecmp($name, $q) === 0) {
      $registered = true;
      break;
    }
  }
  if (!$registered && $display !== '' && strcasecmp($display, $q) === 0) {
    $registered = true;
  }
  return [
    'nick' => $q,
    'account' => $display,
    'registered' => $registered,
    'nicks' => array_slice($nicks, 0, 16),
  ];
}

/** Salons enregistrés dont le nom commence par # + préfixe (ChanServ LIST, sans le #). */
function registered_channels(string $url, string $token, bool $bearerB64, string $account, string $source, string $prefix): array {
  $cacheKey = 'chan:' . strtolower($prefix);
  $hit = memo_cache_get($cacheKey, 20);
  if (is_array($hit)) {
    return $hit;
  }
  // No anope.identify — source is already SASL-identified on IRC; identify would
  // re-fire Gardian login stats NOTICE on every autocomplete probe.
  $result = anope_rpc($url, $token, $bearerB64, 'anope.command', [$source, 'ChanServ', 'LIST', $prefix . '*']);
  $text = is_string($result) ? $result : flatten_rpc($result);
  $text = strip_fmt($text);
  preg_match_all('/#[^\\s,]+/', $text, $found);
  $want = '#' . $prefix;
  $names = [];
  foreach ($found[0] as $name) {
    $name = rtrim($name, '.)]');
    if (!starts_ci($name, $want)) {
      continue;
    }
    $names[$name] = $name;
  }
  $list = array_values($names);
  sort($list, SORT_FLAG_CASE | SORT_STRING);
  memo_cache_put($cacheKey, $list);
  return $list;
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
  ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
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
    CURLOPT_CONNECTTIMEOUT => 3,
  ]);
  $response = curl_exec($ch);
  $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);
  if ($response === false || $status < 200 || $status >= 300) {
    throw new RuntimeException('http');
  }
  $data = json_decode($response, true, 512, JSON_BIGINT_AS_STRING);
  if (!is_array($data)) {
    throw new RuntimeException('decode');
  }
  if (isset($data['error'])) {
    $msg = is_array($data['error']) ? (string) ($data['error']['message'] ?? 'rpc') : 'rpc';
    throw new RuntimeException($msg);
  }
  return $data['result'] ?? null;
}

$url = trim((string) $ANOPE_RPC_URL);
$token = trim((string) $ANOPE_RPC_TOKEN);
if (stripos($token, 'CHANGE_ME') !== false) {
  $token = '';
}
if ($url === '' || $token === '') {
  echo json_encode(['ok' => false, 'error' => 'not_configured']);
  exit;
}

$raw = file_get_contents('php://input') ?: '';
$body = json_decode($raw, true);
if (!is_array($body)) {
  fail(400, 'bad_json');
}

$account = trim((string) ($body['account'] ?? ''));
$nick = trim((string) ($body['nick'] ?? ''));
$service = trim((string) ($body['service'] ?? 'Message'));
$command = strtoupper(trim((string) ($body['command'] ?? '')));
$args = $body['args'] ?? [];
if (!valid_account($account)) {
  fail(400, 'bad_params');
}
$source = valid_account($nick) ? $nick : $account;
if (!valid_service($service)) {
  $service = 'Message';
}

$action = strtolower(trim((string) ($body['action'] ?? 'command')));
if ($action === 'suggest') {
  $q = trim((string) ($body['q'] ?? ''));
  $items = [];
  try {
    if ($q !== '' && $q[0] === '#') {
      $prefix = substr($q, 1);
      if (preg_match('/^[A-Za-z0-9._\\-]{1,32}$/', $prefix)) {
        $items = array_slice(registered_channels($url, $token, (bool) $ANOPE_RPC_BEARER_B64, $account, $source, $prefix), 0, 12);
      }
    } elseif (preg_match('/^[A-Za-z0-9_\\-\\[\\]\\\\`^{}|]{1,32}$/', $q)) {
      foreach (online_identified_nicks($url, $token, (bool) $ANOPE_RPC_BEARER_B64) as $cand) {
        $name = is_array($cand) ? trim((string) ($cand['nick'] ?? '')) : trim((string) $cand);
        if ($name === '' || !starts_ci($name, $q)) {
          continue;
        }
        $items[] = [
          'nick' => $name,
          'account' => is_array($cand) ? trim((string) ($cand['account'] ?? '')) : '',
        ];
        if (count($items) >= 12) {
          break;
        }
      }
    }
  } catch (Throwable $e) {
    $items = [];
  }
  echo json_encode(['ok' => true, 'items' => $items], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}

if ($action === 'group') {
  $q = trim((string) ($body['q'] ?? ''));
  $out = ['ok' => true, 'nick' => $q, 'account' => '', 'registered' => false, 'nicks' => []];
  try {
    if (preg_match('/^[A-Za-z0-9_\\-\\[\\]\\\\`^{}|]{2,32}$/', $q)) {
      $out = array_merge(['ok' => true], group_lookup($url, $token, (bool) $ANOPE_RPC_BEARER_B64, $q));
    }
  } catch (Throwable $e) {
    $out = ['ok' => true, 'nick' => $q, 'account' => '', 'registered' => false, 'nicks' => []];
  }
  echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}

if (!is_array($args) || count($args) > 3) {
  fail(400, 'bad_params');
}
$args = array_map(static fn($a) => trim((string) $a), $args);

$allowed = ['LIST', 'READ', 'SEND', 'RSEND', 'DEL', 'CHECK', 'CANCEL', 'IGNORE'];
if (!in_array($command, $allowed, true)) {
  fail(400, 'bad_command');
}

if ($command === 'LIST') {
  if (count($args) === 1 && is_channel($args[0])) {
    // Mémos du salon, si l'utilisateur a le privilège MEMO.
  } elseif (count($args) === 2 && is_channel($args[0]) && valid_numlist($args[1], true)) {
    // LIST #salon NEW
  } elseif (count($args) > 1 || (isset($args[0]) && $args[0] !== '' && !preg_match('/^(NEW|\d{1,4}(?:-\d{1,4})?(?:,\d{1,4}(?:-\d{1,4})?)*)$/i', $args[0]))) {
    fail(400, 'bad_params');
  } elseif (isset($args[0]) && $args[0] === '') {
    $args = [];
  }
} elseif ($command === 'READ') {
  if (count($args) === 2 && is_channel($args[0]) && valid_numlist($args[1], true)) {
    // READ #salon numéro
  } elseif (count($args) !== 1 || !valid_numlist($args[0], true)) {
    fail(400, 'bad_params');
  }
} elseif ($command === 'DEL') {
  if (count($args) === 2 && is_channel($args[0]) && valid_numlist($args[1], false)) {
    // DEL #salon numéro
  } elseif (count($args) !== 1 || !valid_numlist($args[0], false)) {
    fail(400, 'bad_params');
  }
} elseif ($command === 'SEND' || $command === 'RSEND') {
  if (count($args) !== 2 || !valid_target($args[0])) {
    fail(400, 'bad_params');
  }
  $text = preg_replace('/[\r\n\x01]+/', ' ', $args[1]) ?? '';
  $text = trim(preg_replace('/\s+/', ' ', $text) ?? '');
  $len = function_exists('mb_strlen') ? mb_strlen($text, 'UTF-8') : strlen($text);
  if ($text === '' || $len > 200) {
    fail(400, 'bad_params');
  }
  $args[1] = $text;
} elseif ($command === 'CHECK' || $command === 'CANCEL') {
  if (count($args) !== 1 || !valid_target($args[0])) {
    fail(400, 'bad_params');
  }
} elseif ($command === 'IGNORE') {
  $op = strtoupper($args[0] ?? '');
  if ($op === 'LIST' && count($args) === 1) {
    $args = ['LIST'];
  } elseif (($op === 'ADD' || $op === 'DEL') && count($args) === 2 && preg_match('/^[^\s\x00-\x1f]{1,64}$/', $args[1])) {
    $args = [$op, $args[1]];
  } else {
    fail(400, 'bad_params');
  }
}

try {
  // MemoServ SEND/LIST need anope.identify for the source nick — SASL alone is
  // not enough on this Anope setup. Duplicate Gardian login stats from identify
  // are swallowed client-side (once per Orbit session).
  try {
    anope_rpc($url, $token, $ANOPE_RPC_BEARER_B64, 'anope.identify', [$account, $source]);
  } catch (Throwable $e) {
    /* The command itself reports access denied if identify did not take. */
  }
  $params = array_merge([$source, $service, $command], $args);
  $hasChan = false;
  foreach ($args as $arg) {
    if (is_channel($arg)) {
      $hasChan = true;
      break;
    }
  }
  if ($command === 'SEND' || $command === 'RSEND' || $hasChan) {
    // Une seule ligne : un paramètre de plus (texte, ou numéro après #salon) n'arrivait pas à MemoServ.
    $params = [$source, $service, $command . ' ' . implode(' ', $args)];
  }
  $result = anope_rpc($url, $token, $ANOPE_RPC_BEARER_B64, 'anope.command', $params);
  $text = flatten_rpc($result);
  $raw = '';
  if ($text === '') {
    $raw = is_array($result) ? 'array' : gettype($result);
    if (is_array($result)) {
      $encoded = json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
      if (is_string($encoded) && $encoded !== '' && $encoded !== '[]' && $encoded !== '{}') {
        $raw .= ' ' . substr($encoded, 0, 160);
      }
    }
  }
  echo json_encode(['ok' => true, 'text' => $text, 'raw' => $raw], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
} catch (Throwable $e) {
  echo json_encode(['ok' => false, 'error' => 'rpc']);
}
