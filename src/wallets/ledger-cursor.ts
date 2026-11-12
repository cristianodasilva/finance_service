import { DomainError, FailureCode } from '../domain/errors';

/**
 * Cursor de paginação do extrato.
 *
 * Paginação por CURSOR (e não por "página 1, 2, 3"): o cliente recebe um marcador
 * "continue a partir daqui". Vantagem: se novos movimentos entrarem enquanto o cliente
 * navega, nenhuma linha é pulada nem repetida (o que acontece com OFFSET).
 *
 * O marcador é a `wallet_version` do último item devolvido: ela é única por carteira
 * e cresce a cada movimento, então define uma ordem exata.
 * Codificamos em base64url para o cliente tratá-lo como "opaco" (não depender do formato).
 */
export function encodeCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString('base64url');
}

export function decodeCursor(cursor: string): number {
  try {
    const { v } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Number.isInteger(v) && v > 0) return v;
  } catch {
    // cai no erro abaixo
  }
  throw new DomainError(FailureCode.INVALID_REQUEST, 'Invalid cursor');
}
