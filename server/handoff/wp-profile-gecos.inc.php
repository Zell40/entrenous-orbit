<?php
/**
 * Shared helper: fetch EntreNous WP profile ASL and build IRC GECOS.
 * Used by chat-resume.php and profile-gecos.php.
 *
 * WP public API (wp-anope-sync):
 *   GET {WP}/wp-json/entrenous/v1/profile?account=<login>
 *   → { exists, age, sexe, ville, avatar, … }
 */
declare(strict_types=1);

function entrenous_flatten_sexe(mixed $sexe): string
{
    if (is_array($sexe)) {
        $sexe = $sexe[0] ?? '';
    }
    return trim((string) $sexe);
}

/**
 * Build "40 - Homme - Paris" from WP profile fields (source of truth).
 */
function entrenous_build_gecos_from_profile(array $data): string
{
    if (empty($data['exists'])) {
        return '';
    }
    $age = $data['age'] ?? null;
    $sexe = entrenous_flatten_sexe($data['sexe'] ?? '');
    $ville = isset($data['ville']) ? (is_array($data['ville']) ? trim((string)($data['ville'][0] ?? '')) : trim((string) $data['ville'])) : '';
    if ($age === null || $age === '' || $sexe === '' || $ville === '') {
        return '';
    }
    $ageStr = (string) (int) $age;
    if ($ageStr === '0' && (string) $age !== '0') {
        return '';
    }
    $sexeKey = mb_strtolower($sexe, 'UTF-8');
    $label = match (true) {
        (bool) preg_match('/^(h|m|homme|male|masculin)$/u', $sexeKey) => 'Homme',
        (bool) preg_match('/^(f|femme|female|feminin|féminin)$/u', $sexeKey) => 'Femme',
        (bool) preg_match('/^(a|autre|other|x|nb|non-?binaire)$/u', $sexeKey) => 'Autre',
        default => '',
    };
    if ($label === '') {
        return '';
    }
    $villeClean = preg_replace('/[\r\n]+/', ' ', $ville) ?? $ville;
    $villeClean = mb_substr(trim($villeClean), 0, 40);
    if ($villeClean === '' || !preg_match('/^\d{1,3}$/', $ageStr)) {
        return '';
    }
    return $ageStr . ' - ' . $label . ' - ' . $villeClean;
}

/**
 * Fetch the public WP profile JSON for a NickServ / WP login.
 * Returns null on transport/parse failure (not the same as exists:false).
 */
function entrenous_fetch_wp_profile(string $account, string $profileUrl, float $timeout = 2.5): ?array
{
    $account = trim($account);
    if ($account === '' || !preg_match('/^[A-Za-z0-9_\[\]\\\\`|^{}-]{1,50}$/', $account)) {
        return null;
    }
    $url = rtrim($profileUrl, '?&') . (str_contains($profileUrl, '?') ? '&' : '?')
        . 'account=' . rawurlencode($account);

    $body = '';
    $code = 0;
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT        => $timeout,
            CURLOPT_CONNECTTIMEOUT => min(2.0, $timeout),
            CURLOPT_HTTPHEADER     => ['Accept: application/json'],
            CURLOPT_USERAGENT      => 'Orbit-EntreNous-gecos/1.0',
        ]);
        $body = (string) curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
    } else {
        $ctx = stream_context_create([
            'http' => [
                'method'  => 'GET',
                'timeout' => $timeout,
                'header'  => "Accept: application/json\r\nUser-Agent: Orbit-EntreNous-gecos/1.0\r\n",
            ],
        ]);
        $body = (string) (@file_get_contents($url, false, $ctx) ?: '');
        if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s/', $http_response_header[0], $m)) {
            $code = (int) $m[1];
        }
    }
    if ($code !== 200 || $body === '') {
        return null;
    }
    $data = json_decode($body, true);
    return is_array($data) ? $data : null;
}

/**
 * Fetch GECOS for a NickServ / WP login from the public profile API.
 */
function entrenous_fetch_wp_gecos(string $account, string $profileUrl, float $timeout = 2.5): string
{
    $data = entrenous_fetch_wp_profile($account, $profileUrl, $timeout);
    if ($data === null) {
        return '';
    }
    return entrenous_build_gecos_from_profile($data);
}

/**
 * Parse age from a WP profile payload or from an IRC GECOS ("40 - Homme - Paris").
 */
function entrenous_age_from_profile_or_gecos(?array $data, string $gecos = ''): ?int
{
    if (is_array($data) && isset($data['age']) && $data['age'] !== '' && $data['age'] !== null) {
        $n = (int) $data['age'];
        if ($n >= 1 && $n <= 120) {
            return $n;
        }
    }
    if ($gecos !== '' && preg_match('/^(\d{1,3})\s*-/', $gecos, $m)) {
        $n = (int) $m[1];
        if ($n >= 1 && $n <= 120) {
            return $n;
        }
    }
    return null;
}

/**
 * Websocket listen cookie value for Apache (cp = contrôle parental, reg = normal).
 * Same rule as MonIdentité: age &lt; 17 → cp (Harry / Lucas exempt).
 */
function entrenous_listen_from_age(?int $age, string $account = ''): string
{
    $login = strtolower(trim($account));
    if ($login === 'harry' || $login === 'lucas') {
        return 'reg';
    }
    if ($age !== null && $age >= 10 && $age < 17) {
        return 'cp';
    }
    return 'reg';
}

/**
 * Set (or refresh) the HttpOnly orbit_en_listen cookie Apache reads on irc.*.
 *
 * @param array{expires?:int,path?:string,secure?:bool,httponly?:bool,samesite?:string,domain?:string} $opts
 */
function entrenous_set_listen_cookie(string $listen, array $opts): void
{
    $listen = ($listen === 'cp') ? 'cp' : 'reg';
    $defaults = [
        'expires'  => time() + 14 * 86400,
        'path'     => '/',
        'secure'   => true,
        'httponly' => true,
        'samesite' => 'Lax',
    ];
    setcookie('orbit_en_listen', $listen, $opts + $defaults);
}
