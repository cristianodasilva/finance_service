import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  ready(): { status: string } {
    // A FAZER: verificar conexão com PostgreSQL e SQS quando estiverem configurados.
    return { status: 'ok' };
  }
}
