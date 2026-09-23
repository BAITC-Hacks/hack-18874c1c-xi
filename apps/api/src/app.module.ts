import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { RunsController } from './runs.controller';

@Module({ controllers: [HealthController, RunsController] })
export class AppModule {}
