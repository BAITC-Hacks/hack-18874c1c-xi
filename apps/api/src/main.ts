import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap';
import { readConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = readConfig();
  const app = await createApp({ webOrigin: config.webOrigin });
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
}

void bootstrap().catch((error: unknown) => {
  Logger.error(error instanceof Error ? error.message : String(error), 'Bootstrap');
  process.exitCode = 1;
});
