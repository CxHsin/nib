import { getModels } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Store } from "./store.js";
import type { WebReader } from "./web-reader.js";
import type { AgentDigestResult, CapturedMessage, DigestWindow } from "./types.js";
import { formatShanghai } from "./time.js";

const SYSTEM_PROMPT = `你是 nib 的群聊晚报整理 agent。

你的目标是从程序限定的候选消息中找出与以下主题有关、值得用户阅读的内容：
1. agent 开发；
2. AI 产品发布与体验、产品设计、用户需求、商业化案例。

普通闲聊、普通购物推荐、广告不收录。你必须先调用 list_digest_messages 查看候选消息。需要理解链接内容时，按需调用 read_link；它只允许读取候选消息直接包含的公开链接。不要假装读过失败的网页，也不要追踪网页内的二级链接。

将相同链接或同一事件的消息合并。最终只输出一个 JSON 对象，不加 Markdown 代码块或解释：
{"items":[{"summary":"简洁的中文主题摘要","quoteMessageId":"作为关键原话的消息ID","sourceMessageIds":["相关消息ID"],"links":["直接链接"]}],"unreadableLinks":[{"url":"无法读取且仅凭消息不能判断主题的纯链接","sourceMessageIds":["消息ID"]}]}

约束：关键原话由程序根据 quoteMessageId 引用，不能编造；所有消息 ID 和链接必须来自工具结果；没有命中时 items 为空。`;

export function resourceLoader(systemPrompt = SYSTEM_PROMPT): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export function toolText(value: unknown): { content: Array<{ type: "text"; text: string }>; details: Record<string, never> } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: {} };
}

export function assistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block): block is { type: "text"; text: string } => (
      Boolean(block) && typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ))
    .map((block) => block.text)
    .join("");
  return text || undefined;
}

