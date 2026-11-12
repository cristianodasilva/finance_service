import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  ready(): { status: string } {
    // TODO: check PostgreSQL and SQS connectivity once they are wired in.
    return { status: 'ok' };
  }
}
