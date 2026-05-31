import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const MAX_OUTPUT_CHARS = 48_000;
const COMMAND_TIMEOUT_MS = 120_000;
const BACKGROUND_INITIAL_MS = 8_000;

const BACKGROUND_PATTERNS = [
  /\bnpm run dev\b/i,
  /\bnpm start\b/i,
  /\bnpm run watch\b/i,
  /\byarn dev\b/i,
  /\bpnpm dev\b/i,
  /\bpnpm start\b/i,
  /\bnext dev\b/i,
  /\bvite\b/i,
  /\bng serve\b/i,
  /\bflutter run\b/i,
  /\bdocker compose up\b/i,
  /\bdocker-compose up\b/i,
];

export interface TerminalRunResult {
  runId: string;
  command: string;
  cwd: string;
  shell: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  combinedOutput: string;
  background?: boolean;
  /** True when a background process is still running after the initial capture window. */
  running?: boolean;
  success: boolean;
  fallbacksAttempted?: string[];
}

export interface TerminalRunStartInfo {
  runId: string;
  command: string;
  cwd: string;
  shell: string;
  background: boolean;
}

export interface TerminalRunCallbacks {
  onStart?: (info: TerminalRunStartInfo) => void;
  onOutput?: (info: {
    runId: string;
    stdout: string;
    stderr: string;
    combinedOutput: string;
  }) => void;
  onComplete?: (result: TerminalRunResult) => void;
}

export interface TerminalRunOptions {
  background?: boolean;
  runId?: string;
}

interface ShellSpec {
  label: string;
  executable: string;
  args: string[];
}

function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function isBackgroundCommand(command: string): boolean {
  return BACKGROUND_PATTERNS.some((p) => p.test(command.trim()));
}

function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max) + '\n… [output truncated]';
}

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path';
}

function exists(exe: string): boolean {
  if (!exe) {
    return false;
  }
  if (exe.includes('/') || exe.includes('\\')) {
    return fs.existsSync(exe);
  }
  return false;
}

function validateCwd(cwd: string): string | null {
  const resolved = path.resolve(cwd);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      return `Working directory is not a folder: ${resolved}`;
    }
  } catch {
    return `Working directory does not exist: ${resolved}`;
  }
  return null;
}

