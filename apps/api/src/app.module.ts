import { Module, type DynamicModule } from '@nestjs/common';
import { HealthController } from './health.controller';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';
import { RUN_CONFIG, type RunConfig } from './run-config';

@Module({})
export class AppModule {
  static register(config: RunConfig): DynamicModule {
    return { module: AppModule, controllers: [HealthController, RunsController],
      providers: [{ provide: RUN_CONFIG, useValue: config }, RunsService] };
  }
}
