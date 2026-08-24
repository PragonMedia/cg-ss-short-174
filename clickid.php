<?php
// clickid.php — fetch RedTrack clickid once per session via ?format=json and return JSON
// Call from JS after domain-route-details: POST rtkID + optional redtrackTrackingDomain

if (session_status() !== PHP_SESSION_ACTIVE) session_start();

/* --- Config --- */
function getDomainAndRoute()
{
  $domain = $_SERVER['HTTP_HOST'] ?? '';
  $domain = preg_replace('/^www\./', '', $domain);

  $requestUri = $_SERVER['REQUEST_URI'] ?? '';
  $path = parse_url($requestUri, PHP_URL_PATH);
  $path = ltrim($path, '/');
  $segments = explode('/', $path);
  $route = $segments[0] ?? '';

  if (empty($route) || strpos($route, '.php') !== false) {
    $referrer = $_SERVER['HTTP_REFERER'] ?? '';
    if ($referrer) {
      $referrerPath = parse_url($referrer, PHP_URL_PATH);
      $referrerPath = ltrim($referrerPath, '/');
      $referrerSegments = explode('/', $referrerPath);
      $route = $referrerSegments[0] ?? '';
    }
  }

  return ['domain' => $domain, 'route' => $route];
}

function normalizeRedtrackBase($hostOrUrl)
{
  $raw = trim((string)$hostOrUrl);
  if ($raw === '') return null;
  if (preg_match('#^https?://#i', $raw)) {
    return rtrim($raw, '/');
  }
  return 'https://' . ltrim($raw, '/');
}

$domainRoute = getDomainAndRoute();
$domain = $domainRoute['domain'];
$route = $domainRoute['route'];

// Prefer rtkID + tracking domain from lander (from domain-route-details). Do not invent IDs.
$cmpId = null;
$rtBase = null;

if (isset($_POST['rtkID']) && $_POST['rtkID'] !== '') {
  $cmpId = $_POST['rtkID'];
  error_log("rtkID received from frontend: " . $cmpId);
}

if (isset($_POST['redtrackTrackingDomain']) && $_POST['redtrackTrackingDomain'] !== '') {
  $rtBase = normalizeRedtrackBase($_POST['redtrackTrackingDomain']);
  error_log("redtrackTrackingDomain from frontend: " . $rtBase);
}

if ($rtBase === null) {
  // Last-resort default host only if domainContext omitted; still requires real rtkID from POST
  $rtBase = 'https://dx8jy.ttrk.io';
}

error_log("FINAL - rtkID being used: " . ($cmpId ?? 'null'));

const SESSION_KEY  = 'rt_clickid';
const SESSION_TTL  = 6 * 3600;                // 6h cache
const COOKIE_NAME  = 'rtkclickid-store';      // parity with RT JS

/* --- Headers / CORS --- */
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
  http_response_code(204);
  exit;
}

/* --- Inputs --- */
$referrer = $_SERVER['HTTP_REFERER'] ?? '';

/* --- Cache hit? --- */
$now = time();
if (!empty($_SESSION[SESSION_KEY]) && !empty($_SESSION[SESSION_KEY . '_ts']) && ($now - $_SESSION[SESSION_KEY . '_ts']) < SESSION_TTL) {
  error_log("clickid - Using cached clickid: " . $_SESSION[SESSION_KEY]);
  echo json_encode([
    'ok'      => true,
    'clickid' => (string)$_SESSION[SESSION_KEY],
    'cached'  => true,
    'ref'     => $referrer,
    'mint_url' => null,
    'debug'   => [
      'domain' => $domain,
      'route' => $route,
      'rtkID' => $cmpId
    ]
  ]);
  exit;
}

// If rtkID is missing, skip RedTrack request — do not invent an ID
if ($cmpId === null || $cmpId === '') {
  echo json_encode([
    'ok'      => false,
    'error'   => 'rtkID is null - RedTrack tracking disabled',
    'ref'     => $referrer,
    'debug'   => [
      'domain' => $domain,
      'route' => $route,
      'rtkID' => null
    ]
  ]);
  exit;
}

/* --- Build mint URL --- */
$rtUrl = rtrim($rtBase, '/') . '/' . rawurlencode($cmpId) . '?format=json';

if ($referrer !== '') {
  $rtUrl .= '&referrer=' . rawurlencode($referrer);

  $qs = parse_url($referrer, PHP_URL_QUERY) ?: '';
  if ($qs !== '') {
    parse_str($qs, $params);
    unset($params['cost'], $params['ref_id']);
    $cleanQs = http_build_query($params);
    if ($cleanQs !== '') $rtUrl .= '&' . $cleanQs;
  }
}

/* --- Mint clickid --- */
$ua       = $_SERVER['HTTP_USER_AGENT'] ?? 'Mozilla/5.0';
$clientIp = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? '');

$ch = curl_init($rtUrl);
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_CONNECTTIMEOUT => 8,
  CURLOPT_TIMEOUT        => 15,
  CURLOPT_SSL_VERIFYPEER => true,
  CURLOPT_SSL_VERIFYHOST => 2,
  CURLOPT_USERAGENT      => $ua,
  CURLOPT_HTTPHEADER     => [
    'Accept: application/json',
    'X-Forwarded-For: ' . $clientIp,
    'X-Real-IP: ' . $clientIp,
  ],
]);
$body = curl_exec($ch);
$err  = curl_error($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($err || $code !== 200) {
  http_response_code(502);
  echo json_encode([
    'ok'    => false,
    'error' => 'RT request failed',
    'status' => $code,
    'detail' => $err,
    'url'   => $rtUrl,
    'ref'   => $referrer
  ]);
  exit;
}

$payload = json_decode($body, true);
$clickid = $payload['clickid'] ?? null;
if (!$clickid) {
  http_response_code(502);
  echo json_encode([
    'ok'    => false,
    'error' => 'No clickid in JSON',
    'url'   => $rtUrl,
    'raw'   => $payload,
    'ref'   => $referrer
  ]);
  exit;
}

/* --- Cache & cookie --- */
$_SESSION[SESSION_KEY] = $clickid;
$_SESSION[SESSION_KEY . '_ts'] = time();

$secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on');
setcookie(COOKIE_NAME, $clickid, [
  'expires'  => time() + 86400 * 30,
  'path'     => '/',
  'secure'   => $secure,
  'httponly' => false,
  'samesite' => 'Lax',
]);

error_log("clickid - Successfully minted: " . $clickid);
error_log("rtkID - Used for RedTrack request: " . ($cmpId ?? 'null'));
echo json_encode([
  'ok'      => true,
  'clickid' => $clickid,
  'cached'  => false,
  'ref'     => $referrer,
  'mint_url' => $rtUrl,
  'debug'   => [
    'domain' => $domain,
    'route' => $route,
    'rtkID' => $cmpId,
    'rtBase' => $rtBase
  ]
]);
