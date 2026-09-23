import { Controller, Get, HttpCode, Inject, Param, Post, Req, Res, StreamableFile } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RunsService } from './runs.service';

@Controller('runs')
export class RunsController {
  constructor(@Inject(RunsService) private readonly runs: RunsService) {}

  @Post()
  @HttpCode(202)
  createRun(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    return this.runs.create(request, response);
  }

  @Get(':run_id')
  getRun(@Param('run_id') id: string) {
    return this.runs.get(id);
  }

  @Get(':run_id/result')
  getResult(@Param('run_id') id: string) {
    return this.runs.result(id);
  }

  @Get(':run_id/exports/:filename')
  getExport(@Param('run_id') id: string, @Param('filename') filename: string) {
    return new StreamableFile(this.runs.export(id, filename), {
      type: 'text/csv; charset=utf-8', disposition: `attachment; filename="${filename}"`,
    });
  }
}
