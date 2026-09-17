<?php
// SQL Studio - Adminer 6.1.0
// Allow embedding in Home Assistant iframes (Tailscale & Local)
header_remove("X-Frame-Options");
header("Content-Security-Policy: frame-ancestors *;");

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
