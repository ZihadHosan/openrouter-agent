import * as vscode from 'vscode';
import { AgentMode } from './agent';
import { AUTO_MODEL_ID } from './models';

export interface ToolDetailEntry {
  step: number;
  title: string;
  result: string;
}

export interface ChatSessionMessage {
  role: 'user' | 'assistant';
  content: string;
  details?: ToolDetailEntry[];
}

export interface SavedChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  mode: AgentMode;
  modelId: string;
  messages: ChatSessionMessage[];
}

export interface SessionListItem {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

const SESSIONS_KEY = 'openrouterAgent.sessions';
const ACTIVE_KEY = 'openrouterAgent.activeSessionId';
const MAX_SESSIONS = 50;

export class ChatHistoryStore {
  private sessions: SavedChatSession[] = [];
  private activeId = '';

  constructor(private readonly context: vscode.ExtensionContext) {
    this.load();
  }

  private load(): void {
    this.sessions = this.context.globalState.get<SavedChatSession[]>(SESSIONS_KEY, []);
    this.activeId = this.context.globalState.get<string>(ACTIVE_KEY, '');

    if (this.sessions.length === 0) {
      const session = this.createEmptySession();
      this.sessions = [session];
      this.activeId = session.id;
      void this.persist();
      return;
    }

    if (!this.sessions.some((s) => s.id === this.activeId)) {
      this.activeId = this.sessions[0].id;
      void this.persist();
    }
  }

  private async persist(): Promise<void> {
    await this.context.globalState.update(SESSIONS_KEY, this.sessions);
    await this.context.globalState.update(ACTIVE_KEY, this.activeId);
  }

  private createEmptySession(): SavedChatSession {
    const now = Date.now();
    return {
      id: `session-${now}-${Math.random().toString(36).slice(2, 9)}`,
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      mode: 'ask',
      modelId: AUTO_MODEL_ID,
      messages: [],
    };
  }

  getActiveId(): string {
    return this.activeId;
  }

  getActive(): SavedChatSession {
    const session = this.sessions.find((s) => s.id === this.activeId);
    if (!session) {
      const created = this.createEmptySession();
      this.sessions.unshift(created);
      this.activeId = created.id;
      void this.persist();
      return created;
    }
    return session;
  }

  listSessions(): SessionListItem[] {
    return [...this.sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      }));
  }

  async updateActive(data: {
    messages?: ChatSessionMessage[];
    mode?: AgentMode;
    modelId?: string;
    titleFromMessage?: string;
  }): Promise<void> {
    const session = this.getActive();
    if (data.messages !== undefined) {
      session.messages = data.messages;
    }
    if (data.mode !== undefined) {
      session.mode = data.mode;
    }
    if (data.modelId !== undefined) {
      session.modelId = data.modelId;
    }
    if (
      data.titleFromMessage &&
      (session.title === 'New chat' || session.messages.length <= 2)
    ) {
      const t = data.titleFromMessage.trim();
      session.title = t.length > 50 ? t.slice(0, 50) + '…' : t;
    }
    session.updatedAt = Date.now();
    await this.persist();
  }

  async switchSession(id: string): Promise<SavedChatSession | null> {
    const session = this.sessions.find((s) => s.id === id);
    if (!session) {
      return null;
    }
    this.activeId = id;
    await this.persist();
    return session;
  }

  async newSession(): Promise<SavedChatSession> {
    const session = this.createEmptySession();
    this.sessions.unshift(session);
    while (this.sessions.length > MAX_SESSIONS) {
      const removed = this.sessions.pop();
      if (removed?.id === this.activeId && this.sessions.length > 0) {
        this.activeId = this.sessions[0].id;
      }
    }
    this.activeId = session.id;
    await this.persist();
    return session;
  }

  async deleteSession(id: string): Promise<SavedChatSession> {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessions.length === 0) {
      const session = this.createEmptySession();
      this.sessions = [session];
      this.activeId = session.id;
      await this.persist();
      return session;
    }
    if (this.activeId === id) {
      this.activeId = this.sessions[0].id;
    }
    await this.persist();
    return this.getActive();
  }
}
