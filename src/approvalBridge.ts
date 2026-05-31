export type PermissionChoice = 'once' | 'always' | 'skip';

export type ApprovalKind = 'run_command' | 'propose_write_file';

export interface ApprovalRequest {
  kind: ApprovalKind;
  title: string;
  detail: string;
  command?: string;
  path?: string;
  destructive?: boolean;
}

export interface ApprovalRequestMessage extends ApprovalRequest {
  id: string;
}

type NotifyFn = (message: unknown) => void;

export class ApprovalBridge {
  private pending = new Map<string, (choice: PermissionChoice) => void>();

  constructor(private readonly notify: NotifyFn) {}

  request(req: ApprovalRequest): Promise<PermissionChoice> {
    const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.notify({ type: 'toolApproval', id, ...req });
      this.notify({ type: 'approvalPending', pending: true });
    });
  }

  respond(id: string, choice: PermissionChoice): void {
    const resolve = this.pending.get(id);
    if (!resolve) {
      return;
    }
    resolve(choice);
    this.pending.delete(id);
    if (this.pending.size === 0) {
      this.notify({ type: 'approvalPending', pending: false });
    }
  }

  cancelAll(): void {
    for (const resolve of this.pending.values()) {
      resolve('skip');
    }
    this.pending.clear();
    this.notify({ type: 'approvalPending', pending: false });
  }
}
