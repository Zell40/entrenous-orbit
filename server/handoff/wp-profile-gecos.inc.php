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

/**
 * Build "40 - Homme - Paris" from WP profile fields (source of truth).
 */
function entrenous_build_gecos_from_profile(array $data): string
{
    if (empty($data['exists'])) {
        return '';
    }
    $age = $data['age'] ?? null;
    $sexe = isset($data['sexe']) ? trim((string) $data['sexe']) : '';
    $ville = isset($data['ville']) ? trim((string) $data['ville']) : '';
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
 * Fetch GECOS for a NickServ / WP login from the public profile API.
 */
function entrenous_fetch_wp_gecos(string $account, string $profileUrl, float $timeout = 2.5): string
{
    $account = trim($account);
    if ($account === '' || !preg_match('/^[A-Za-z0-9_\[\]\\\\`|^{}-]{1,50}$/', $account)) {
        return '';
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
        return '';
    }
    $data = json_decode($body, true);
    if (!is_array($data)) {
        return '';
    }
    return entrenous_build_gecos_from_profile($data);
}
