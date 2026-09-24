import { loadConfig } from "./config.js";
import { NibService } from "./service.js";

async function main(): Promise<void> {
  const service = new NibService(loadConfig());
  try {
    console.log("[晚报] 正在生成临时晚报并发送……");
    await service.runWindow(Date.now());
    console.log("[晚报] 临时晚报发送完成。");
  } finally {
    await service.stop();
  }
}

main().catch((error: unknown) => {
  console.error("[晚报] 临时发送失败", error);
  process.exitCode = 1;
});
