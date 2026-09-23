/**
 * @zakkster/lite-hud -- standalone control driver (the must-fail proof).
 *
 * Every gate must be provably able to fail. This entry drives the torture gate
 * out-of-process and asserts BOTH directions of the invariant:
 *
 *   - a CLEAN run (`node --expose-gc test/torture.mjs`) prints a GATE line
 *     ending in "ok" and exits 0;
 *   - the BREAK run (`LITE_HUD_TORTURE_BREAK=1 node --expose-gc test/torture.mjs`)
 *     arms a deliberately-allocating step, so the alloc gate rejects the window,
 *     the run exits NON-zero, and it never prints an "ok" GATE line.
 *
 * A suite that always fails is as useless as one that never does; both arms are
 * required.
 *
 *     node test/controls.mjs        -> prints exactly "ok", exit 0
 *     npm run torture:controls
 *
 * @license MIT
 */

import { spawnSync } from 'node:child_process';

const ENTRY = new URL('./torture.mjs', import.meta.url).pathname;

function runWith(breakOn) {
    const env = Object.assign({}, process.env);
    if (breakOn) env.LITE_HUD_TORTURE_BREAK = '1';
    else delete env.LITE_HUD_TORTURE_BREAK;
    const res = spawnSync(process.execPath, ['--expose-gc', ENTRY], { env, encoding: 'utf8' });
    return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function fail(msg) {
    process.stderr.write('controls: FAIL -- ' + msg + '\n');
    process.exit(1);
}

// 1. The clean run must pass. If it does not, the BREAK arm is meaningless.
{
    const r = runWith(false);
    if (r.code !== 0) fail('clean run exited ' + r.code + ' (expected 0)\n' + r.stderr);
    if (!/\bok\b/.test(r.stdout) || /\bFAIL\b/.test(r.stdout)) {
        fail('clean run did not print an ok GATE line:\n' + r.stdout + r.stderr);
    }
}

// 2. The BREAK run must exit non-zero and must NOT print an ok GATE line.
{
    const r = runWith(true);
    if (r.code === 0) fail('LITE_HUD_TORTURE_BREAK=1 still exited 0 -- the alloc gate is decorative');
    if (/\| ok\b/.test(r.stdout)) fail('LITE_HUD_TORTURE_BREAK=1 printed an ok GATE line on a failing run');
}

process.stdout.write('ok\n');
