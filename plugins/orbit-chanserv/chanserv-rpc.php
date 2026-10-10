<?php
/*
 * chanserv-rpc.php — ChanServ / NickServ INFO via Anope JSON-RPC (no IRC PMs).
 *
 * Same origin as Orbit:
 *   /app/plugins/third/orbit-chanserv/chanserv-rpc.php
 *
 * Secrets in chanserv-rpc.local.php (never overwrite on deploy).
 * Read-only: ChanServ INFO / STATUS / BOTLIST / ACCESS LIST * ALL,
 * NickServ INFO / ALIST / HELP / GLIST / LIST (as the user, never Xreg).
 * NickServ AJOIN LIST / ADD / DEL as the identified nick.
 * REGISTER stays on IRC so Anope maxregistered + require_oper apply as on a normal client.
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

function looks_like_alist(string $s): bool {
  return (bool) preg_match('/\d+\s*[:.)]?\s+!?[#&]/', $s);
}

function valid_nslist_pattern(string $s): bool {
  return (bool) preg_match('/^[#A-Za-z0-9_*?\\-\\[\\]\\\\^{}|`.]{1,64}$/', $s);
}

function valid_nslist_flag(string $s): bool {
  return in_array(strtoupper($s), ['DISPLAY', 'NOEXPIRE', 'SUSPENDED', 'UNCONFIRMED'], true);
}

function rpc_source(array $body, string $account): string {
  $nick = trim((string) ($body['nick'] ?? ''));
  return valid_account($nick) ? $nick : $account;
}

function ns_fold(string $s): string {
  $t = strtolower($s);
  $t = strtr($t, ['é' => 'e', 'è' => 'e', 'ê' => 'e', 'ë' => 'e', 'à' => 'a', 'ù' => 'u']);
  return $t;
}

/** Help / access-denied / not-identified — not usable NickServ INFO or ALIST. */
function ns_denied_or_help(string $s): bool {
  $fold = ns_fold($s);
  return (bool) preg_match(
    '/syntaxe:|syntax:|acces refuse|access denied|permission denied|pas identifie|not identified|must be identified|vous devez.{0,40}identifi|information.{0,40}prive|is private/',
    $fold
  );
}

function looks_like_info(string $s): bool {
  foreach (preg_split("/\r\n|\n|\r/", $s) as $line) {
    $line = trim($line);
    if ($line === '' || preg_match('/^(syntaxe|syntax)\s*:/i', $line)) {
      continue;
    }
    if (preg_match('/^[^:]{2,60}:\s+\S/', $line)) {
      return true;
    }
  }
  return false;
}

function is_alist_empty_msg(string $s): bool {
  return (bool) preg_match('/aucun salon|n[\'’ ]a acces a aucun|has no access|no access (?:on|to) any/i', ns_fold($s));
}

function looks_like_ajoin(string $s): bool {
  return (bool) preg_match('/[#&][^\s,]+/', $s);
}

function is_ajoin_empty_msg(string $s): bool {
  return (bool) preg_match('/aucun auto-?join|no auto-?join|liste d[\'’]?auto-?join.{0,40}vide/i', ns_fold($s));
}

function valid_chan_key(string $s): bool {
  return (bool) preg_match('/^[^\s,:]{1,48}$/', $s);
}

function ns_debug_log(?string $line = null): array {
  static $notes = [];
  if ($line !== null && $line !== '') {
    $notes[] = $line;
  }
  return $notes;
}

function ns_preview(string $s, int $n = 220): string {
  $t = trim(preg_replace('/\s+/', ' ', $s) ?? '');
  if ($t === '') {
    return '';
  }
  if (function_exists('mb_strlen') && function_exists('mb_substr')) {
    return mb_strlen($t) > $n ? mb_substr($t, 0, $n) . '…' : $t;
  }
  return strlen($t) > $n ? substr($t, 0, $n) . '…' : $t;
}

function ns_identify(string $url, string $token, bool $bearerB64, string $account, string $source): void {
  try {
    // Prefer skipping this: anope.identify re-fires login hooks (Gardian stats
    // NOTICE) on every RPC. Call only when a command was access-denied.
    anope_rpc($url, $token, $bearerB64, 'anope.identify', [$account, $source], 2);
    ns_debug_log('identify:ok');
  } catch (Throwable $e) {
    ns_debug_log('identify:fail ' . $e->getMessage());
  }
}

