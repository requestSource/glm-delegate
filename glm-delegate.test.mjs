import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChildEnv, parseSecretValue, parseArgs } from './glm-delegate.mjs';

// --- buildChildEnv (security invariant) ---
test('strips the real Anthropic API key from child env', () => {
  const env = buildChildEnv({ ANTHROPIC_API_KEY: 'sk-ant-REAL-do-not-leak', PATH: '/usr/bin' }, 'glm-key');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('points child env at z.ai with the GLM token and models', () => {
  const env = buildChildEnv({}, 'glm-key-123');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'glm-key-123');
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.2[1m]');
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-5.2[1m]');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-4.7');
});

test('sets CLAUDE_CONFIG_DIR when provided (S2 isolation), omits otherwise', () => {
  assert.equal(buildChildEnv({}, 'k', '/tmp/cfg').CLAUDE_CONFIG_DIR, '/tmp/cfg');
  assert.equal(buildChildEnv({}, 'k').CLAUDE_CONFIG_DIR, undefined);
});

test('preserves unrelated parent vars', () => {
  const env = buildChildEnv({ PATH: '/usr/bin', FOO: 'bar' }, 'k');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.FOO, 'bar');
});

// --- parseSecretValue (fix R3) ---
test('parseSecretValue strips surrounding quotes', () => {
  assert.equal(parseSecretValue('"abc123"'), 'abc123');
  assert.equal(parseSecretValue("'abc123'"), 'abc123');
  assert.equal(parseSecretValue('  abc123  '), 'abc123');
});

test('parseSecretValue strips an unquoted trailing inline comment', () => {
  assert.equal(parseSecretValue('abc123  # my key'), 'abc123');
  assert.equal(parseSecretValue('abc123\t# note'), 'abc123');
});

test('parseSecretValue keeps # that is part of a quoted value', () => {
  assert.equal(parseSecretValue('"ab#c"'), 'ab#c');
});

// --- parseArgs (fixes C2/C3/R4) ---
test('parseArgs rejects an unknown mode', () => {
  assert.ok(parseArgs(['frobnicate']).error);
  assert.ok(parseArgs([]).error);
});

test('parseArgs defaults cwd=null and a positive maxDuration', () => {
  const p = parseArgs(['review']);
  assert.equal(p.error, undefined);
  assert.equal(p.cwd, null);
  assert.ok(p.maxDuration > 0);
  assert.deepEqual(p.unknown, []);
});

test('parseArgs rejects --max-duration without a positive integer (fix C2)', () => {
  assert.ok(parseArgs(['review', '--max-duration']).error);
  assert.ok(parseArgs(['review', '--max-duration', 'abc']).error);
  assert.ok(parseArgs(['review', '--max-duration', '-5']).error);
  assert.ok(parseArgs(['review', '--max-duration', '0']).error);
});

test('parseArgs rejects --cwd without a value (fix C3)', () => {
  assert.ok(parseArgs(['review', '--cwd']).error);
  assert.ok(parseArgs(['review', '--cwd=']).error);
});

test('parseArgs accepts the --flag=value form (fix R4)', () => {
  const p = parseArgs(['review', '--cwd=/repo', '--max-duration=60']);
  assert.equal(p.error, undefined);
  assert.equal(p.cwd, '/repo');
  assert.equal(p.maxDuration, 60);
});

test('parseArgs accepts space-separated values', () => {
  const p = parseArgs(['research', '--cwd', '/repo', '--max-duration', '120']);
  assert.equal(p.cwd, '/repo');
  assert.equal(p.maxDuration, 120);
});

test('parseArgs collects unknown flags rather than silently passing them (fix R4)', () => {
  const p = parseArgs(['research', '--bogus', 'x']);
  assert.equal(p.error, undefined);
  assert.deepEqual(p.unknown, ['--bogus', 'x']);
});
