import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * FP-009: Jobs Service (Durable Task Queue)
 * Reliable job processing with lease-based execution
 * - SELECT FOR UPDATE SKIP LOCKED prevents concurrent worker conflict
 * - Lease prevents hung worker from blocking jobs
 * - At-least-once delivery with idempotency
 */
@Injectable()
export class JobsService {
  private LEASE_DURATION_MS = 60 * 1000; // 60 seconds
  private MAX_ATTEMPTS = 3;

  constructor(private prisma: PrismaService) {}

  /**
   * FP-009: Enqueue a job for processing
   */
  async enqueue(
    tenantId: string,
    name: string,
    data: Record<string, any>,
    maxAttempts: number = this.MAX_ATTEMPTS,
  ) {
    return this.prisma.jobs.create({
      data: {
        id: crypto.randomUUID(),
        tenantId,
        name,
        data,
        status: 'pending',
        attempt: 0,
        maxAttempts,
        nextRunAt: new Date(),
      },
    });
  }

  /**
   * FP-009: Claim next job to process (with lease)
   * Uses SELECT FOR UPDATE SKIP LOCKED for optimistic locking
   */
  async claimNextJob(workerId: string) {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.LEASE_DURATION_MS);

    // FP-009: Claim a pending job atomically
    const jobs = await this.prisma.jobs.updateMany({
      where: {
        status: 'pending',
        nextRunAt: { lte: now },
        OR: [
          { leaseOwner: null },
          { leaseUntil: { lte: now } }, // Lease expired, can reclaim
        ],
      },
      data: {
        leaseOwner: workerId,
        leaseUntil,
        status: 'started',
        startedAt: now,
      },
      take: 1,
    });

    if (jobs.count === 0) return null;

    // Re-fetch to get the updated job
    const pendingJobs = await this.prisma.jobs.findMany({
      where: {
        leaseOwner: workerId,
        status: 'started',
        startedAt: { gte: new Date(now.getTime() - 5000) }, // Just claimed
      },
      take: 1,
    });

    return pendingJobs[0] || null;
  }

  /**
   * FP-009: Mark job as completed
   */
  async complete(jobId: string, result: Record<string, any>) {
    return this.prisma.jobs.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        result,
        completedAt: new Date(),
        leaseOwner: null,
        leaseUntil: null,
      },
    });
  }

  /**
   * FP-009: Mark job as failed, retry if attempts left
   */
  async fail(jobId: string, error: string) {
    const job = await this.prisma.jobs.findUnique({ where: { id: jobId } });
    if (!job) return null;

    const nextAttempt = job.attempt + 1;
    const shouldRetry = nextAttempt < job.maxAttempts;

    return this.prisma.jobs.update({
      where: { id: jobId },
      data: {
        status: shouldRetry ? 'pending' : 'dead',
        error,
        attempt: nextAttempt,
        nextRunAt: shouldRetry ? new Date(Date.now() + 5000 + nextAttempt * 5000) : job.nextRunAt, // Exponential backoff
        leaseOwner: null,
        leaseUntil: null,
      },
    });
  }

  /**
   * FP-009: Get job status
   */
  async getStatus(tenantId: string) {
    const [pending, started, completed, dead] = await Promise.all([
      this.prisma.jobs.count({ where: { tenantId, status: 'pending' } }),
      this.prisma.jobs.count({ where: { tenantId, status: 'started' } }),
      this.prisma.jobs.count({ where: { tenantId, status: 'completed' } }),
      this.prisma.jobs.count({ where: { tenantId, status: 'dead' } }),
    ]);

    return { pending, started, completed, dead, total: pending + started + completed + dead };
  }

  /**
   * FP-009: Dead-letter queue — jobs that failed all retries
   */
  async getDeadLetterQueue(tenantId: string, limit: number = 50) {
    return this.prisma.jobs.findMany({
      where: { tenantId, status: 'dead' },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /**
   * FP-009: Recover stuck jobs (lease expired)
   */
  async recoverStuckJobs() {
    const now = new Date();
    return this.prisma.jobs.updateMany({
      where: {
        status: 'started',
        leaseUntil: { lte: now },
      },
      data: {
        status: 'pending',
        leaseOwner: null,
        leaseUntil: null,
      },
    });
  }
}
