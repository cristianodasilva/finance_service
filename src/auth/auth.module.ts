import { Global, Module } from '@nestjs/common';
import { ProviderAuthGuard } from './provider-auth.guard';
import { AnonymousProviderIdentity, ProviderIdentityPort } from './provider-identity';

/**
 * Liga a porta de identidade à implementação escolhida.
 * Hoje: AnonymousProviderIdentity (autenticação desligada).
 */
@Global()
@Module({
  providers: [{ provide: ProviderIdentityPort, useClass: AnonymousProviderIdentity }, ProviderAuthGuard],
  exports: [ProviderIdentityPort, ProviderAuthGuard],
})
export class AuthModule {}
