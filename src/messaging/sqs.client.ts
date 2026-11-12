import { SQSClient } from '@aws-sdk/client-sqs';
import { config } from '../config';

/** Cliente do SQS apontando para o MiniStack (ou para a AWS de verdade, se trocar o endpoint). */
export function createSqsClient(): SQSClient {
  return new SQSClient({
    region: config.aws.region,
    endpoint: config.aws.endpoint,
    credentials: { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey },
  });
}

/** Token de injeção de dependência: permite pedir o cliente SQS no construtor. */
export const SQS_CLIENT = Symbol('SQS_CLIENT');
