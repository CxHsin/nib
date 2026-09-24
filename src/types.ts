export interface AppConfig {
  napcatWsUrl: string;
  napcatAccessToken?: string;
  groupIds: Set<string>;
  authorIds?: Set<string>; // Legacy configuration; collection no longer filters authors.
  ownerId?: string;
  groupNames: Record<string, string>;
  telegramBotToken: string;
  telegramChatId: string;
  deepseekApiKey: string;
  tinyfishApiKey?: string;
  modelId: string;
  dataDir: string;
  maxAgentToolCalls: number;
}

export interface ChatTurn {
  expiresAt?: number;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

export interface CapturedMessage {
  messageId: string;
  groupId: string;
  groupName: string;
  authorId: string;
  authorName: string;
  occurredAt: number;
  text: string;
  urls: string[];
}

export interface DigestWindow {
  start: number;
  end: number;
  hasCollectionGap: boolean;
}

export interface AgentDigestItem {
  summary: string;
  quoteMessageId: string;
  sourceMessageIds: string[];
  links: string[];
}

export interface AgentDigestResult {
  items: AgentDigestItem[];
  unreadableLinks: Array<{ url: string; sourceMessageIds: string[] }>;
}

export interface StoredDigest {
  id: number;
  windowStart: number;
  windowEnd: number;
  body: string;
}
