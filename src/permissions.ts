import * as vscode from 'vscode';
import type { ApprovalKind, PermissionChoice } from './approvalBridge';

/** How agent tools are approved before running (global default). */
export type AgentPermissionMode = 'ask' | 'readOnly' | 'workspace' | 'full';

const SETTING = 'agentPermissions';

/** Session memory — cleared when VS Code reloads. */
const sessionAlwaysCommands = new Set<string>();
let sessionAlwaysWrites = false;

export const PERMISSION_OPTIONS: {
  id: AgentPermissionMode;
  label: string;
  description: string;
}[] = [
  {
    id: 'ask',
    label: 'Ask every time',
    description: 'Confirm before file writes and terminal commands.',
  },
  {
    id: 'readOnly',
    label: 'Allow read-only tools',
    description: 'Auto-approve list/read files; ask before writes and commands.',
  },
  {
    id: 'workspace',
    label: 'Allow file changes',
    description: 'Auto-approve reads and file writes; ask before terminal commands.',
  },
  {
    id: 'full',
    label: 'Allow safe commands',
    description:
      'Auto-approve reads, writes, and non-destructive commands. Destructive commands always ask.',
  },
];

export const INLINE_PERMISSION_OPTIONS: {
  id: PermissionChoice;
  label: string;
}[] = [
  { id: 'once', label: 'Run this time only' },
  { id: 'always', label: 'Always allow' },
  { id: 'skip', label: 'Skip' },
];

function normalizeCommandKey(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

export function getAgentPermissionMode(): AgentPermissionMode {
  return vscode.workspace
    .getConfiguration('openrouterAgent')
    .get<AgentPermissionMode>(SETTING, 'ask');
}

export async function setAgentPermissionMode(mode: AgentPermissionMode): Promise<void> {
  await vscode.workspace
    .getConfiguration('openrouterAgent')
    .update(SETTING, mode, vscode.ConfigurationTarget.Global);
}

export function shouldAutoApproveWrite(): boolean {
  if (sessionAlwaysWrites) {
    return true;
  }
  const mode = getAgentPermissionMode();
  return mode === 'workspace' || mode === 'full';
}

export function shouldAutoApproveCommand(command: string, isDestructive: boolean): boolean {
  if (isDestructive) {
    return false;
  }
  if (sessionAlwaysCommands.has(normalizeCommandKey(command))) {
    return true;
  }
  return getAgentPermissionMode() === 'full';
}

export function rememberApproval(
  kind: ApprovalKind,
  choice: PermissionChoice,
  command?: string,
  destructive?: boolean
): void {
  if (choice !== 'always') {
    return;
  }
  if (kind === 'run_command' && command && !destructive) {
    sessionAlwaysCommands.add(normalizeCommandKey(command));
    return;
  }
  if (kind === 'propose_write_file') {
    sessionAlwaysWrites = true;
  }
}

export function clearSessionApprovals(): void {
  sessionAlwaysCommands.clear();
  sessionAlwaysWrites = false;
}

export function permissionModeLabel(mode?: AgentPermissionMode): string {
  const id = mode ?? getAgentPermissionMode();
  return PERMISSION_OPTIONS.find((o) => o.id === id)?.label ?? id;
}

export async function promptPermissionMode(): Promise<void> {
  const current = getAgentPermissionMode();
  const picked = await vscode.window.showQuickPick(
    PERMISSION_OPTIONS.map((o) => ({
      label: o.id === current ? `$(check) ${o.label}` : o.label,
      description: o.description,
      mode: o.id,
    })),
    {
      title: 'OpenRouter Agent Permissions',
      placeHolder: 'Choose when tools run without asking',
    }
  );
  if (!picked) {
    return;
  }
  await setAgentPermissionMode(picked.mode);
  void vscode.window.showInformationMessage(
    `OpenRouter Agent: Permissions set to "${permissionModeLabel(picked.mode)}".`
  );
}
