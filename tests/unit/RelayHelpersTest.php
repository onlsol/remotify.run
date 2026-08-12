<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class RelayHelpersTest extends TestCase
{
    private string $tmp;

    protected function setUp(): void
    {
        $this->tmp = sys_get_temp_dir() . '/remotify-ut-' . bin2hex(random_bytes(6));
        mkdir($this->tmp, 0755, true);
        putenv('DATA_DIR='    . $this->tmp);
        putenv('SCHEME=https');
        putenv('DOMAIN=test.example');
        putenv('PUBLIC_PORT=');
        putenv('SESSION_TTL=60');
        putenv('SOURCE_URL=');
        cfg(true); // force re-read
    }

    protected function tearDown(): void
    {
        if (is_dir($this->tmp)) {
            $it = new RecursiveDirectoryIterator($this->tmp, RecursiveDirectoryIterator::SKIP_DOTS);
            foreach (new RecursiveIteratorIterator($it, RecursiveIteratorIterator::CHILD_FIRST) as $f) {
                if ($f->isDir()) { @rmdir($f->getPathname()); } else { @unlink($f->getPathname()); }
            }
            @rmdir($this->tmp);
        }
    }

    private function key(string $seed): string
    {
        // Deterministic 32-hex key per test, no reliance on global state.
        return str_pad(substr(sha1($seed), 0, 32), 32, '0');
    }

    // -----------------------------------------------------------------
    // Config
    // -----------------------------------------------------------------

    public function testCfgReadsEnv(): void
    {
        $c = cfg();
        $this->assertSame('https',        $c['scheme']);
        $this->assertSame('test.example', $c['domain']);
        $this->assertSame('https://test.example', $c['base']);
        $this->assertSame($this->tmp,     $c['data_dir']);
        $this->assertSame(60,             $c['session_ttl']);
        $this->assertFalse($c['audit_log']);
    }

    public function testCfgOmitsDefaultPort(): void
    {
        putenv('PUBLIC_PORT=443');
        cfg(true);
        $this->assertStringNotContainsString(':443', cfg()['base']);
    }

    public function testCfgIncludesNonDefaultPort(): void
    {
        putenv('PUBLIC_PORT=8443');
        cfg(true);
        $this->assertStringContainsString(':8443', cfg()['base']);
    }

    // -----------------------------------------------------------------
    // Session lifecycle
    // -----------------------------------------------------------------

    public function testSessionDirCreateAndTouch(): void
    {
        $k = $this->key('a');
        $this->assertFalse(is_dir(session_dir($k)));
        create_session($k);
        $this->assertDirectoryExists(session_dir($k));
        $this->assertTrue(touch_session($k));
    }

    public function testTouchUnknownSessionReturnsFalse(): void
    {
        $this->assertFalse(touch_session($this->key('unknown')));
    }

    public function testTouchExpiredSessionPurges(): void
    {
        $k = $this->key('expired');
        create_session($k);
        // Backdate the dir mtime past the 60s TTL.
        @touch(session_dir($k), time() - 600);
        clearstatcache(true, session_dir($k));
        $this->assertFalse(touch_session($k));
        $this->assertDirectoryDoesNotExist(session_dir($k));
    }

    public function testPurgeRemovesEverything(): void
    {
        $k = $this->key('purge');
        create_session($k);
        write_queue($k, 'cmd', 'hello');
        write_queue($k, 'result', 'world');
        $this->assertDirectoryExists(session_dir($k));
        purge_session($k);
        $this->assertDirectoryDoesNotExist(session_dir($k));
    }

    // -----------------------------------------------------------------
    // Queue slot I/O
    // -----------------------------------------------------------------

    public function testWriteReadRoundTrip(): void
    {
        $k = $this->key('rw');
        create_session($k);
        $this->assertSame(201, write_queue($k, 'cmd', 'echo hi'));
        $this->assertSame('echo hi', read_queue($k, 'cmd'));
        $this->assertNull(read_queue($k, 'cmd')); // second read: nothing to consume
    }

    public function testWriteQueueLastWins(): void
    {
        $k = $this->key('lastwins');
        create_session($k);
        write_queue($k, 'cmd', 'first');
        write_queue($k, 'cmd', 'second');
        $this->assertSame('second', read_queue($k, 'cmd'));
    }

    public function testArchivesAreKeptOnRotation(): void
    {
        $k = $this->key('archive');
        create_session($k);
        write_queue($k, 'cmd', 'first');
        write_queue($k, 'cmd', 'second');
        $archives = glob(session_dir($k) . '/cmd-*') ?: [];
        $this->assertGreaterThanOrEqual(2, count($archives));
    }

    public function testDeleteHotDropsWithoutConsuming(): void
    {
        $k = $this->key('drop');
        create_session($k);
        write_queue($k, 'cmd', 'bye');
        $this->assertFileExists(session_dir($k) . '/cmd');
        delete_hot($k, 'cmd');
        $this->assertFileDoesNotExist(session_dir($k) . '/cmd');
        $this->assertNull(read_queue($k, 'cmd'));
        // The archive of the dropped push still survives for audit.
        $this->assertNotEmpty(glob(session_dir($k) . '/cmd-*'));
    }

    public function testReadQueueOnUnknownSessionReturnsNull(): void
    {
        $this->assertNull(read_queue($this->key('nope'), 'cmd'));
    }

    public function testBinarySafetyRoundTrip(): void
    {
        $k = $this->key('binary');
        create_session($k);
        $body = "\x00\x01\x02ABC\x7f\xffend";
        write_queue($k, 'result', $body);
        $this->assertSame($body, read_queue($k, 'result'));
    }

    // -----------------------------------------------------------------
    // Stale in-flight self-heal
    // -----------------------------------------------------------------

    public function testSelfHealNoopWhenIdle(): void
    {
        $k = $this->key('sh-idle');
        create_session($k);
        $this->assertFalse(self_heal_stale_inflight($k));
        $this->assertNull(read_queue($k, 'result'), 'no synthetic result on an idle session');
    }

    public function testSelfHealNoopWhileCmdStillQueued(): void
    {
        // A queued-but-unconsumed cmd is "waiting for pickup", not in-flight.
        $k = $this->key('sh-queued');
        create_session($k);
        write_queue($k, 'cmd', 'echo hi');
        $this->assertFalse(self_heal_stale_inflight($k));
        $this->assertSame('echo hi', read_queue($k, 'cmd'), 'queued cmd untouched');
    }

    public function testSelfHealRespectsGraceOnFreshInflight(): void
    {
        $k = $this->key('sh-fresh');
        create_session($k);
        write_queue($k, 'cmd', 'echo hi');
        read_queue($k, 'cmd');
        mark_cmd_consumed($k);
        clearstatcache();
        $this->assertFalse(self_heal_stale_inflight($k), 'within the 2s grace: no heal');
        $this->assertTrue(cmd_in_flight($k), 'still in flight');
    }

    public function testSelfHealClearsStaleInflightAndQueuesMarker(): void
    {
        $k = $this->key('sh-stale');
        create_session($k);
        write_queue($k, 'cmd', 'echo hi');
        read_queue($k, 'cmd');
        mark_cmd_consumed($k);
        touch(session_dir($k) . '/_phase', time() - 10); // backdate past the grace
        clearstatcache();
        $this->assertTrue(self_heal_stale_inflight($k));
        clearstatcache();
        $this->assertFalse(cmd_in_flight($k), 'phase flipped back to idle');
        $result = read_queue($k, 'result');
        $this->assertNotNull($result, 'synthetic result queued for the waiting client');
        $this->assertStringStartsWith('[remotify: ', $result);
    }

    // -----------------------------------------------------------------
    // Payload + runner_script shape
    // -----------------------------------------------------------------

    public function testSessionPayloadShape(): void
    {
        $k = $this->key('payload');
        $p = session_payload($k);
        $this->assertSame($k, $p['key']);
        $this->assertSame(60, $p['ttl_seconds']);
        $this->assertSame("https://test.example/cmd-$k",            $p['urls']['cmd']);
        $this->assertSame("https://test.example/result-$k",         $p['urls']['result']);
        $this->assertSame("https://test.example/r/$k",              $p['urls']['runner']);
        $this->assertSame("https://test.example/api/session/$k",    $p['urls']['api']);
        $this->assertStringStartsWith("curl -fsSL '", $p['remote_quickstart']);
        $this->assertStringContainsString("/r/$k",    $p['remote_quickstart']);
        $this->assertStringNotContainsString('?mode=auto', $p['remote_quickstart']);
    }

    public function testRunnerScriptSupervised(): void
    {
        $k = $this->key('runsup');
        $s = runner_script($k, 'supervised');
        $this->assertStringStartsWith('#!/usr/bin/env bash', $s);
        $this->assertStringContainsString('[supervised]',               $s);
        $this->assertStringContainsString("KEY='$k'",                   $s);
        $this->assertStringContainsString('[yY]*',                      $s); // lenient y-match
        $this->assertStringContainsString('DEBIAN_FRONTEND=noninteractive', $s);
        $this->assertStringContainsString('>>> %s',                     $s);
        $this->assertStringContainsString('<<< done',                   $s);
        $this->assertStringContainsString('declined by operator',       $s);
    }

    public function testRunnerScriptAuto(): void
    {
        $k = $this->key('runauto');
        $s = runner_script($k, 'auto');
        $this->assertStringContainsString('[auto]',   $s);
        $this->assertStringContainsString('>>> %s',   $s);
        $this->assertStringContainsString('<<< done', $s);
        $this->assertStringNotContainsString('Run? [y/N]',  $s); // auto does not prompt
        $this->assertStringNotContainsString('[declined',   $s);
        $this->assertStringContainsString("KEY='$k'", $s);
        $this->assertStringContainsString('DEBIAN_FRONTEND=noninteractive', $s);
    }

    public function testRunnerScriptUnknownModeFallsBackToSupervised(): void
    {
        // The h_runner() handler normalizes unknown modes to 'supervised',
        // but runner_script() itself should at least not blow up when handed
        // a value it doesn't recognize.
        $s = runner_script($this->key('weird'), 'banana');
        $this->assertStringStartsWith('#!/usr/bin/env bash', $s);
        // Guard against an approval-bypass regression: an unrecognized mode
        // must fall back to the safe supervised behavior (prompts before
        // running, self-identifies as supervised), never to auto.
        $this->assertStringContainsString('[supervised]', $s);
        $this->assertStringContainsString('Run? [y/N]',   $s);
        $this->assertStringNotContainsString('[auto]',     $s);
    }
}
