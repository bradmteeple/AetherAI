import { EventEmitter } from 'node:events';
import { RoomMessage } from './protocol';
import { classifyRoom, RoomKind } from './rooms';
import { ShowdownConnection } from './ShowdownConnection';

export type RoomMessageHandler = (msg: RoomMessage) => void;

/**
 * Routes parsed protocol messages by room kind. Handlers can subscribe to a
 * kind (`battle`, `bestof`, `global`, ...) or a specific room id.
 */
export class ProtocolRouter extends EventEmitter {
  private readonly roomHandlers = new Map<string, Set<RoomMessageHandler>>();

  constructor(private readonly conn: ShowdownConnection) {
    super();
    conn.on('message', (msg: RoomMessage) => this.route(msg));
  }

  route(msg: RoomMessage): void {
    const kind: RoomKind = classifyRoom(msg.room);
    this.emit('message', msg);
    this.emit(kind, msg);
    const handlers = this.roomHandlers.get(msg.room);
    if (handlers) for (const h of handlers) h(msg);
  }

  onKind(kind: RoomKind | 'message', handler: RoomMessageHandler): () => void {
    this.on(kind, handler);
    return () => this.off(kind, handler);
  }

  onRoom(roomId: string, handler: RoomMessageHandler): () => void {
    let set = this.roomHandlers.get(roomId);
    if (!set) {
      set = new Set();
      this.roomHandlers.set(roomId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (!set!.size) this.roomHandlers.delete(roomId);
    };
  }

  get connection(): ShowdownConnection {
    return this.conn;
  }
}
