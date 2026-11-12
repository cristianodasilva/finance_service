import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { HealthController } from './health.controller';

@Module({
  imports: [MessagingModule], // fornece o cliente SQS para o /health/ready
  controllers: [HealthController],
})
export class HealthModule {}
