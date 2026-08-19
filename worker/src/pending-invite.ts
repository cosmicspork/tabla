/** Placeholder for the pending-invite Durable Object (milestone 6). */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';

export class PendingInviteDO extends DurableObject<Env> {
  async fetch(_request: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  }
}
