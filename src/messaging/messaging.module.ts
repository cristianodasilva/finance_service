import { Module } from '@nestjs/common';
import { WageringModule } from '../wagering/wagering.module';
import { createSqsClient, SQS_CLIENT } from './sqs.client';
import { WagerQueueConsumer } from './wager-queue.consumer';

@Module({
  imports: [WageringModule],
  providers: [{ provide: SQS_CLIENT, useFactory: createSqsClient }, WagerQueueConsumer],
  exports: [SQS_CLIENT],
})
export class MessagingModule {}
