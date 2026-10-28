/**
 * FP-004: Backoffice Provider Registry
 * Central location for provider selection per organization
 * Feature flags + read-only shadow comparison support
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BackofficeProvider, BackofficeProviderRegistry } from './backoffice.provider';
import { OnecBackofficeProvider } from './onec.backoffice.provider';
import { MoyskladBackofficeProvider } from './moysklad.backoffice.provider';
import { InternalBackofficeProvider } from './internal.backoffice.provider';

@Injectable()
export class BackofficeProviderRegistryImpl implements BackofficeProviderRegistry {
  private readonly logger = new Logger(BackofficeProviderRegistryImpl.name);
  private providerCache = new Map<string, BackofficeProvider>();

  constructor(
    private prisma: PrismaService,
    private onecProvider: OnecBackofficeProvider,
    private moyskladProvider: MoyskladBackofficeProvider,
    private internalProvider: InternalBackofficeProvider,
  ) {}

  /**
   * FP-004: Get active provider for organization
   * Selects based on:
   * 1. Feature flag (if enabled)
   * 2. Organization setting (if configured)
   * 3. Default (internal)
   */
  async getProvider(organizationId: string, system?: string): Promise<BackofficeProvider> {
    const cacheKey = `${organizationId}:${system || 'default'}`;
    if (this.providerCache.has(cacheKey)) {
      return this.providerCache.get(cacheKey)!;
    }

    // FP-004: Determine which system to use
    let activeSystem = system;
    if (!activeSystem) {
      // Check organization setting
      const org = await this.prisma.organization.findUnique({
        where: { id: organizationId },
      });
      activeSystem = org?.backofficeSystem || 'internal'; // Default to internal
    }

    // FP-004: Get provider instance
    let provider: BackofficeProvider;
    switch (activeSystem) {
      case 'onec':
        // Initialize with organization's 1C connection
        const onecConn = await this.prisma.onecConnection.findFirst({
          where: { organizationId, isActive: true },
        });
        if (!onecConn) {
          this.logger.warn(`No active 1C connection for org ${organizationId}, falling back to internal`);
          provider = this.internalProvider;
        } else {
          await this.onecProvider.initialize(onecConn.id);
          provider = this.onecProvider;
        }
        break;

      case 'moysklad':
        // Initialize with organization's MoySklad connection
        const msConn = await this.prisma.moyskladConnection.findFirst({
          where: { organizationId, isActive: true },
        });
        if (!msConn) {
          this.logger.warn(`No active MoySklad connection for org ${organizationId}, falling back to internal`);
          provider = this.internalProvider;
        } else {
          await this.moyskladProvider.initialize(msConn.id);
          provider = this.moyskladProvider;
        }
        break;

      case 'internal':
      default:
        provider = this.internalProvider;
        break;
    }

    this.providerCache.set(cacheKey, provider);
    return provider;
  }

  /**
   * FP-004: List available systems for organization
   */
  async listAvailable(organizationId: string): Promise<string[]> {
    const available = ['internal']; // Always available

    // Check for 1C connection
    const onecConn = await this.prisma.onecConnection.findFirst({
      where: { organizationId, isActive: true },
    });
    if (onecConn) available.push('onec');

    // Check for MoySklad connection
    const msConn = await this.prisma.moyskladConnection.findFirst({
      where: { organizationId, isActive: true },
    });
    if (msConn) available.push('moysklad');

    return available;
  }

  /**
   * FP-004: Set active system for organization
   */
  async setActive(organizationId: string, system: string): Promise<void> {
    if (!['internal', 'onec', 'moysklad'].includes(system)) {
      throw new Error(`Unknown backoffice system: ${system}`);
    }

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { backofficeSystem: system },
    });

    // Invalidate cache
    this.providerCache.delete(`${organizationId}:default`);
    this.logger.log(`Switched ${organizationId} to ${system}`);
  }

  /**
   * FP-004: Invalidate cache (call after connection changes)
   */
  invalidateCache(organizationId?: string) {
    if (organizationId) {
      // Invalidate specific org
      const keysToDelete = Array.from(this.providerCache.keys()).filter((k) =>
        k.startsWith(`${organizationId}:`),
      );
      keysToDelete.forEach((k) => this.providerCache.delete(k));
    } else {
      // Invalidate all
      this.providerCache.clear();
    }
  }
}
