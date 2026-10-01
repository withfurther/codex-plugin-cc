import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildEnv, installFakeCodex } from './fake-codex-fixture.mjs';
import { initGitRepo, makeTempDir, run } from './helpers.mjs';

const script = fileURLToPath(new URL('../plugins/codex/scripts/codex-companion.mjs', import.meta.url));

function fixture(t) {
  const root = fs.realpathSync(makeTempDir());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const execution = path.join(root, 'execution');
  const bin = path.join(root, 'bin');
  const data = path.join(root, 'data');
  const home = path.join(root, 'home');
  for (const directory of [source, bin, home]) fs.mkdirSync(directory);
  initGitRepo(source);
  function git(...args) {
    const result = run('git', args, { cwd: source });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  fs.writeFileSync(path.join(source, 'file.txt'), 'base\n');
  git('add', 'file.txt');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(source, 'file.txt'), 'feature\n');
  git('commit', '-qam', 'feature');
  git('worktree', 'add', '--detach', execution, 'HEAD');
  installFakeCodex(bin);
  const env = { ...buildEnv(bin), CLAUDE_PLUGIN_DATA: data, HOME: home, CODEX_HOME: path.join(root, 'codex') };
  function command(...args) {
    return run(process.execPath, [script, ...args], { cwd: source, env });
  }
  return { root, source, execution, bin, data, home, env, git, command };
}

test('review tracks immutable worktree jobs in their source workspace and retains results', (t) => {
  const f = fixture(t);
  const first = f.command('review', '--base', 'main', '--json');
  assert.equal(first.status, 0, first.stderr);
  const result = f.command('review', '--cwd', f.execution, '--state-cwd', f.source, '--base', 'main', '--json');
  assert.equal(result.status, 0, result.stderr);
  const namespaces = fs.readdirSync(path.join(f.data, 'state'));
  const states = namespaces.map((namespace) => {
    const filename = path.join(f.data, 'state', namespace, 'state.json');
    return fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : { jobs: [] };
  });
  const populated = states.filter((state) => state.jobs.length > 0);
  assert.equal(populated.length, 1);
  const [state] = populated;
  assert.equal(state.jobs.length, 2);
  assert.ok(state.jobs.every((job) => job.workspaceRoot === f.source));
  const runtime = JSON.parse(fs.readFileSync(path.join(f.bin, 'fake-codex-state.json'), 'utf8'));
  assert.ok(runtime.threads.some((thread) => thread.cwd === f.execution));
  f.git('worktree', 'remove', f.execution);
  for (const job of state.jobs) {
    assert.ok(fs.existsSync(job.logFile));
    const stored = f.command('result', job.id, '--cwd', f.source, '--json');
    assert.equal(stored.status, 0, stored.stderr);
    assert.match(stored.stdout, /Reviewed changes against main/);
  }
  const status = f.command('status', '--cwd', f.source, '--json');
  assert.equal(status.status, 0, status.stderr);
  for (const job of state.jobs) assert.ok(status.stdout.includes(job.id));
});

test('review rejects unrelated and invalid tracking workspaces before starting a job', (t) => {
  const f = fixture(t);
  const unrelated = path.join(f.root, 'unrelated');
  fs.mkdirSync(unrelated);
  initGitRepo(unrelated);
  for (const stateCwd of [unrelated, path.join(f.root, 'missing'), path.join(f.source, 'file.txt'), '']) {
    const result = f.command('review', '--cwd', f.execution, '--state-cwd', stateCwd, '--base', 'main', '--json');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /state workspace|Git repository|same Git repository/);
    assert.equal(fs.existsSync(f.data), false);
    assert.equal(fs.existsSync(path.join(f.bin, 'fake-codex-state.json')), false);
  }
});


