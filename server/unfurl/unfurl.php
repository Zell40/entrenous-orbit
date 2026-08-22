<?php
/**
 * unfurl.php — same-origin GET /accounts/api/unfurl/?url= for Orbit link previews.
 *
 * Orbit (src/lib/link-preview.tsx) expects:
 *   { "url", "title", "description", "image", "siteName" }
 * at least one of title / description / image must be present.
 *
 * Deploy at webchat root; config/.htaccess rewrites the Orbit path.
 */
declare(strict_types=1);

$HTTP_TIMEOUT = 12.0;
$MAX_BYTES    = 524288;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') {
    http_response_code(405);
    echo json_encode(['detail' => 'method_not_allowed']);
    exit;
}

$raw = trim((string) ($_GET['url'] ?? ''));
if ($raw === '' || strlen($raw) > 2048) {
    http_response_code(400);
    echo json_encode(['detail' => 'bad_url']);
    exit;
}

$target = unfurl_normalize_url($raw);
if ($target === null) {
    http_response_code(400);
    echo json_encode(['detail' => 'bad_url']);
    exit;
}

$html = unfurl_fetch($target, $HTTP_TIMEOUT, $MAX_BYTES);
if ($html === null) {
    http_response_code(200);
    echo json_encode(new stdClass());
    exit;
}

$meta = unfurl_parse(unfurl_head($html), $target);
if (!$meta['title'] && !$meta['description'] && !$meta['image']) {
    $meta = unfurl_parse($html, $target);
}
if (!$meta['title'] && !$meta['description'] && !$meta['image']) {
    echo json_encode(new stdClass());
    exit;
}

header('Cache-Control: public, max-age=300');
echo json_encode($meta, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

function unfurl_normalize_url(string $raw): ?string {
    if (!preg_match('#^https?://#i', $raw)) {
        return null;
    }
    $p = parse_url($raw);
    if (!is_array($p) || empty($p['host']) || empty($p['scheme'])) {
        return null;
    }
    $scheme = strtolower((string) $p['scheme']);
    if ($scheme !== 'http' && $scheme !== 'https') {
        return null;
    }
    $host = strtolower((string) $p['host']);
    if ($host === 'localhost' || str_ends_with($host, '.localhost') || str_ends_with($host, '.local')) {
        return null;
    }
    $ips = @gethostbynamel($host) ?: [];
    if (!$ips) {
        return null;
    }
    foreach ($ips as $ip) {
        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
            return null;
        }
    }
    return $raw;
}

function unfurl_fetch(string $url, float $timeout, int $maxBytes): ?string {
    if (!function_exists('curl_init')) {
        return null;
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_CONNECTTIMEOUT => 6,
        CURLOPT_TIMEOUT => (int) ceil($timeout),
        CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        CURLOPT_HTTPHEADER => [
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language: fr-FR,fr;q=0.9,en;q=0.8',
        ],
        CURLOPT_ENCODING => '',
    ]);
    if (defined('CURL_IPRESOLVE_V4')) {
        curl_setopt($ch, CURLOPT_IPRESOLVE, CURL_IPRESOLVE_V4);
    }
    $body = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_errno($ch);
    $final = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    $primaryIp = (string) curl_getinfo($ch, CURLINFO_PRIMARY_IP);
    curl_close($ch);
    if ($err || $code < 200 || $code >= 400 || !is_string($body) || $body === '') {
        return null;
    }
    if ($primaryIp !== '' && !filter_var($primaryIp, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
        return null;
    }
    if ($final !== '' && unfurl_normalize_url($final) === null) {
        return null;
    }
    if (strlen($body) > $maxBytes) {
        $body = substr($body, 0, $maxBytes);
    }
    return $body;
}

function unfurl_head(string $html): string {
    if (preg_match('/<head\b[^>]*>(.*?)<\/head>/is', $html, $m)) {
        return $m[1];
    }
    return substr($html, 0, 131072);
}

function unfurl_parse(string $html, string $fallbackUrl): array {
    $title = unfurl_meta($html, ['og:title', 'twitter:title']) ?: unfurl_title_tag($html);
    $desc = unfurl_meta($html, ['og:description', 'twitter:description', 'description']);
    $image = unfurl_meta($html, ['og:image:secure_url', 'og:image', 'twitter:image']);
    $site = unfurl_meta($html, ['og:site_name']);
    if ($image) {
        $image = unfurl_abs_url($image, $fallbackUrl);
        $pageHost = strtolower((string) (parse_url($fallbackUrl, PHP_URL_HOST) ?: ''));
        $imgHost = strtolower((string) (parse_url((string) $image, PHP_URL_HOST) ?: ''));
        // Same host as the page we already fetched — skip a second DNS/SSRF round-trip.
        if ($image && $imgHost !== $pageHost && unfurl_normalize_url($image) === null) {
            $image = null;
        }
    }
    return [
        'url' => $fallbackUrl,
        'title' => unfurl_clip($title, 180),
        'description' => unfurl_clip($desc, 240),
        'image' => $image,
        'siteName' => unfurl_clip($site, 80),
    ];
}

function unfurl_meta(string $html, array $names): ?string {
    foreach ($names as $name) {
        $q = preg_quote($name, '/');
        $re = '/<meta\b[^>]*(?:property|name)\s*=\s*["\']' . $q . '["\'][^>]*>/is';
        if (!preg_match($re, $html, $m)) {
            $re = '/<meta\b[^>]*content\s*=\s*["\']([^"\']+)["\'][^>]*(?:property|name)\s*=\s*["\']' . $q . '["\'][^>]*>/is';
            if (preg_match($re, $html, $m2)) {
                $v = html_entity_decode(trim($m2[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8');
                if ($v !== '') {
                    return $v;
                }
            }
            continue;
        }
        if (preg_match('/content\s*=\s*["\']([^"\']*)["\']/i', $m[0], $c)) {
            $v = html_entity_decode(trim($c[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8');
            if ($v !== '') {
                return $v;
            }
        }
    }
    return null;
}

function unfurl_title_tag(string $html): ?string {
    if (!preg_match('/<title[^>]*>([^<]+)<\/title>/is', $html, $m)) {
        return null;
    }
    $v = html_entity_decode(trim($m[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return $v !== '' ? $v : null;
}

function unfurl_abs_url(string $src, string $base): string {
    $src = trim($src);
    if (preg_match('#^https?://#i', $src)) {
        return $src;
    }
    $b = parse_url($base);
    if (!is_array($b) || empty($b['scheme']) || empty($b['host'])) {
        return $src;
    }
    $origin = $b['scheme'] . '://' . $b['host'] . (isset($b['port']) ? ':' . $b['port'] : '');
    if (str_starts_with($src, '//')) {
        return $b['scheme'] . ':' . $src;
    }
    if (str_starts_with($src, '/')) {
        return $origin . $src;
    }
    $dir = isset($b['path']) ? preg_replace('#/[^/]*$#', '/', $b['path']) : '/';
    return $origin . $dir . $src;
}

function unfurl_clip(?string $s, int $n): ?string {
    if ($s === null) {
        return null;
    }
    $s = preg_replace('/\s+/', ' ', $s) ?? $s;
    $s = trim($s);
    if ($s === '') {
        return null;
    }
    if (function_exists('mb_strlen') && mb_strlen($s) > $n) {
        return mb_substr($s, 0, $n - 1) . '…';
    }
    if (strlen($s) > $n) {
        return substr($s, 0, $n - 1) . '...';
    }
    return $s;
}