function ns_cmd(string $url, string $token, bool $bearerB64, array $params): string {
  $label = isset($params[2]) ? strtoupper((string) $params[2]) : 'CMD';
  try {
    $out = flatten_rpc(anope_rpc($url, $token, $bearerB64, 'anope.command', $params, 5));
    ns_debug_log($label . ($out === '' ? ':vide' : ':' . ns_preview($out)));
    return $out;
  } catch (Throwable $e) {
    ns_debug_log($label . ':rpc ' . $e->getMessage());
    return '';
  }
}

/** Run a NickServ command; identify + retry only if the first answer is denied. */
function ns_cmd_as(
  string $url,
  string $token,
  bool $bearerB64,
  string $account,
  string $source,
  array $params,
  ?callable $usable = null,
): string {
  $out = ns_cmd($url, $token, $bearerB64, $params);
  $ok = $usable ? (bool) $usable($out) : ($out !== '' && !ns_denied_or_help($out));
  if ($ok) {
    return $out;
  }
  // SASL users are already identified — identify here is a rare fallback.
  ns_identify($url, $token, $bearerB64, $account, $source);
  return ns_cmd($url, $token, $bearerB64, $params);
}

function ns_info_cmd(string $url, string $token, bool $bearerB64, string $source): string {
  $info = ns_cmd($url, $token, $bearerB64, [$source, 'NickServ', 'INFO']);
  if (ns_denied_or_help($info) || !looks_like_info($info)) {
    $info = ns_cmd($url, $token, $bearerB64, [$source, 'NickServ', 'INFO', $source]);
  }
  if (ns_denied_or_help($info) && !looks_like_info($info)) {
    return '';
  }
  return $info;
}

