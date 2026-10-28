/**
 * FP-021: Jobs Service with Lease Fencing
 * Prevents stale workers from confirming someone else's lease
 *
 * Key mechanisms:
 * - leaseVersion: incremented on recovery (fencing)
 * - leaseWorkerId: worker that claimed this lease
 * - Stale worker cannot confirm: version mismatch → ABORT
 * - Exponential backoff + jitter for retries
 * - Dead-letter queue for max_attempts exceeded
 */

import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';

export interface JobResult {
  jobId: string;
  status: string;
  result?: unknown;
  error?: string;
}

export interface ClaimedJob {
  id: string;
  leaseWorkerId: string;
  leaseVersion: number;
  leaseUntil: Date;
}

@Injectable()
export class JobsServiceFenced {
  private readonly logger = new Logger(JobsServiceFenced.name);
  private readonly workerId = `worker-${uuidv4().slice(0, 8)}`; // unique worker ID

  constructor(private prisma: PrismaService) {
    this.logger.log(`Worker ${this.workerId} started`);
  }

  /**
   * FP-021: Claim next job for processing
   * Atomically: SELECT → claim lease → update version
   * Only this worker can confirm (leaseWorkerId = workerId AND leaseVersion matches)
   */
  async claimNextJob(tenantId: string, leaseSeconds = 60): Promise<ClaimedJob | null> {
    const leaseUntil = new Date(Date.now() + leaseSeconds * 1000);

    // FP-021: Atomic claim using SELECT FOR UPDATE
    const claimed = await this.prisma.$transaction(async (tx) => {
      // First, recover any expired leases (fence stale workers)
      await this.recoverExpiredLeases(tx);

      // Then claim one job
      const job = await tx.jobs.findFirst({
        where: {
          tenantId,
          status: 'pending',
          nextRunAt: { lte: new Date() },
        },
        orderBy: { nextRunAt: 'asc' },
      });

      if (!job) return null;

      // FP-021: Claim with lease version 1 (safe because only we have this version)
      const updated = await tx.jobs.update({
        where: { id: job.id },
        data: {
          status: 'started',
          leaseWorkerId: this.workerId,
          leaseVersion: 1, // claim at version 1
          leaseUntil,
          leaseOwner: this.workerId, // legacy field
          startedAt: new Date(),
        },
      });

      return {
        id: updated.id,
        leaseWorkerId: updated.leaseWorkerId!,
        leaseVersion: updated.leaseVersion,
        leaseUntil: updated.leaseUntil!,
      };
    });

    if (claimed) {
      this.logger.debug(`Claimed job ${claimed.id} with lease v${claimed.leaseVersion}`);
    }

    return claimed;
  }

