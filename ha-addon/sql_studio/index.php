<?php
// Read options from /data/options.json if available
$options_file = '/data/options.json';
$db_host = '192.168.68.84';
$db_port = 5432;
$db_user = 'postgres';
$db_pass = 'ha_postgres_secure_pass_2026';
$default_db = 'emporia_energy';

if (file_exists($options_file)) {
    $opts = json_decode(file_get_contents($options_file), true);
    if (!empty($opts['db_host'])) $db_host = $opts['db_host'];
    if (!empty($opts['db_port'])) $db_port = $opts['db_port'];
    if (!empty($opts['db_user'])) $db_user = $opts['db_user'];
    if (!empty($opts['db_password'])) $db_pass = $opts['db_password'];
    if (!empty($opts['default_db'])) $default_db = $opts['default_db'];
}

function adminer_object() {
    global $db_host, $db_port, $db_user, $db_pass, $default_db;

    class AdminerCustom extends Adminer {
        private $h, $p, $u, $pw, $d;
        function __construct($h, $p, $u, $pw, $d) {
            $this->h = $h;
            $this->p = $p;
            $this->u = $u;
            $this->pw = $pw;
            $this->d = $d;
        }

        function name() {
            return '⚡ SQL Studio (Home Assistant)';
        }

        function credentials() {
            return array("{$this->h}:{$this->p}", $this->u, $this->pw);
        }

        function database() {
            return isset($_GET['db']) && !empty($_GET['db']) ? $_GET['db'] : $this->d;
        }

        function login($login, $password) {
            return true;
        }
    }
    return new AdminerCustom($db_host, $db_port, $db_user, $db_pass, $default_db);
}

include "./adminer.php";
