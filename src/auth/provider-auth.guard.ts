import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ProviderIdentityPort } from './provider-identity';

/**
 * Guard dos endpoints de negócio. Com a autenticação desligada, não bloqueia nada (no-op).
 * Com ela ligada, exige credencial válida E confere que o `providerId` do corpo/rota
 * é o mesmo do token — um provedor não pode enviar transações em nome de outro.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { provider?: { providerId: string } }>();
    const provider = await this.identity.authenticate(request.headers);
    if (provider === null) return true; // autenticação desligada

    request.provider = provider;
    const claimed = (request.body as { providerId?: unknown } | undefined)?.providerId ?? request.params?.providerId;
    if (typeof claimed === 'string' && claimed !== provider.providerId) {
      throw new ForbiddenException({
        code: 'PROVIDER_FORBIDDEN',
        message: `Token is for provider "${provider.providerId}", not "${claimed}"`,
      });
    }
    return true;
  }
}
