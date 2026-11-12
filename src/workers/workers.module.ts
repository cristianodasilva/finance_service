import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { WageringModule } from '../wagering/wagering.module';
import { OutboxPublisherWorker } from './outbox-publisher.worker';
import { PendingReferenceWorker } from './pending-reference.worker';

@Module({
  imports: [MessagingModule, WageringModule],
  providers: [OutboxPublisherWorker, PendingReferenceWorker],
})
export class WorkersModule {}
