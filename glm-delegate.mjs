#!/usr/bin/env node
/**
 * glm-delegate — run a headless Claude Code CLI powered by GLM (Zhipu / z.ai)
 * as an INDEPENDENT delegate for code review and research, under orchestration
 * by a primary Claude Code session. The delegate reads code/files itself and
 * returns its own verdict — a model-diversity second opinion.
 *
 * Prompt ALWAYS via stdin (never argv):
 *   printf '%s' "<prompt>" | node glm-delegate.mjs <review|research> [--cwd <path>] [--max-duration <sec>]
 *
 * Key resolution: env GLM_API_KEY first, else GLM_API_KEY=... in a secrets file
 * (GLM_SECRETS_FILE, default ~/.my/secrets.cfg).
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const Z_AI_BASE_URL = 'https://api.z.ai/api/anthropic';
const GLM_BIG_MODEL = 'glm-5.2[1m]';   // 1M context for big-context review/research
const GLM_SMALL_MODEL = 'glm-4.7';     // haiku-tier (background) — cheaper

// Read-only tool set. Bash is intentionally EXCLUDED (fix S1): the delegate
// reads potentially-untrusted code; Bash + bypassPermissions would be an RCE
// vector via prompt-injection inside the reviewed code. Read/Grep/Glob suffice;
// the caller supplies any `git diff` context in the prompt itself.
const MODE_TOOLS = {
  review: 'Read,Grep,Glob',
  research: 'Read,Grep,Glob',
};
const DEFAULT_TIMEOUTS = { review: 900, research: 900 }; // seconds
const STDIN_MAX_BYTES = 10 * 1024 * 1024;
const STDIN_TIMEOUT_MS = 30000;

// --- secret value parsing (fix R3): strip quotes / unquoted inline comment ---
export function parseSecretValue(raw) {
  let v = String(raw).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  const c = v.search(/\s+#/); // unquoted shell-style inline comment
  if (c >= 0) v = v.slice(0, c).trim();
  return v;
}

// Key from env (preferred) or a secrets file with a `GLM_API_KEY=...` line.
function readGlmKey() {
  if (process.env.GLM_API_KEY && process.env.GLM_API_KEY.trim()) {
    return process.env.GLM_API_KEY.trim();
  }
  const secretsPath = process.env.GLM_SECRETS_FILE || path.join(os.homedir(), '.my', 'secrets.cfg');
  let raw;
  try { raw = fs.readFileSync(secretsPath, 'utf8'); }
  catch { throw new Error(`GLM_API_KEY not set and secrets file not readable: ${secretsPath}`); }
  const m = raw.match(/^\s*(?:export\s+)?GLM_API_KEY\s*=\s*(.+)$/m);
  if (!m) throw new Error(`GLM_API_KEY not found (env or ${secretsPath})`);
  const key = parseSecretValue(m[1]);
  if (!key) throw new Error('GLM_API_KEY is empty');
  return key;
}

// SECURITY-CRITICAL, pure (unit-tested): build a clean child env for the GLM child.
export function buildChildEnv(parentEnv, glmKey, configDir) {
  const env = { ...parentEnv };
  delete env.ANTHROPIC_API_KEY; // real Anthropic credential must NEVER reach z.ai
  env.ANTHROPIC_BASE_URL = Z_AI_BASE_URL;
  env.ANTHROPIC_AUTH_TOKEN = glmKey;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = GLM_BIG_MODEL;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = GLM_BIG_MODEL;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = GLM_SMALL_MODEL;
  env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '1000000';
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir; // fix S2: isolate from user ~/.claude settings
  return env;
}

// Kill the whole process tree (fix C1). With shell:true the direct child is the
// shell (cmd.exe on Windows) and `claude` is its grandchild; child.kill() would
// miss it, letting claude run on and keep consuming quota after a "timeout".
function killTree(pid) {
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' }); } catch {}
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
    setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} }, 5000);
  }
}

// Locate an executable on PATH (Windows honors PATHEXT). Lets us spawn the real
// binary WITHOUT shell:true — avoids the Node DEP0190 unescaped-args warning and
// the shell-quoting fragility (the R1 concern), while keeping tree-kill working.
function findExecutable(name) {
  if (process.platform !== 'win32') return name; // POSIX: spawn resolves PATH itself
  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';');
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of ['', ...exts]) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

// --- arg parsing (fixes C2/C3/R4): validates values, supports --flag=value ---
export function parseArgs(argv) {
  const mode = argv[0];
  if (!['review', 'research'].includes(mode)) {
    return { error: `unknown mode "${mode ?? ''}" (use review|research)` };
  }
  let cwd = null, maxDuration = DEFAULT_TIMEOUTS[mode];
  const unknown = [];
  for (let i = 1; i < argv.length; i++) {
    let a = argv[i], val = null;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq !== -1) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (a === '--cwd') {
      cwd = val ?? argv[++i];
      if (!cwd) return { error: '--cwd requires a path' };
    } else if (a === '--max-duration') {
      const n = Number.parseInt(val ?? argv[++i], 10);
      if (!Number.isFinite(n) || n <= 0) return { error: '--max-duration requires a positive integer (seconds)' };
      maxDuration = n;
    } else {
      unknown.push(argv[i]);
    }
  }
  return { mode, cwd, maxDuration, unknown };
}

// --- read prompt from stdin (fix R5): TTY guard + size cap + timeout ---
function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      return reject(new Error('expected the prompt on stdin — pipe it in: printf "%s" "..." | glm-delegate review'));
    }
    let data = '', bytes = 0, done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => finish(reject, new Error('timed out waiting for stdin')), STDIN_TIMEOUT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => {
      bytes += Buffer.byteLength(c, 'utf8');
      if (bytes > STDIN_MAX_BYTES) { try { process.stdin.destroy(); } catch {} return finish(reject, new Error('stdin exceeds max size')); }
      data += c;
    });
    process.stdin.on('end', () => finish(resolve, data));
    process.stdin.on('error', err => finish(reject, err));
  });
}

// --- spawn headless claude-on-GLM; prompt fed via stdin ---
function runGlm({ mode, cwd, prompt, maxDuration, configDir }) {
  return new Promise((resolve) => {
    const env = buildChildEnv(process.env, readGlmKey(), configDir);
    // All command-line args are simple, space-free literals; the untrusted,
    // space-bearing prompt goes via stdin (so shell:true is not an injection vector).
    const cliArgs = ['-p', '--model', 'opus', '--permission-mode', 'bypassPermissions',
                     '--allowedTools', MODE_TOOLS[mode]];
    // Spawn the real binary without a shell. On Windows, .cmd/.bat shims must run
    // via cmd.exe /c (Node refuses them directly); the child is then cmd.exe and
    // tree-kill (taskkill /T) reaps claude beneath it.
    const exe = findExecutable('claude');
    let command, spawnArgs, useShell = false;
    if (process.platform === 'win32' && exe && /\.(cmd|bat)$/i.test(exe)) {
      command = process.env.ComSpec || 'cmd.exe';
      spawnArgs = ['/d', '/s', '/c', exe, ...cliArgs];
    } else if (exe) {
      command = exe; spawnArgs = cliArgs;
    } else {
      command = 'claude'; spawnArgs = cliArgs; useShell = true; // last-resort fallback
    }
    const opts = { cwd: cwd || process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'], shell: useShell };
    if (process.platform !== 'win32') opts.detached = true; // own process group for tree-kill
    const child = spawn(command, spawnArgs, opts);

    let stdout = '', stderr = '', killed = null;
    const startedAt = Date.now();
    const timer = maxDuration > 0 ? setTimeout(() => {
      killed = 'timeout';
      killTree(child.pid);
    }, maxDuration * 1000) : null;

    child.stdout.on('data', d => { stdout += d; process.stdout.write(d); });
    child.stderr.on('data', d => { stderr += d; process.stderr.write(d); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, killed, elapsedMs: Date.now() - startedAt, stdout, stderr });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 1, killed, elapsedMs: Date.now() - startedAt, stdout, stderr: err.message });
    });

    child.stdin.on('error', () => {}); // fix R2: child may exit before reading stdin (EPIPE)
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(`[glm] ${parsed.error}`);
    console.error('Usage: printf "%s" "<prompt>" | glm-delegate <review|research> [--cwd <path>] [--max-duration <sec>]');
    process.exit(2);
  }
  if (parsed.unknown.length) console.error(`[glm] ignoring unknown args: ${parsed.unknown.join(' ')}`);

  const prompt = await readStdin();
  if (!prompt.trim()) { console.error('[glm] empty prompt on stdin'); process.exit(2); }

  // fix S2: isolate the child from the user's ~/.claude settings — prevents
  // settings.json `env` from re-injecting credentials, and keeps the delegate's
  // persona clean (no output-style / CLAUDE.md bleed).
  let configDir = null;
  try { configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-delegate-cfg-')); } catch { configDir = null; }

  try {
    const res = await runGlm({ ...parsed, prompt, configDir });
    process.stderr.write(`\n[glm] mode=${parsed.mode} exit=${res.code} killed=${res.killed || 'no'} ${Math.round(res.elapsedMs / 1000)}s\n`);
    process.exit(res.killed === 'timeout' ? 124 : res.code);
  } finally {
    if (configDir) { try { fs.rmSync(configDir, { recursive: true, force: true }); } catch {} }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(err => { console.error('[glm] Fatal:', err.message); process.exit(1); });
}
