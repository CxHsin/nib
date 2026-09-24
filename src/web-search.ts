import { TinyFish, searchQueryResponseSchema } from "@tiny-fish/sdk";

export async function webSearch(query: string, apiKey: string, signal: AbortSignal) {
  if (!query.trim() || query.length > 500) throw new Error("搜索词须为 1～500 字");
  signal.throwIfAborted();
  const client = new TinyFish({ apiKey, timeout: 20_000, maxRetries: 0 });
  try {
    const raw = await client.get(client.productUrl("search"), { params: { query }, signal });
    const result = searchQueryResponseSchema.parse(raw);
    return result.results.slice(0, 5).filter(r => /^https?:\/\//i.test(r.url)).map(r => ({
      title: r.title.slice(0, 300), url: r.url, snippet: r.snippet.slice(0, 1200),
    }));
  } catch {
    signal.throwIfAborted();
    throw new Error("TinyFish 搜索失败，请检查服务、额度和凭据");
  }
}