function resolveCmdExe(env: NodeJS.ProcessEnv): string | undefined {
  const systemRoot = env.SystemRoot || process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    env.ComSpec,
    process.env.ComSpec,
    path.join(systemRoot, 'System32', 'cmd.exe'),
    'C:\\Windows\\System32\\cmd.exe',
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Shell paths from VS Code terminal profile settings. */
function getIntegratedTerminalShell(): string | undefined {
  if (process.platform === 'win32') {
    const config = vscode.workspace.getConfiguration('terminal.integrated');
    const defaultProfile = config.get<string>('defaultProfile.windows');
    const profiles = config.get<Record<string, { path?: string; source?: string }>>(
      'profiles.windows'
    );
    if (defaultProfile && profiles?.[defaultProfile]?.path) {
      const shellPath = profiles[defaultProfile].path!.trim();
      if (fs.existsSync(shellPath)) {
        return shellPath;
      }
    }
  } else if (process.platform === 'darwin') {
    const config = vscode.workspace.getConfiguration('terminal.integrated');
    const defaultProfile = config.get<string>('defaultProfile.osx');
    const profiles = config.get<Record<string, { path?: string }>>('profiles.osx');
    if (defaultProfile && profiles?.[defaultProfile]?.path) {
      const shellPath = profiles[defaultProfile].path!.trim();
      if (fs.existsSync(shellPath)) {
        return shellPath;
      }
    }
  } else {
    const config = vscode.workspace.getConfiguration('terminal.integrated');
    const defaultProfile = config.get<string>('defaultProfile.linux');
    const profiles = config.get<Record<string, { path?: string }>>('profiles.linux');
    if (defaultProfile && profiles?.[defaultProfile]?.path) {
      const shellPath = profiles[defaultProfile].path!.trim();
      if (fs.existsSync(shellPath)) {
        return shellPath;
      }
    }
  }
  return undefined;
}

/** Extension host often has a stripped PATH — restore essentials. */
function buildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  if (process.platform !== 'win32') {
    return env;
  }

  const systemRoot = env.SystemRoot || 'C:\\Windows';
  const extras = [
    path.join(systemRoot, 'System32'),
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
    path.join(systemRoot, 'System32', 'Wbem'),
    env.ProgramFiles ? path.join(env.ProgramFiles, 'PowerShell', '7') : '',
    env.ProgramFiles ? path.join(env.ProgramFiles, 'Git', 'bin') : '',
    env.ProgramFiles ? path.join(env.ProgramFiles, 'Git', 'usr', 'bin') : '',
    env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], 'Git', 'bin') : '',
    env.ProgramFiles ? path.join(env.ProgramFiles, 'nodejs') : '',
    env['ProgramFiles(x86)'] ? path.join(env['ProgramFiles(x86)'], 'nodejs') : '',
    env.APPDATA ? path.join(env.APPDATA, 'npm') : '',
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin') : '',
  ].filter(Boolean);

  const key = pathKey(env);
  const parts = (env[key] || '').split(path.delimiter).filter(Boolean);
  const seen = new Set(parts.map((p) => p.toLowerCase()));

  for (const segment of extras) {
    if (!segment || seen.has(segment.toLowerCase())) {
      continue;
    }
    if (fs.existsSync(segment)) {
      parts.unshift(segment);
      seen.add(segment.toLowerCase());
    }
  }

  env[key] = parts.join(path.delimiter);

  const cmdPath = path.join(systemRoot, 'System32', 'cmd.exe');
  const resolvedCmd = resolveCmdExe(env);
  if (resolvedCmd) {
    env.ComSpec = resolvedCmd;
  } else if (!env.ComSpec && fs.existsSync(cmdPath)) {
    env.ComSpec = cmdPath;
  }

  return env;
}

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const key = pathKey(env);
  const dirs = (env[key] || '').split(path.delimiter).filter(Boolean);
  const names =
    process.platform === 'win32' && !name.toLowerCase().endsWith('.exe')
      ? [name, `${name}.exe`]
      : [name];

  for (const dir of dirs) {
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      if (fs.existsSync(full)) {
        return full;
      }
    }
  }
  return undefined;
}

function buildSpawnArgs(shellPath: string, command: string): string[] {
  const lower = shellPath.toLowerCase();

  if (lower.includes('powershell') || lower.includes('pwsh')) {
    return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command];
  }

  if (lower.includes('cmd.exe') || lower.endsWith('\\cmd')) {
    return ['/d', '/s', '/c', command];
  }

  if (lower.includes('wsl.exe')) {
    return ['bash', '-lc', command];
  }

  return ['-lc', command];
}

function specFromExe(label: string, executable: string, command: string): ShellSpec | null {
  if (!executable || !exists(executable)) {
    return null;
  }
  return {
    label,
    executable,
    args: buildSpawnArgs(executable, command),
  };
}

function uniqueSpecs(specs: (ShellSpec | null)[]): ShellSpec[] {
  const out: ShellSpec[] = [];
  const seen = new Set<string>();
  for (const s of specs) {
    if (!s) {
      continue;
    }
    const key = s.executable.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(s);
  }
  return out;
}

