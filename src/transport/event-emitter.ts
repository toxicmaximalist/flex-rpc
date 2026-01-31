/**
 * flex-rpc: Simple Event Emitter
 *
 * Lightweight typed event emitter for transport events.
 * No external dependencies.
 */

export type EventListener<T extends unknown[] = unknown[]> = (...args: T) => void;

export class EventEmitter<TEvents extends Record<string, unknown[]>> {
  private listeners = new Map<keyof TEvents, Set<EventListener>>();
  private onceListeners = new Map<keyof TEvents, Set<EventListener>>();

  /**
   * Register an event listener
   */
  on<K extends keyof TEvents>(event: K, listener: EventListener<TEvents[K]>): this {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener as EventListener);
    return this;
  }

  /**
   * Remove an event listener
   */
  off<K extends keyof TEvents>(event: K, listener: EventListener<TEvents[K]>): this {
    this.listeners.get(event)?.delete(listener as EventListener);
    this.onceListeners.get(event)?.delete(listener as EventListener);
    return this;
  }

  /**
   * Register a one-time event listener
   */
  once<K extends keyof TEvents>(event: K, listener: EventListener<TEvents[K]>): this {
    if (!this.onceListeners.has(event)) {
      this.onceListeners.set(event, new Set());
    }
    this.onceListeners.get(event)!.add(listener as EventListener);
    return this;
  }

  /**
   * Emit an event
   */
  protected emit<K extends keyof TEvents>(event: K, ...args: TEvents[K]): boolean {
    let handled = false;

    // Call regular listeners
    const listeners = this.listeners.get(event);
    if (listeners) {
      for (const listener of listeners) {
        listener(...args);
        handled = true;
      }
    }

    // Call and remove once listeners
    const onceListeners = this.onceListeners.get(event);
    if (onceListeners) {
      for (const listener of onceListeners) {
        listener(...args);
        handled = true;
      }
      onceListeners.clear();
    }

    return handled;
  }

  /**
   * Remove all listeners for an event, or all events
   */
  removeAllListeners<K extends keyof TEvents>(event?: K): this {
    if (event) {
      this.listeners.delete(event);
      this.onceListeners.delete(event);
    } else {
      this.listeners.clear();
      this.onceListeners.clear();
    }
    return this;
  }

  /**
   * Get the number of listeners for an event
   */
  listenerCount<K extends keyof TEvents>(event: K): number {
    return (this.listeners.get(event)?.size ?? 0) + (this.onceListeners.get(event)?.size ?? 0);
  }
}
