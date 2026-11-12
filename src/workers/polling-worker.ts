import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

/**
 * Base para workers que rodam em loop: "faz um lote de trabalho, espera um pouco, repete".
 *
 * Cuida de:
 *  - iniciar quando a aplicação sobe (se estiver habilitado);
 *  - desligamento gracioso no SIGTERM: para de começar lotes novos
 *    e ESPERA o lote atual terminar antes de deixar o processo sair.
 */
export abstract class PollingWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  protected abstract readonly logger: Logger;
  protected abstract readonly enabled: boolean;
  protected abstract readonly intervalMs: number;

  private running = false;
  private loop: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;

  /** Processa um lote. Devolve quantos itens processou (0 = nada a fazer → espera o intervalo). */
  abstract runOnce(): Promise<number>;

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.running = true;
    this.loop = this.run();
    this.logger.log('Worker started');
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wakeUp?.(); // interrompe a espera entre lotes
    await this.loop; // espera o lote atual terminar
    this.logger.log('Worker stopped');
  }

  private async run(): Promise<void> {
    while (this.running) {
      let processed = 0;
      try {
        processed = await this.runOnce();
      } catch (error) {
        this.logger.error(`Batch failed: ${(error as Error).message}`);
      }
      // Se o lote veio cheio, provavelmente há mais trabalho: continua sem esperar.
      if (processed === 0 && this.running) await this.sleep(this.intervalMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
