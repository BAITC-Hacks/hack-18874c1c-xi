import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

export async function createApp(options: {
  webOrigin: string;
  logger?: false;
}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: options.logger });
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: options.webOrigin,
    methods: ['GET', 'POST', 'OPTIONS'],
  });
  return app;
}