function anope_rpc(string $url, string $token, bool $bearerB64, string $method, array $params, int $timeoutSec = 5): mixed {
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
  $timeoutSec = max(1, $timeoutSec);
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_HTTPHEADER => $headers,
    CURLOPT_TIMEOUT => $timeoutSec,
    CURLOPT_CONNECTTIMEOUT => min(3, $timeoutSec),
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
if (!valid_account($account)) {
  fail(400, 'bad_params');
}
$nsActions = ['nsaccount', 'nsinfo', 'nsalist', 'nshelp', 'nsglist', 'nslist', 'nsajoin', 'nsset', 'nsrecover'];
if ($action !== 'probe' && $action !== 'botlist' && $action !== 'access'
  && !in_array($action, $nsActions, true)) {
  fail(400, 'bad_action');
}
if (!in_array($action, $nsActions, true) && !valid_channel($channel)) {
  fail(400, 'bad_params');
}

try {
  if ($action === 'nsaccount') {
    $source = rpc_source($body, $account);
    $info = ns_info_cmd($url, $token, $ANOPE_RPC_BEARER_B64, $source);
    if ($info === '' || (ns_denied_or_help($info) && !looks_like_info($info))) {
      ns_identify($url, $token, $ANOPE_RPC_BEARER_B64, $account, $source);
      $info = ns_info_cmd($url, $token, $ANOPE_RPC_BEARER_B64, $source);
    }
    $glist = ns_cmd($url, $token, $ANOPE_RPC_BEARER_B64, [$source, 'NickServ', 'GLIST']);
    if (ns_denied_or_help($glist)) {
      $glist = '';
    }
    $alist = ns_cmd($url, $token, $ANOPE_RPC_BEARER_B64, [$source, 'NickServ', 'ALIST']);
    if (ns_denied_or_help($alist) && !looks_like_alist($alist) && !is_alist_empty_msg($alist)) {
      $alist = '';
    }
    $ajoin = ns_cmd($url, $token, $ANOPE_RPC_BEARER_B64, [$source, 'NickServ', 'AJOIN', 'LIST']);
    if (ns_denied_or_help($ajoin) && !looks_like_ajoin($ajoin) && !is_ajoin_empty_msg($ajoin)) {
      $ajoin = '';
    }
    echo json_encode([
      'ok' => true,
      'info' => $info,
      'glist' => $glist,
      'alist' => $alist,
      'ajoin' => $ajoin,
      'debug' => [
        'source' => $source,
        'account' => $account,
        'notes' => ns_debug_log(),
      ],
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
  }

  if ($action === 'nsrecover') {
    // Ghost reclaim: NickServ RECOVER <nick> as the identified session.
    $source = rpc_source($body, $account);
    $target = trim((string) ($body['target'] ?? ''));
    if (!valid_account($target)) {
      fail(400, 'bad_params');
    }
    $list = ns_cmd_as(
      $url,
      $token,
      $ANOPE_RPC_BEARER_B64,
      $account,
      $source,
      [$source, 'NickServ', 'RECOVER', $target],
      static function (string $out): bool {
        if ($out === '' || ns_denied_or_help($out)) {
          return false;
        }
        // Typical Anope: "has been recovered" / "pseudo récupéré" / RELEASE hint.
        $fold = ns_fold($out);
        if (preg_match('/recover|récupér|recupere|ghost|libéré|libere|released|killed|déconnect/i', $fold)) {
          return true;
        }
        // Non-empty non-help reply from an identified session is usually success.
        return !preg_match('/unknown|inconnu|isn.?t registered|n.?est pas enregistr/i', $fold);
      },
    );
    echo json_encode(['ok' => true, 'list' => $list], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
  }

  if ($action === 'nsset') {
    $source = rpc_source($body, $account);
    $opt = strtoupper(trim((string) preg_replace('/\s+/', ' ', (string) ($body['option'] ?? ''))));
    $rawVal = (string) ($body['value'] ?? '');
    $parts = array_values(array_filter(explode(' ', $opt), static fn($p) => $p !== ''));
    $first = $parts[0] ?? '';
    $toggles = ['AUTOOP', 'CHANSTATS', 'LAYOUT', 'PROTECT', 'PRIVATE', 'HIDE', 'HIDEMAIL', 'KEEPMODES', 'NEVEROP'];
    $values = ['DISPLAY', 'EMAIL', 'GREET', 'LANGUAGE', 'URL'];
    $hideOk = ['EMAIL', 'STATUS', 'USERMASK', 'QUIT'];
    if ($first === '' || (!in_array($first, $toggles, true) && !in_array($first, $values, true))) {
      fail(400, 'bad_params');
    }
    if ($first === 'HIDE') {
      $sub = $parts[1] ?? '';
      if ($sub === '' || !in_array($sub, $hideOk, true)) {
        fail(400, 'bad_params');
      }
    }
    if (in_array($first, $values, true)) {
      $val = trim($rawVal);
      if ($first === 'GREET' && $val === '') {
        $params = [$source, 'NickServ', 'SET', $first];
      } else {
        if ($val === '' || strlen($val) > 200 || preg_match('/[\r\n]/', $val)) {
          fail(400, 'bad_params');
        }
        $params = [$source, 'NickServ', 'SET', $first, $val];
      }
    } else {
      $val = strtoupper(trim($rawVal));
      if (!in_array($val, ['ON', 'OFF'], true)) {
        fail(400, 'bad_params');
      }
      $params = array_merge([$source, 'NickServ', 'SET'], $parts, [$val]);
    }
    $list = ns_cmd($url, $token, $ANOPE_RPC_BEARER_B64, $params);
    echo json_encode(['ok' => true, 'list' => $list], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
  }

  if ($action === 'nsinfo') {
    $source = rpc_source($body, $account);
    $info = ns_info_cmd($url, $token, $ANOPE_RPC_BEARER_B64, $source);
    if ($info === '' || (ns_denied_or_help($info) && !looks_like_info($info))) {
      ns_identify($url, $token, $ANOPE_RPC_BEARER_B64, $account, $source);
      $info = ns_info_cmd($url, $token, $ANOPE_RPC_BEARER_B64, $source);
    }
    echo json_encode(['ok' => true, 'info' => $info], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
  }

  if ($action === 'nsalist') {
    $source = rpc_source($body, $account);
    $list = ns_cmd_as(
      $url, $token, $ANOPE_RPC_BEARER_B64, $account, $source,
      [$source, 'NickServ', 'ALIST'],
      static fn(string $s): bool => looks_like_alist($s) || is_alist_empty_msg($s) || ($s !== '' && !ns_denied_or_help($s)),
    );
    if (ns_denied_or_help($list) && !looks_like_alist($list) && !is_alist_empty_msg($list)) {
      $list = '';
    }
    echo json_encode(['ok' => true, 'list' => $list], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
  }

  if ($action === 'nsglist') {
    $source = rpc_source($body, $account);
    $list = ns_cmd_as(
      $url, $token, $ANOPE_RPC_BEARER_B64, $account, $source,
      [$source, 'NickServ', 'GLIST'],
      static fn(string $s): bool => $s !== '' && !ns_denied_or_help($s),
    );
    if (ns_denied_or_help($list)) {
      $list = '';
    }
    echo json_encode(['ok' => true, 'list' => $list], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
  }

  if ($action === 'nsajoin') {
    $source = rpc_source($body, $account);
    $op = strtoupper(trim((string) ($body['op'] ?? 'LIST')));
    $ajoinChan = trim((string) ($body['channel'] ?? ''));
    $ajoinKey = trim((string) ($body['key'] ?? ''));
    if ($op === 'ADD') {
      if (!valid_channel($ajoinChan)) {
        fail(400, 'bad_params');
      }
      $params = [$source, 'NickServ', 'AJOIN', 'ADD', $ajoinChan];
      if ($ajoinKey !== '' && valid_chan_key($ajoinKey)) {
        $params[] = $ajoinKey;
      }
      $list = ns_cmd($url, $token, $ANOPE_RPC_BEARER_B64, $params);
    } elseif ($op === 'DEL') {
      if (!valid_channel($ajoinChan)) {
        fail(400, 'bad_params');
      }
      $list = ns_cmd($url, $token, $ANOPE_RPC_BEARER_B64, [
        $source, 'NickServ', 'AJOIN', 'DEL', $ajoinChan,
      ]);
    } else {
      $list = ns_cmd($url, $token, $ANOPE_RPC_BEARER_B64, [
        $source, 'NickServ', 'AJOIN', 'LIST',
      ]);
      if (ns_denied_or_help($list) && !looks_like_ajoin($list) && !is_ajoin_empty_msg($list)) {
        $list = '';
      }
    }
    echo json_encode(['ok' => true, 'list' => $list], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
  }

  if ($action === 'nslist') {
    $pattern = trim((string) ($body['pattern'] ?? ''));
    if (!valid_nslist_pattern($pattern)) {
      fail(400, 'bad_params');
    }
    $source = rpc_source($body, $account);
    $params = [$source, 'NickServ', 'LIST', $pattern];
    $flags = $body['flags'] ?? [];
    if (is_array($flags)) {
      foreach ($flags as $flag) {
        $u = strtoupper(trim((string) $flag));
        if (valid_nslist_flag($u)) {
          $params[] = $u;
        }
      }
    }
    $list = ns_cmd_as(
      $url, $token, $ANOPE_RPC_BEARER_B64, $account, $source, $params,
      static fn(string $s): bool => $s !== '' && !ns_denied_or_help($s),
    );
    echo json_encode(['ok' => true, 'list' => $list], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
  }

  if ($action === 'nshelp') {
    $source = rpc_source($body, $account);
    // Optional topic (e.g. "SET LANGUAGE") — short uppercase tokens only.
    $topic = trim((string) ($body['topic'] ?? ''));
    $params = [$source, 'NickServ', 'HELP'];
    if ($topic !== '') {
      $parts = preg_split('/\s+/', strtoupper($topic)) ?: [];
      if (count($parts) < 1 || count($parts) > 3) {
        fail(400, 'bad_params');
      }
      foreach ($parts as $p) {
        if (!preg_match('/^[A-Z][A-Z0-9]{0,20}$/', $p)) {
          fail(400, 'bad_params');
        }
      }
      $params = array_merge($params, $parts);
    }
    // HELP is public — no identify (avoids Gardian login NOTICE).
    $help = ns_cmd($url, $token, $ANOPE_RPC_BEARER_B64, $params);
    echo json_encode(['ok' => true, 'help' => $help], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
  }

  if ($action === 'access') {
    try {
      $list = flatten_rpc(anope_rpc($url, $token, $ANOPE_RPC_BEARER_B64, 'anope.command', [
        $account, 'ChanServ', 'ACCESS', $channel, 'LIST', '*', 'ALL',
      ]));
      $fold = strtolower($list);
      $isHelp = str_contains($fold, 'syntaxe:') || str_contains($fold, 'syntax:');
      if ($list !== '' && !$isHelp) {
        echo json_encode(['ok' => true, 'list' => $list], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
      }
    } catch (Throwable $e) {
      $list = '';
    }
    $lists = [];
    foreach (['QOP', 'SOP', 'AOP', 'HOP', 'VOP'] as $lv) {
      try {
        $lists[$lv] = flatten_rpc(anope_rpc($url, $token, $ANOPE_RPC_BEARER_B64, 'anope.command', [
          $account, 'ChanServ', $lv, $channel, 'LIST',
        ]));
      } catch (Throwable $e) {
        $lists[$lv] = '';
      }
    }
    echo json_encode(['ok' => true, 'lists' => $lists], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
  }

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
