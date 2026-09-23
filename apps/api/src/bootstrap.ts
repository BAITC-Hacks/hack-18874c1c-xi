import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { readRunConfig, type RunConfig } from './run-config';

export async function createApp(options: {
  webOrigin: string;
  logger?: false;
  runs?: Partial<RunConfig>;
}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register({ ...readRunConfig(), ...options.runs }), {
    logger: options.logger, forceCloseConnections: true,
  });
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: options.webOrigin,
    methods: ['GET', 'POST', 'OPTIONS'],
  });
  return app;
}