function windowsShellCandidates(command: string, env: NodeJS.ProcessEnv): ShellSpec[] {
  const systemRoot = env.SystemRoot || process.env.SystemRoot || 'C:\\Windows';
  const pf = env.ProgramFiles || process.env.ProgramFiles || 'C:\\Program Files';
  const pfx86 = env['ProgramFiles(x86)'] || process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const cmdExe = resolveCmdExe(env);

  return uniqueSpecs([
    cmdExe ? specFromExe('cmd', cmdExe, command) : null,
    specFromExe('pwsh', path.join(pf, 'PowerShell', '7', 'pwsh.exe'), command),
    specFromExe('pwsh', path.join(pfx86, 'PowerShell', '7', 'pwsh.exe'), command),
    specFromExe(
      'powershell',
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      command
    ),
    specFromExe('git-bash', path.join(pf, 'Git', 'bin', 'bash.exe'), command),
    specFromExe('git-bash', path.join(pf, 'Git', 'usr', 'bin', 'bash.exe'), command),
    specFromExe('git-bash', path.join(pfx86, 'Git', 'bin', 'bash.exe'), command),
    specFromExe('bash', findOnPath('bash', env) || '', command),
    specFromExe('sh', findOnPath('sh', env) || '', command),
    specFromExe('wsl', path.join(systemRoot, 'System32', 'wsl.exe'), command),
  ]);
}

function unixShellCandidates(command: string): ShellSpec[] {
  return uniqueSpecs([
    specFromExe('bash', process.env.SHELL || '', command),
    specFromExe('bash', '/bin/bash', command),
    specFromExe('zsh', '/bin/zsh', command),
    specFromExe('sh', '/bin/sh', command),
    specFromExe('bash', '/usr/bin/bash', command),
    specFromExe('zsh', '/usr/bin/zsh', command),
    specFromExe('sh', '/usr/bin/sh', command),
    specFromExe('fish', '/usr/bin/fish', command),
    specFromExe('bash', 'bash', command),
    specFromExe('sh', 'sh', command),
  ]);
}

/** Ordered shell list: user override → VS Code default → platform fallbacks → user extras. */
export function resolveShellCandidates(command: string, env?: NodeJS.ProcessEnv): ShellSpec[] {
  const runEnv = env ?? buildEnv();
  const cfg = vscode.workspace.getConfiguration('openrouterAgent');
  const override = cfg.get<string>('shell', '').trim();
  const extraFallbacks = cfg.get<string[]>('shellFallbacks', []).filter(Boolean);

  const specs: ShellSpec[] = [];

  if (override) {
    const s = specFromExe('user-shell', override, command);
    if (s) {
      specs.push(s);
    }
  }

  const vscodeShell = vscode.env.shell?.trim();
  if (vscodeShell) {
    const s = specFromExe('vscode-default', vscodeShell, command);
    if (s) {
      specs.push(s);
    }
  }

  const integratedShell = getIntegratedTerminalShell();
  if (integratedShell) {
    const s = specFromExe('integrated-terminal', integratedShell, command);
    if (s) {
      specs.push(s);
    }
  }

  specs.push(
    ...(process.platform === 'win32'
      ? windowsShellCandidates(command, runEnv)
      : unixShellCandidates(command))
  );

  for (const fb of extraFallbacks) {
    const s = specFromExe('custom-fallback', fb.trim(), command);
    if (s) {
      specs.push(s);
    }
  }

  return uniqueSpecs(specs);
}

