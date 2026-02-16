import type { AgentWorldUpdatePayload } from './types.js';

export interface WorldEvent {
  type: string;
  summary: string;
  timestamp: number;
}

const MAX_EVENTS = 20;
const EVENT_TTL_MS = 5 * 60 * 1000; // 5 minutes

class WorldStateTracker {
  private worldState: AgentWorldUpdatePayload | null = null;
  private recentEvents: WorldEvent[] = [];

  updateWorld(payload: AgentWorldUpdatePayload): void {
    this.worldState = payload;
  }

  getWorld(): AgentWorldUpdatePayload | null {
    return this.worldState;
  }

  pushEvent(event: WorldEvent): void {
    this.recentEvents.push(event);
    const cutoff = Date.now() - EVENT_TTL_MS;
    this.recentEvents = this.recentEvents
      .filter((e) => e.timestamp > cutoff)
      .slice(-MAX_EVENTS);
  }

  getRecentEvents(): WorldEvent[] {
    const cutoff = Date.now() - EVENT_TTL_MS;
    return this.recentEvents.filter((e) => e.timestamp > cutoff);
  }

  clear(): void {
    this.worldState = null;
    this.recentEvents = [];
  }
}

export const worldTracker = new WorldStateTracker();
