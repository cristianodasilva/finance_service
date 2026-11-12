import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { config } from '../config';
import { runWithLogContext } from '../observability/log-context';
import { metrics } from '../observability/metrics';
import { ProcessWagerService } from '../wagering/process-wager.service';
import { parseWagerCommand } from '../wagering/wager-command.parser';
import { classifyError } from './message-outcome';
import { SQS_CLIENT } from './sqs.client';

/**
 * Consumidor da fila `wager-transactions.fifo`.
 *
 * Fluxo de cada mensagem:
 *   1. lê o JSON e valida (mesmo parser da API HTTP);
 *   2. chama o MESMO ProcessWagerService da API (regras idênticas);
 *   3. SÓ DEPOIS do COMMIT apaga a mensagem da fila (ack).
 *
 * Se o processo morrer entre o passo 2 e o 3, a mensagem volta para a fila
 * e é entregue de novo — e a tabela inbox_messages garante que não processamos duas vezes.
 */
@Injectable()
export class WagerQueueConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WagerQueueConsumer.name);
  private running = false;
  /** Permite interromper a espera da fila no desligamento. */
  private abort = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly processWager: ProcessWagerService,
  ) {}

  /** O NestJS chama ao terminar de subir a aplicação. */
  onApplicationBootstrap(): void {
    if (!config.sqs.consumerEnabled) return;
    this.running = true;
    this.loop = this.pollLoop();
    this.logger.log('SQS consumer started');
  }

  /**
   * O NestJS chama ao receber SIGTERM (desligamento).
   * Desligamento "gracioso": para de buscar mensagens novas, ESPERA as que estão
   * em processamento terminarem, e só então deixa o processo sair.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    if (!this.running) return;
    this.logger.log(`Stopping SQS consumer (${signal ?? 'shutdown'})...`);
    this.running = false;
    this.abort.abort(); // corta a espera do long polling
    await this.loop;
    this.logger.log('SQS consumer stopped');
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce(config.sqs.waitTimeSeconds);
      } catch (error) {
        if (!this.running) break; // erro causado pelo próprio desligamento
        this.logger.error(`Polling failed: ${(error as Error).message}`);
        await new Promise((r) => setTimeout(r, 1_000)); // fila fora do ar: espera e tenta de novo
      }
    }
  }

  /**
   * Busca um lote de mensagens e processa. Público para os testes chamarem diretamente.
   * Devolve quantas mensagens foram recebidas.
   */
  async pollOnce(waitTimeSeconds = 0): Promise<number> {
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: config.sqs.wagerQueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitTimeSeconds, // long polling: espera até chegar algo
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: this.abort.signal },
    );

    // FIFO: mensagens do MESMO grupo (mesma carteira) em ordem, uma de cada vez.
    // Grupos diferentes podem ser processados em paralelo.
    const byGroup = new Map<string, Message[]>();
    for (const m of Messages) {
      const group = m.Attributes?.MessageGroupId ?? 'default';
      byGroup.set(group, [...(byGroup.get(group) ?? []), m]);
    }
    await Promise.all(
      [...byGroup.values()].map(async (messages) => {
        for (const m of messages) await this.handle(m);
      }),
    );
    return Messages.length;
  }

  private handle(message: Message): Promise<void> {
    // Todos os logs desta mensagem levam o messageId como id de correlação.
    const messageId = message.MessageId!;
    return runWithLogContext({ correlationId: messageId, messageId }, () => this.handleInContext(message));
  }

  private async handleInContext(message: Message): Promise<void> {
    const messageId = message.MessageId!;
    try {
      const command = parseWagerCommand(JSON.parse(message.Body ?? ''));
      const { transaction, replayed } = await this.processWager.execute(command, { type: 'sqs', messageId });
      // Chegou aqui = COMMIT feito. Agora sim confirmamos (ack).
      await this.ack(message);
      metrics.sqsMessages.inc({ outcome: replayed ? 'duplicate' : 'processed' });
      this.logger.log(
        `Message ${messageId} → ${transaction.status}${transaction.failureCode ? ` (${transaction.failureCode})` : ''}${replayed ? ' [duplicate]' : ''}`,
      );
    } catch (error) {
      const { kind, code } = classifyError(error);
      if (kind === 'permanent') {
        await this.sendToDeadLetter(message, code, (error as Error).message);
        metrics.sqsMessages.inc({ outcome: 'dead_lettered' });
        metrics.deadLettered.inc({ reason: code });
        this.logger.warn(`Message ${messageId} sent to DLQ: ${code}`);
      } else {
        await this.retryLater(message);
        metrics.sqsMessages.inc({ outcome: 'retried' });
        this.logger.warn(`Message ${messageId} will be retried: ${code}`);
      }
    }
  }

  /** Apaga a mensagem da fila: "processei, pode esquecer". */
  private async ack(message: Message): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: config.sqs.wagerQueueUrl, ReceiptHandle: message.ReceiptHandle! }),
    );
  }

  /** Erro permanente: copia para a DLQ com o motivo e remove da fila principal. */
  private async sendToDeadLetter(message: Message, code: string, reason: string): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: config.sqs.wagerDlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'default',
        MessageDeduplicationId: message.MessageId!,
        MessageAttributes: {
          failureCode: { DataType: 'String', StringValue: code },
          failureReason: { DataType: 'String', StringValue: reason.slice(0, 256) },
          originalMessageId: { DataType: 'String', StringValue: message.MessageId! },
        },
      }),
    );
    await this.ack(message);
  }

  /**
   * Erro temporário: NÃO apaga. Ajusta quando a mensagem volta a ficar visível,
   * com espera crescente (2s, 4s, 8s...). Após 5 recebimentos, o SQS a move para a DLQ.
   */
  private async retryLater(message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    const delaySeconds = Math.min(2 ** receiveCount, 60);
    await this.sqs
      .send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: config.sqs.wagerQueueUrl,
          ReceiptHandle: message.ReceiptHandle!,
          VisibilityTimeout: delaySeconds,
        }),
      )
      .catch(() => undefined); // se falhar, o tempo padrão de visibilidade (30s) vale
  }
}