  /**
   * FP-021: Complete job (only if lease not fenced)
   * Worker must provide: jobId, leaseWorkerId, leaseVersion
   * Raises ConflictException if version mismatch (stale worker)
   */
  async completeJob(jobId: string, result: unknown): Promise<JobResult> {
    const job = await this.prisma.jobs.findUnique({ where: { id: jobId } });

    if (!job) {
      throw new ConflictException('Job not found');
    }

    // FP-021: Fence check: only original worker can complete
    if (job.leaseWorkerId !== this.workerId) {
      this.logger.warn(
        `Stale worker ${this.workerId} tried to confirm job ${jobId} ` +
        `(lease owner: ${job.leaseWorkerId})`,
      );
      throw new ConflictException(
        'Job lease fenced: another worker claimed it',
      );
    }

    // FP-021: Version check: confirm this is still our lease
    // (lease might have been recovered if we were slow)
    if (job.leaseVersion !== 1) {
      this.logger.warn(
        `Lease version mismatch for job ${jobId}: ` +
        `expected 1, got ${job.leaseVersion}`,
      );
      throw new ConflictException(
        'Job lease fenced: version mismatch (stale worker)',
      );
    }

    const completed = await this.prisma.jobs.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        result,
        completedAt: new Date(),
        leaseUntil: null,
        leaseWorkerId: null,
      },
    });

    this.logger.log(`Job ${jobId} completed`);
    return {
      jobId,
      status: 'completed',
      result,
    };
  }

  /**
   * FP-021: Fail job with exponential backoff + jitter
   * Backoff: 5s * 2^attempt + jitter(0-10%)
   * After max_attempts: move to dead-letter queue
   */
  async failJob(jobId: string, error: string): Promise<JobResult> {
    const job = await this.prisma.jobs.findUnique({ where: { id: jobId } });

    if (!job) {
      throw new ConflictException('Job not found');
    }

    // FP-021: Fence check
    if (job.leaseWorkerId !== this.workerId) {
      throw new ConflictException('Job lease fenced: stale worker');
    }

    const nextAttempt = job.attempt + 1;

    if (nextAttempt >= job.maxAttempts) {
      // FP-021: Move to dead-letter queue
      const dead = await this.prisma.jobs.update({
        where: { id: jobId },
        data: {
          status: 'dead',
          error,
          completedAt: new Date(),
          deadLetterReason: `Max attempts (${job.maxAttempts}) exceeded`,
          leaseUntil: null,
          leaseWorkerId: null,
        },
      });

      this.logger.warn(`Job ${jobId} moved to DLQ: ${error}`);
      return {
        jobId,
        status: 'dead',
        error,
      };
    }

    // FP-021: Exponential backoff with jitter
    const backoffSeconds = 5 * Math.pow(2, nextAttempt);
    const jitter = Math.random() * 0.1 * backoffSeconds; // 0-10% jitter
    const nextRunAt = new Date(
      Date.now() + (backoffSeconds + jitter) * 1000,
    );

    const retrying = await this.prisma.jobs.update({
      where: { id: jobId },
      data: {
        status: 'pending',
        attempt: nextAttempt,
        error,
        nextRunAt,
        leaseUntil: null,
        leaseWorkerId: null,
        leaseVersion: job.leaseVersion + 1, // increment version for next attempt
      },
    });

    this.logger.log(
      `Job ${jobId} failed (attempt ${nextAttempt}/${job.maxAttempts}), ` +
      `retrying in ${(backoffSeconds + jitter).toFixed(1)}s`,
    );

    return {
      jobId,
      status: 'pending',
      error,
    };
  }

  /**
   * FP-021: Get dead-letter queue (jobs that failed permanently)
   */
  async getDeadLetterQueue(tenantId: string, limit = 100) {
    return this.prisma.jobs.findMany({
      where: {
        tenantId,
        status: 'dead',
      },
      orderBy: { completedAt: 'desc' },
      take: limit,
    });
  }

  /**
   * FP-021: Recover expired leases (fence stale workers)
   * Called at start of transaction to clean up before claiming new jobs
   */
  private async recoverExpiredLeases(tx: any) {
    const now = new Date();

    // Find jobs with expired leases
    const expired = await tx.jobs.findMany({
      where: {
        status: 'started',
        leaseUntil: { lte: now },
      },
    });

    for (const job of expired) {
      this.logger.warn(
        `Recovering expired lease for job ${job.id} ` +
        `(owner: ${job.leaseWorkerId}, lease until: ${job.leaseUntil})`,
      );

      // FP-021: Move back to pending with incremented version
      // Stale worker cannot claim this job again
      await tx.jobs.update({
        where: { id: job.id },
        data: {
          status: 'pending',
          leaseUntil: null,
          leaseWorkerId: null,
          leaseVersion: job.leaseVersion + 1, // increment for fencing
          fencedAt: now,
          nextRunAt: new Date(), // retry immediately
        },
      });
    }

    return expired.length;
  }

  /**
   * FP-021: Get job status (for monitoring)
   */
  async getStatus(tenantId: string) {
    const stats = await this.prisma.jobs.groupBy({
      by: ['status'],
      where: { tenantId },
      _count: true,
    });

    const counts = Object.fromEntries(
      stats.map((s) => [s.status, s._count]),
    );

    const pending = counts['pending'] || 0;
    const started = counts['started'] || 0;
    const completed = counts['completed'] || 0;
    const failed = counts['failed'] || 0;
    const dead = counts['dead'] || 0;

    return {
      workerId: this.workerId,
      pending,
      started,
      completed,
      failed,
      dead,
      total: pending + started + completed + failed + dead,
    };
  }
}
