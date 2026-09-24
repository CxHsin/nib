import path from "node:path";
import type { AppConfig } from "./types.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function idSet(name: string): Set<string> {
  const values = required(name).split(",").map((value) => value.trim()).filter(Boolean);
  if (values.some((value) => !/^\d+$/.test(value))) {
    throw new Error(`${name} 只能包含以逗号分隔的数字 ID`);
  }
  return new Set(values);
}

function groupNames(): Record<string, string> {
  const raw = process.env.QQ_GROUP_NAMES?.trim();
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("QQ_GROUP_NAMES 必须是 JSON 对象");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => {
      if (!/^\d+$/.test(key) || typeof value !== "string") {
        throw new Error("QQ_GROUP_NAMES 的键必须是群号，值必须是群名");
      }
      return [key, value];
    }),
  );
}

export function loadConfig(): AppConfig {
  const ownerId = process.env.QQ_OWNER_ID?.trim();
  if (ownerId && !/^\d+$/.test(ownerId)) throw new Error("QQ_OWNER_ID 必须是单个数字 QQ 号");
  const accessToken = process.env.NAPCAT_ACCESS_TOKEN?.trim();
  const maxAgentToolCalls = Number(process.env.MAX_AGENT_TOOL_CALLS ?? "20");
  if (!Number.isInteger(maxAgentToolCalls) || maxAgentToolCalls < 1 || maxAgentToolCalls > 100) {
    throw new Error("MAX_AGENT_TOOL_CALLS 必须是 1 到 100 的整数");
  }

  return {
    napcatWsUrl: required("NAPCAT_WS_URL"),
    ...(accessToken ? { napcatAccessToken: accessToken } : {}),
    groupIds: idSet("QQ_GROUP_IDS"),
    ...(ownerId ? { ownerId } : {}),
    groupNames: groupNames(),
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    telegramChatId: required("TELEGRAM_CHAT_ID"),
    deepseekApiKey: required("DEEPSEEK_API_KEY"),
    ...(process.env.TINYFISH_API_KEY?.trim() ? { tinyfishApiKey: process.env.TINYFISH_API_KEY.trim() } : {}),
    modelId: process.env.PI_MODEL?.trim() || "deepseek-v4-pro",
    dataDir: path.resolve(process.env.DATA_DIR?.trim() || "data"),
    maxAgentToolCalls,
  };
}
