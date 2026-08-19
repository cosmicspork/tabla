/** Placeholder for the game room Durable Object (milestones 6 and 7). */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';

export class GameRoomDO extends DurableObject<Env> {
  async fetch(_request: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  }
}
