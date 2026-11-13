import { DomainError, FailureCode } from '../domain/errors';

/**
 * Pequenas funções para validar o corpo das requisições.
 * Se algo estiver errado → HTTP 400 (entrada inválida).
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError(FailureCode.INVALID_REQUEST, 'Body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** Campo obrigatório de texto, não vazio, com tamanho máximo. */
export function requireString(obj: Record<string, unknown>, field: string, maxLength = 128): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new DomainError(FailureCode.INVALID_REQUEST, `"${field}" must be a non-empty string (max ${maxLength} chars)`);
  }
  return value;
}

/** Campo opcional de texto: se vier, precisa ser string. */
export function optionalString(obj: Record<string, unknown>, field: string, maxLength = 128): string | undefined {
  if (obj[field] === undefined || obj[field] === null) return undefined;
  return requireString(obj, field, maxLength);
}

export function requireUuid(value: string, field = 'id'): string {
  if (!UUID_REGEX.test(value)) {
    throw new DomainError(FailureCode.INVALID_REQUEST, `"${field}" must be a UUID`);
  }
  return value;
}