export function resolveShellExecutable(): string {
  const candidates = resolveShellCandidates('echo ok');
  return candidates[0]?.executable ?? (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
}

function finishResult(
  runId: string,
  command: string,
  cwd: string,
  shell: string,
  stdout: string,
  stderr: string,
  exitCode: number,
  timedOut: boolean,
  extra?: Partial<Pick<TerminalRunResult, 'background' | 'running' | 'fallbacksAttempted'>>
): TerminalRunResult {
  const out = truncate(stdout);
  const err = truncate(stderr);
  const combined =
    [out, err].filter(Boolean).join(out && err ? '\n' : '') ||
    (timedOut ? '(command timed out)' : '(no output)');

  const running = extra?.running ?? false;
  const success = running || (exitCode === 0 && !timedOut);

  return {
    runId,
    command,
    cwd,
    shell,
    stdout: out,
    stderr: err,
    exitCode,
    timedOut,
    combinedOutput: combined,
    success,
    ...extra,
  };
}

function emitOutput(
  callbacks: TerminalRunCallbacks | undefined,
  runId: string,
  stdout: string,
  stderr: string
): void {
  callbacks?.onOutput?.({
    runId,
    stdout: truncate(stdout),
    stderr: truncate(stderr),
    combinedOutput: truncate([stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n' : '')),
  });
}

function runProcess(
  proc: ChildProcess,
  meta: {
    runId: string;
    command: string;
    cwd: string;
    shellDisplay: string;
    background: boolean;
    callbacks?: TerminalRunCallbacks;
  }
): Promise<TerminalRunResult | null> {
  const { runId, command, cwd, shellDisplay, background, callbacks } = meta;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnFailed = false;
    let agentResolved = false;
    let backgroundReported = false;

    callbacks?.onStart?.({ runId, command, cwd, shell: shellDisplay, background });

    const timer = background
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, COMMAND_TIMEOUT_MS);

    const initialTimer = background
      ? setTimeout(() => {
          if (spawnFailed || agentResolved) {
            return;
          }
          if (proc.exitCode !== null) {
            return;
          }
          const partial = finishResult(
            runId,
            command,
            cwd,
            shellDisplay,
            stdout,
            stderr,
            0,
            false,
            { background: true, running: true }
          );
          callbacks?.onComplete?.(partial);
          backgroundReported = true;
          agentResolved = true;
          resolve(partial);
        }, BACKGROUND_INITIAL_MS)
      : undefined;

    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');

    proc.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_CHARS * 2) {
        stdout = stdout.slice(0, MAX_OUTPUT_CHARS * 2);
      }
      emitOutput(callbacks, runId, stdout, stderr);
    });

    proc.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > MAX_OUTPUT_CHARS * 2) {
        stderr = stderr.slice(0, MAX_OUTPUT_CHARS * 2);
      }
      emitOutput(callbacks, runId, stdout, stderr);
    });

    proc.on('error', (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (initialTimer) {
        clearTimeout(initialTimer);
      }
      spawnFailed = true;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const cwdErr = validateCwd(cwd);
        if (cwdErr) {
          const result = finishResult(
            runId,
            command,
            cwd,
            shellDisplay,
            stdout,
            cwdErr,
            1,
            timedOut,
            { background }
          );
          callbacks?.onComplete?.(result);
          if (!agentResolved) {
            agentResolved = true;
            resolve(result);
          }
          return;
        }
        resolve(null);
        return;
      }
      const result = finishResult(
        runId,
        command,
        cwd,
        shellDisplay,
        stdout,
        `${stderr}${stderr ? '\n' : ''}Shell error: ${err.message}`,
        1,
        timedOut,
        { background }
      );
      callbacks?.onComplete?.(result);
      if (!agentResolved) {
        agentResolved = true;
        resolve(result);
      }
    });

    proc.on('close', (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (initialTimer) {
        clearTimeout(initialTimer);
      }
      if (spawnFailed) {
        return;
      }

      const exitCode = code ?? 1;
      const result = finishResult(
        runId,
        command,
        cwd,
        shellDisplay,
        stdout,
        stderr,
        exitCode,
        timedOut,
        { background, running: false }
      );

      if (background) {
        if (backgroundReported) {
          callbacks?.onComplete?.(result);
          return;
        }
        callbacks?.onComplete?.(result);
        if (!agentResolved) {
          agentResolved = true;
          resolve(result);
        }
        return;
      }

      callbacks?.onComplete?.(result);
      resolve(result);
    });
  });
}

function runWithShell(
  spec: ShellSpec,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  callbacks: TerminalRunCallbacks | undefined,
  options: TerminalRunOptions
): Promise<TerminalRunResult | null> {
  const runId = options.runId ?? generateRunId();
  const background = options.background ?? false;
  const shellDisplay = `${spec.label} (${spec.executable})`;

  const proc = spawn(spec.executable, spec.args, {
    cwd,
    env,
    windowsHide: true,
    detached: background,
  });

  if (background && proc.pid) {
    proc.unref();
  }

  return runProcess(proc, {
    runId,
    command,
    cwd,
    shellDisplay,
    background,
    callbacks,
  });
}

