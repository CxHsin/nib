import { loadConfig } from "./config.js";
import { NibService } from "./service.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const service = new NibService(config);
  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`[退出] 收到 ${signal}`);
    await service.stop();
  };
  process.once("SIGINT", () => void stop("SIGINT").finally(() => process.exit(0)));
  process.once("SIGTERM", () => void stop("SIGTERM").finally(() => process.exit(0)));
  await service.start();
}

main().catch((error: unknown) => {
  console.error("nib 启动失败", error);
  process.exitCode = 1;
});
