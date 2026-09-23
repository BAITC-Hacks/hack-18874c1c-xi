import { Controller, Get, NotImplementedException, Post } from '@nestjs/common';

function pipelineNotImplemented(): never {
  throw new NotImplementedException({
    statusCode: 501,
    error: {
      code: 'PIPELINE_NOT_IMPLEMENTED',
      message: 'Python analytics integration is not implemented yet.',
    },
  });
}

@Controller('runs')
export class RunsController {
  @Post()
  createRun(): never {
    return pipelineNotImplemented();
  }

  @Get(':run_id')
  getRun(): never {
    return pipelineNotImplemented();
  }

  @Get(':run_id/result')
  getResult(): never {
    return pipelineNotImplemented();
  }

  @Get(':run_id/exports/:filename')
  getExport(): never {
    return pipelineNotImplemented();
  }
}
