import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { ConversationView, ModelRef } from '@earendil-works/pi-durable';

// Plain presentation values. No Harness/Conversation/ExecutionEnv crosses this boundary.
export interface SessionSummary {
  id: number;
  name: string;
  createdAt: number;
}

export interface ModelSummary extends ModelRef {
  name: string;
  thinkingLevels: readonly ModelThinkingLevel[];
}

export interface AuthSummary {
  provider: 'openai';
  connected: boolean;
  status: 'idle' | 'pending' | 'done' | 'cancelled' | 'timeout' | 'error';
  revision: number;
}

export interface GitHubSummary {
  connected: boolean;
  user: string | null;
  status: 'idle' | 'verifying' | 'done' | 'error';
  revision: number;
}

export interface AppView {
  instanceId: string;
  revision: number;
  demo: boolean;
  auth?: AuthSummary;
  github?: GitHubSummary;
  activeId: number;
  sessions: readonly SessionSummary[];
  models: readonly ModelSummary[];
  conversation: ConversationView;
}

export type Action =
  | {
      type: 'input';
      conversationId: number;
      text: string;
      mode: 'steer' | 'followUp' | 'reject';
    }
  | { type: 'abort'; conversationId: number }
  | { type: 'model'; conversationId: number; model: ModelRef }
  | { type: 'thinking'; conversationId: number; level: ModelThinkingLevel }
  | { type: 'compact'; conversationId: number; instructions?: string }
  | { type: 'clear'; conversationId: number; confirmation?: string }
  | { type: 'new'; conversationId: number; name?: string }
  | { type: 'select'; conversationId: number }
  | { type: 'rename'; conversationId: number; name: string }
  | { type: 'fork'; conversationId: number; entryId: number; name?: string }
  | { type: 'cancelQueued'; conversationId: number; submissionId: number };

export type ActionResult =
  | { kind: 'done' }
  | { kind: 'accepted'; operationId: number }
  | {
      kind: 'dialog';
      dialog: 'models' | 'thinking' | 'sessions' | 'help' | 'auth' | 'github' | 'settings';
    }
  | { kind: 'confirmation'; conversationId: number; token: string; message: string };

export interface AppController {
  snapshot(): Promise<AppView>;
  execute(action: Action): Promise<ActionResult>;

  // Callback only signals invalidation; callers read a fresh durable view afterwards.
  subscribe(listener: () => void): () => void;

  close(): Promise<void>;
}
