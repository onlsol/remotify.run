<?php
declare(strict_types=1);

// Marks the include as library-only: the dispatcher at the bottom of
// index.php returns immediately so the helpers are available to tests.
define('REMOTIFY_TESTING', true);
require_once dirname(__DIR__, 2) . '/php/app/index.php';