function extractJson(text: string): unknown {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("agent 未返回 JSON 对象");
  return JSON.parse(text.slice(first, last + 1));
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} 必须是字符串数组`);
  }
  return [...new Set(value)];
}

export function validateAgentResult(value: unknown, messages: CapturedMessage[]): AgentDigestResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("结果必须是对象");
  const raw = value as { items?: unknown; unreadableLinks?: unknown };
  if (!Array.isArray(raw.items) || !Array.isArray(raw.unreadableLinks)) {
    throw new Error("结果缺少 items 或 unreadableLinks 数组");
  }
  const byId = new Map(messages.map((message) => [message.messageId, message]));
  const seenLinks = new Set<string>();
  const items = raw.items.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`items[${index}] 必须是对象`);
    const item = entry as Record<string, unknown>;
    if (typeof item.summary !== "string" || !item.summary.trim() || item.summary.length > 500) {
      throw new Error(`items[${index}].summary 无效`);
    }
    if (typeof item.quoteMessageId !== "string" || !byId.has(item.quoteMessageId)) {
      throw new Error(`items[${index}].quoteMessageId 不属于候选消息`);
    }
    const sourceMessageIds = stringArray(item.sourceMessageIds, `items[${index}].sourceMessageIds`);
    if (sourceMessageIds.length === 0 || sourceMessageIds.some((id) => !byId.has(id))) {
      throw new Error(`items[${index}] 包含未知消息 ID`);
    }
    if (!sourceMessageIds.includes(item.quoteMessageId)) throw new Error(`items[${index}] 的关键原话不在来源内`);
    const allowedLinks = new Set(sourceMessageIds.flatMap((id) => byId.get(id)?.urls ?? []));
    const links = stringArray(item.links, `items[${index}].links`);
    if (links.some((link) => !allowedLinks.has(link))) throw new Error(`items[${index}] 包含非来源链接`);
    if (links.some((link) => seenLinks.has(link))) throw new Error("同一链接被多个条目重复收录");
    links.forEach((link) => seenLinks.add(link));
    return {
      summary: item.summary.trim(),
      quoteMessageId: item.quoteMessageId,
      sourceMessageIds,
      links,
    };
  });
  const unreadableLinks = raw.unreadableLinks.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`unreadableLinks[${index}] 必须是对象`);
    }
    const item = entry as Record<string, unknown>;
    const sourceMessageIds = stringArray(item.sourceMessageIds, `unreadableLinks[${index}].sourceMessageIds`);
    if (typeof item.url !== "string" || sourceMessageIds.length === 0 || sourceMessageIds.some((id) => !byId.has(id))) {
      throw new Error(`unreadableLinks[${index}] 无效`);
    }
    const allowed = sourceMessageIds.some((id) => byId.get(id)?.urls.includes(item.url as string));
    if (!allowed) throw new Error(`unreadableLinks[${index}] 包含非来源链接`);
    return { url: item.url, sourceMessageIds };
  });
  return { items, unreadableLinks };
}

export interface DigestAgentOptions {
  store: Store;
  webReader: WebReader;
  window: DigestWindow;
  apiKey: string;
  modelId: string;
  maxToolCalls: number;
}

export async function runDigestAgent(options: DigestAgentOptions): Promise<AgentDigestResult> {
  const messages = options.store.listMessages(options.window.start, options.window.end);
  if (messages.length === 0) return { items: [], unreadableLinks: [] };
  const allowedUrls = new Set(messages.flatMap((message) => message.urls));
  let toolCalls = 0;
  let listedMessages = false;
  const countToolCall = (): void => {
    toolCalls += 1;
    if (toolCalls > options.maxToolCalls) throw new Error(`工具调用超过上限 ${options.maxToolCalls}`);
  };

  const listTool = defineTool({
    name: "list_digest_messages",
    label: "读取本期候选消息",
    description: "读取程序已按群号和时间窗口筛选的本期群消息。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      countToolCall();
      listedMessages = true;
      return toolText(messages.map((message) => ({
        messageId: message.messageId,
        group: message.groupName,
        author: `${message.authorName} (${message.authorId})`,
        time: formatShanghai(message.occurredAt),
        text: message.text,
        urls: message.urls,
      })));
    },
  });
  const readLinkTool = defineTool({
    name: "read_link",
    label: "读取消息中的公开网页",
    description: "读取候选消息直接包含的一个公开网页链接。不会登录或读取音视频。",
    parameters: Type.Object({ url: Type.String() }, { additionalProperties: false }),
    execute: async (_id, { url }) => {
      countToolCall();
      if (!listedMessages) throw new Error("必须先读取本期候选消息");
      if (!allowedUrls.has(url)) throw new Error("该链接不属于本期候选消息");
      const result = await options.webReader.read(url);
      return toolText(result.ok
        ? { ok: true, url, title: result.title, content: result.content }
        : { ok: false, url, error: result.error });
    },
  });

  const model = getModels("deepseek").find((candidate) => candidate.id === options.modelId);
  if (!model) throw new Error(`pi 未找到模型 deepseek/${options.modelId}`);
  const modelRuntime = await ModelRuntime.create();
  await modelRuntime.setRuntimeApiKey("deepseek", options.apiKey);
  const { session } = await createAgentSession({
    model,
    thinkingLevel: "low",
    modelRuntime,
    resourceLoader: resourceLoader(),
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    }),
    noTools: "builtin",
    customTools: [listTool, readLinkTool],
  });

  try {
    await session.prompt(
      `整理 ${formatShanghai(options.window.start)} 到 ${formatShanghai(options.window.end)} 的晚报。` +
      "先查看候选消息，再自主决定是否读取其中链接。",
    );
    for (let correction = 0; correction < 2; correction += 1) {
      const text = [...session.state.messages].reverse().map(assistantText).find(Boolean);
      if (!text) throw new Error(session.state.errorMessage || "agent 没有返回最终文本");
      try {
        return validateAgentResult(extractJson(text), messages);
      } catch (error) {
        if (correction === 1) throw error;
        await session.prompt(
          `上一个结果未通过程序校验：${error instanceof Error ? error.message : String(error)}。` +
          "请只输出修正后的 JSON，不要编造来源。",
        );
      }
    }
    throw new Error("agent 输出校验失败");
  } finally {
    session.dispose();
  }
}
