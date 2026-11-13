/**
 * PONTO DE EXTENSÃO DA AUTENTICAÇÃO.
 *
 * O desafio exige que, mesmo sem autenticação implementada, o ponto onde ela entra
 * fique explícito no código. Esta "porta" (port) responde: quem é o provedor que fez a chamada?
 *
 * A implementação padrão (`AnonymousProviderIdentity`) aceita tudo — o comportamento
 * de quando a autenticação está desligada. Uma implementação com Identity Provider externo
 * (ex.: Keycloak) substitui esta classe sem mudar o resto do código.
 */
export interface AuthenticatedProvider {
  /** O providerId que o token autoriza (ex.: "provider-a"). */
  providerId: string;
}

export abstract class ProviderIdentityPort {
  /**
   * Resolve o provedor a partir dos headers da requisição.
   * Devolve `null` quando a autenticação está desligada (aceita qualquer provedor).
   * Lança UnauthorizedException quando a credencial é inválida.
   */
  abstract authenticate(headers: Record<string, string | string[] | undefined>): Promise<AuthenticatedProvider | null>;
}

/** Autenticação desligada: ninguém é identificado e nada é bloqueado. */
export class AnonymousProviderIdentity extends ProviderIdentityPort {
  async authenticate(): Promise<AuthenticatedProvider | null> {
    return null;
  }
}