function runWithSystemShell(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  callbacks: TerminalRunCallbacks | undefined,
  options: TerminalRunOptions
): Promise<TerminalRunResult | null> {
  const runId = options.runId ?? generateRunId();
  const background = options.background ?? false;
  const cmdExe = resolveCmdExe(env);
  const shellDisplay = cmdExe ? `system (${cmdExe})` : 'system (shell:true)';

  const proc = spawn(command, {
    cwd,
    env,
    shell: cmdExe || true,
    windowsHide: true,
    detached: background,
  });

  if (background && proc.pid) {
    proc.unref();
  }

  return runProcess(proc, {
    runId,
    command,
    cwd,
    shellDisplay,
    background,
    callbacks,
  });
}

export async function runCommandInWorkspace(
  command: string,
  cwd: string,
  callbacks?: TerminalRunCallbacks,
  options?: TerminalRunOptions
): Promise<TerminalRunResult> {
  const env = buildEnv();
  const resolvedCwd = path.resolve(cwd);
  const runId = options?.runId ?? generateRunId();
  const runOptions: TerminalRunOptions = { ...options, runId };

  const cwdError = validateCwd(resolvedCwd);
  if (cwdError) {
    const failure = finishResult(runId, command, resolvedCwd, 'none', '', cwdError, 1, false);
    callbacks?.onStart?.({
      runId,
      command,
      cwd: resolvedCwd,
      shell: 'none',
      background: options?.background ?? false,
    });
    callbacks?.onComplete?.(failure);
    return failure;
  }

  const candidates = resolveShellCandidates(command, env);
  const attempted: string[] = [];

  for (const spec of candidates) {
    const result = await runWithShell(spec, command, resolvedCwd, env, callbacks, runOptions);
    if (result) {
      if (attempted.length > 0) {
        result.fallbacksAttempted = [...attempted];
      }
      return result;
    }
    attempted.push(`${spec.label}: ${spec.executable}`);
  }

  const systemResult = await runWithSystemShell(command, resolvedCwd, env, callbacks, runOptions);
  if (systemResult) {
    if (attempted.length > 0) {
      systemResult.fallbacksAttempted = [...attempted, 'system-shell (shell:true)'];
    }
    return systemResult;
  }
  attempted.push('system-shell (shell:true)');

  const tried =
    attempted.length > 0
      ? attempted.join('\n')
      : 'No shell candidates were available.';

  const failure = finishResult(
    runId,
    command,
    resolvedCwd,
    'none',
    '',
    `All shell fallbacks failed to start.\n${tried}\n\nTip: set openrouterAgent.shell to e.g. C:\\\\Windows\\\\System32\\\\cmd.exe`,
    1,
    false,
    { fallbacksAttempted: attempted }
  );
  callbacks?.onStart?.({
    runId,
    command,
    cwd: resolvedCwd,
    shell: 'none',
    background: options?.background ?? false,
  });
  callbacks?.onComplete?.(failure);
  return failure;
}

export function formatTerminalResultForAgent(result: TerminalRunResult): string {
  return JSON.stringify(
    {
      success: result.success,
      running: result.running ?? false,
      background: result.background ?? false,
      command: result.command,
      cwd: result.cwd,
      shell: result.shell,
      runId: result.runId,
      fallbacksAttempted: result.fallbacksAttempted,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr,
      output: result.combinedOutput,
      message: result.running
        ? 'Command started in background. Initial output captured; process keeps running.'
        : result.success
          ? 'Command completed successfully.'
          : 'Command failed.',
    },
    null,
    2
  );
}

export function getShellDescription(): string {
  const candidates = resolveShellCandidates('echo ok');
  if (candidates.length === 0) {
    return `${resolveShellExecutable()} → system (shell:true)`;
  }
  return `${candidates.map((c) => c.executable).join(' → ')} → system (shell:true)`;
}
