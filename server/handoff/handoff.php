<?php
/**
 * Handoff WordPress → Orbit (same-origin).
 *
 * Reçoit en POST le JWT + nick/channel (+ profil) depuis MonIdentité Orbit,
 * pose le marqueur sessionStorage attendu par Orbit (`orbit_handoff`),
 * pose un cookie HttpOnly de reprise (`orbit_en_resume`) pour renouveler le JWT,
 * puis redirige vers l’app Orbit (?nick=&channel=).
 *
 * Déployer à la racine du webchat Orbit, ex. :
 *   /home/chat/irc/webchat-new/handoff.php
 *
 * Le secret HMAC du cookie est lu dans chat-resume.local.php (même fichier que
 * chat-resume.php) — pas de secret dans ce script.
 */
declare(strict_types=1);

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    echo 'POST only';
    exit;
}

$token   = isset($_POST['token'])   ? (string) $_POST['token']   : '';
$nick    = isset($_POST['nick'])    ? trim((string) $_POST['nick']) : '';
$channel = isset($_POST['channel']) ? trim((string) $_POST['channel']) : '';
$target  = isset($_POST['target'])  ? (string) $_POST['target']  : '';
$account = isset($_POST['account']) ? trim((string) $_POST['account']) : '';
$age     = isset($_POST['age'])     ? trim((string) $_POST['age']) : '';
$sexe    = isset($_POST['sexe'])    ? trim((string) $_POST['sexe']) : '';
$ville   = isset($_POST['ville'])   ? trim((string) $_POST['ville']) : '';

if ($token === '' || $nick === '') {
    http_response_code(400);
    echo 'Missing token or nick';
    exit;
}

if ($target === '' || !preg_match('#^https?://#i', $target)) {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host   = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $target = $scheme . '://' . $host . '/?nick=' . rawurlencode($nick);
    if ($channel !== '') {
        $target .= '&channel=' . rawurlencode($channel);
    }
}

$realname = '';
if ($age !== '' && $sexe !== '' && $ville !== '') {
    $sexeKey = strtoupper($sexe);
    $label = match ($sexeKey) {
        'H', 'M', 'HOMME', 'MALE' => 'Homme',
        'F', 'FEMME', 'FEMALE' => 'Femme',
        'A', 'AUTRE', 'OTHER' => 'Autre',
        default => '',
    };
    if ($label === '' && preg_match('/^(homme|femme|autre)$/iu', $sexe)) {
        $label = mb_convert_case($sexe, MB_CASE_TITLE, 'UTF-8');
    }
    $villeClean = preg_replace('/[\r\n]+/', ' ', $ville) ?? $ville;
    $villeClean = mb_substr(trim($villeClean), 0, 40);
    if ($label !== '' && preg_match('/^\d{1,3}$/', $age) && $villeClean !== '') {
        $realname = $age . ' - ' . $label . ' - ' . $villeClean;
    }
}

$payload = [
    'password' => $token,
    't'        => (int) round(microtime(true) * 1000),
];
if ($account !== '') {
    $payload['account'] = $account;
}
if ($realname !== '') {
    $payload['realname'] = $realname;
}

// Long-lived resume cookie (14 days) so Orbit can mint a fresh SASL JWT later.
$resumeAccount = $account !== '' ? $account : $nick;
$local = __DIR__ . '/chat-resume.local.php';
if ($resumeAccount !== '' && is_readable($local)) {
    /** @var array{jwt_secret?:string} $cfg */
    $cfg = require $local;
    $secret = (string)($cfg['jwt_secret'] ?? '');
    if ($secret !== '' && $secret !== 'CHANGE_ME_SAME_AS_WORDPRESS') {
        $exp = time() + 14 * 86400;
        // Cookie payload: nick \n account \n exp [ \n realname ] \n sig
        // realname is optional (EntreNous GECOS) so older 4-field cookies still verify.
        $body = $nick . "\n" . $resumeAccount . "\n" . $exp;
        if ($realname !== '') {
            $body .= "\n" . $realname;
        }
        $sig = hash_hmac('sha256', $body, $secret);
        $cookie = rtrim(strtr(base64_encode($body . "\n" . $sig), '+/', '-_'), '=');
        setcookie('orbit_en_resume', $cookie, [
            'expires'  => $exp,
            'path'     => '/',
            'secure'   => true,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }
}

$handoff_json = json_encode($payload, JSON_UNESCAPED_SLASHES);

header('Content-Type: text/html; charset=UTF-8');
header('Cache-Control: no-store');
?>
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="robots" content="noindex">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connexion EntreNous…</title>
  <style>
    html,body{height:100%;margin:0;background:#eef3fb;color:#1a2740;
      font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    .splash{min-height:100%;display:flex;flex-direction:column;align-items:center;
      justify-content:center;gap:1rem;padding:2rem;text-align:center}
    .spin{width:36px;height:36px;border-radius:50%;border:3px solid #c9d7ef;
      border-top-color:#1452cc;animation:s .7s linear infinite}
    @keyframes s{to{transform:rotate(360deg)}}
    p{margin:0;font-size:.95rem;color:#5a6b85}
  </style>
</head>
<body>
  <div class="splash" role="status">
    <div class="spin" aria-hidden="true"></div>
    <p>Connexion au tchat…</p>
  </div>
  <script>
  (function () {
    var payload = <?= json_encode($handoff_json, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>;
    var target  = <?= json_encode($target, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>;
    try {
      sessionStorage.setItem('orbit_handoff', payload);
    } catch (e) {
      document.querySelector('.splash').innerHTML =
        '<p style="color:#c00">Impossible d’écrire sessionStorage (mode privé ?).</p>';
      return;
    }
    location.replace(target);
  })();
  </script>
</body>
</html>
