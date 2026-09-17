<?php
// SQL Studio - Adminer 6.1.0
// Strict Content-Security-Policy: Only allow framing from your trusted local IP and Tailscale network
header_remove("X-Frame-Options");
header("Content-Security-Policy: frame-ancestors 'self' http://192.168.68.84:8123 http://homeassistant.local:8123 https://homeassistant.tail6e5993.ts.net http://homeassistant.tail6e5993.ts.net;");

if (!isset($_GET['pgsql'])) {
    $_GET['pgsql'] = '192.168.68.84:5432';
}
if (!isset($_GET['username'])) {
    $_GET['username'] = 'postgres';
}
if (!isset($_GET['db'])) {
    $_GET['db'] = 'emporia_energy';
}

require_once __DIR__ . '/adminer.php';
