<?php
/**
 * Handoff WordPress → Orbit (same-origin).
 *
 * Reçoit en POST le JWT + nick/channel depuis la page test MonIdentité Orbit,
 * pose le marqueur sessionStorage attendu par Orbit (`tchatou_handoff`),
 * puis redirige vers l’app Orbit (?nick=&channel=).
 *
 * Déployer à la racine du webchat Orbit, ex. :
 *   /home/chat/irc/webchat-new/handoff.php
 *
 * Ne contient aucun secret : le JWT arrive déjà signé par WordPress.
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

if ($token === '' || $nick === '') {
    http_response_code(400);
    echo 'Missing token or nick';
    exit;
}

// Cible Orbit : priorité au champ target (construit côté WP), sinon rebuild local
if ($target === '' || !preg_match('#^https?://#i', $target)) {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host   = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $target = $scheme . '://' . $host . '/?nick=' . rawurlencode($nick);
    if ($channel !== '') {
        $target .= '&channel=' . rawurlencode($channel);
    }
}

$payload = [
    'password' => $token,
    't'        => (int) round(microtime(true) * 1000),
];
if ($account !== '') {
    $payload['account'] = $account;
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
  <title>Connexion Orbit…</title>
</head>
<body>
  <p style="font-family:sans-serif;text-align:center;margin-top:3rem;">Connexion sécurisée en cours…</p>
  <script>
  (function () {
    var payload = <?= json_encode($handoff_json, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>;
    var target  = <?= json_encode($target, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT) ?>;
    try {
      sessionStorage.setItem('tchatou_handoff', payload);
    } catch (e) {
      document.body.innerHTML = '<p style="font-family:sans-serif;color:#c00;text-align:center;margin-top:3rem;">Impossible d’écrire sessionStorage (mode privé ?).</p>';
      return;
    }
    location.replace(target);
  })();
  </script>
</body>
</html>