test('capabilities advertises state tracking without creating state or invoking Codex', (t) => {
  const f = fixture(t);
  const result = run(process.execPath, [script, 'capabilities', '--json'], {
    cwd: f.root, env: { ...f.env, PATH: f.bin },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    features: ['review.state-cwd.v1'],
  });
  assert.equal(fs.existsSync(f.data), false);
  assert.equal(fs.existsSync(path.join(f.bin, 'fake-codex-state.json')), false);
  assert.deepEqual(fs.readdirSync(f.home), []);
});


test('source status exposes active execution-worktree progress before completion', async (t) => {
  const f = fixture(t);
  installFakeCodex(f.bin, 'controlled-review');
  const child = spawn(process.execPath, [script, 'review', '--cwd', f.execution,
    '--state-cwd', f.source, '--base', 'main', '--json'], { cwd: f.source, env: f.env });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(path.join(f.bin, 'review-ready')) && Date.now() < deadline) await delay(20);
    assert.ok(fs.existsSync(path.join(f.bin, 'review-ready')), stderr);
    let active;
    while (Date.now() < deadline) {
      const result = f.command('status', '--cwd', f.source, '--json');
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      active = report.running.find((job) => job.status === 'running' && job.threadId && job.turnId);
      if (active) break;
      await delay(20);
    }
    assert.ok(active, 'source status must expose running review progress');
    assert.equal(active.workspaceRoot, f.source);
    assert.ok(fs.existsSync(active.logFile));
    assert.equal(child.exitCode, null);
  } finally {
    fs.writeFileSync(path.join(f.bin, 'review-release'), 'release');
    assert.equal(await completion, 0, stderr);
  }
});

test('same, relative, and symlink tracking workspaces resolve to the source namespace', (t) => {
  const f = fixture(t);
  const alias = path.join(f.root, 'source-alias');
  fs.symlinkSync(f.source, alias, 'dir');
  for (const [cwd, stateCwd] of [[f.source, f.source], [f.execution, '.'], [f.execution, alias]]) {
    const result = f.command('review', '--cwd', cwd, '--state-cwd', stateCwd, '--base', 'main', '--json');
    assert.equal(result.status, 0, result.stderr);
  }
  const result = f.command('status', '--cwd', f.source, '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const jobs = [report.latestFinished, ...report.recent];
  assert.equal(jobs.length, 3);
  assert.ok(jobs.every((job) => job.workspaceRoot === f.source));
});


test('Git location and configuration overrides cannot redirect tracking validation', (t) => {
  const f = fixture(t);
  const unrelated = path.join(f.root, 'unrelated');
  fs.mkdirSync(unrelated);
  initGitRepo(unrelated);
  const overrides = [
    { GIT_DIR: path.join(f.source, '.git'), GIT_WORK_TREE: f.source },
    { GIT_COMMON_DIR: path.join(f.source, '.git') },
    { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: f.source },
    { GIT_CONFIG_PARAMETERS: "'core.worktree=" + f.source + "'" },
  ];
  for (const override of overrides) {
    const result = run(process.execPath, [script, 'review', '--cwd', f.execution,
      '--state-cwd', unrelated, '--base', 'main', '--json'], { cwd: f.source, env: { ...f.env, ...override } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /inherited Git/);
    assert.equal(fs.existsSync(f.data), false);
    assert.equal(fs.existsSync(path.join(f.bin, 'fake-codex-state.json')), false);
  }
});

test('tracking namespaces preserve trailing whitespace in linked-worktree paths', (t) => {
  const f = fixture(t);
  for (const suffix of [' ', '\t', '\n']) {
    const tracking = f.source + suffix;
    f.git('worktree', 'add', '--detach', tracking, 'HEAD');
    const result = f.command('review', '--cwd', f.execution, '--state-cwd', tracking, '--base', 'main', '--json');
    assert.equal(result.status, 0, result.stderr);
    const status = f.command('status', '--cwd', tracking, '--json');
    assert.equal(status.status, 0, status.stderr);
    const report = JSON.parse(status.stdout);
    assert.equal(report.workspaceRoot, tracking);
    assert.equal(report.latestFinished.workspaceRoot, tracking);
    assert.equal(report.recent.length, 0);
  }
});
