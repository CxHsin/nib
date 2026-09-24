import dns from "node:dns/promises";
import net from "node:net";
import { htmlToText } from "html-to-text";
import type { LinkCacheEntry, Store } from "./store.js";
import { RETENTION_MS } from "./time.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const parts = address.split(".").map(Number);
    const first = parts[0] ?? 0;
    const second = parts[1] ?? 0;
    return first === 0 || first === 10 || first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) || first >= 224;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === "::" || normalized === "::1" ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb") ||
      normalized.startsWith("ff") || normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
  }
  return true;
}

async function validatePublicUrl(rawUrl: string): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("只允许读取 HTTP/HTTPS 链接");
  }
  if (url.username || url.password) throw new Error("链接不能包含账号信息");
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new Error("链接端口不在允许范围内");
  }
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("链接指向本机或私有网络");
  }
  return url;
}

async function readLimited(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_BYTES) throw new Error("网页正文超过 2 MiB 限制");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BYTES) {
      await reader.cancel();
      throw new Error("网页正文超过 2 MiB 限制");
    }
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

function pageTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  return match?.[1]?.replace(/\s+/gu, " ").trim() || null;
}

export class WebReader {
  constructor(private readonly store: Store) {}

  async read(rawUrl: string, now = Date.now(), signal?: AbortSignal): Promise<LinkCacheEntry> {
    signal?.throwIfAborted();
    const cached = this.store.getLink(rawUrl);
    if (cached && now - cached.fetchedAt < RETENTION_MS) return cached;

    let entry: LinkCacheEntry;
    try {
      let url = await validatePublicUrl(rawUrl);
      signal?.throwIfAborted();
      let response: Response | undefined;
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        response = await fetch(url, {
          redirect: "manual",
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { "User-Agent": "nib/0.2 (+personal digest bot)" },
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        if (!location) throw new Error("重定向响应缺少目标地址");
        url = await validatePublicUrl(new URL(location, url).toString());
        response = undefined;
      }
      if (!response) throw new Error("网页重定向次数过多");
      if (!response.ok) throw new Error(`网页返回 HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
        throw new Error(`暂不读取该内容类型：${contentType || "未知"}`);
      }
      const raw = await readLimited(response);
      const text = contentType.includes("text/html")
        ? htmlToText(raw, { wordwrap: false, selectors: [{ selector: "img", format: "skip" }] })
        : raw;
      const normalized = text.replace(/\n{3,}/gu, "\n\n").trim().slice(0, MAX_TEXT_CHARS);
      if (!normalized) throw new Error("网页没有可读取的文字");
      entry = {
        url: rawUrl,
        fetchedAt: now,
        ok: true,
        title: contentType.includes("text/html") ? pageTitle(raw) : null,
        content: normalized,
        error: null,
      };
    } catch (error) {
      signal?.throwIfAborted();
      entry = {
        url: rawUrl,
        fetchedAt: now,
        ok: false,
        title: null,
        content: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    signal?.throwIfAborted();
    this.store.saveLink(entry);
    return entry;
  }
}
