import { nowIso } from "../util/ids";

interface LiveState {
  revision: number;
  sections: unknown[];
  title?: string;
  currentSectionId: string | null;
  updatedAt: string;
}

interface Participant {
  id: string;
  name: string;
  lastSeen: string;
}

/**
 * SongSessionDO — one Durable Object per active songwriting session (spec §32/§45).
 *
 * Holds live editor state, coordinates autosave (revision numbers) and keeps the
 * participants list warm for real-time collaboration. D1 stays the system of
 * record: the DO only owns the in-flight session.
 */
export class SongSessionDO implements DurableObject {
  private readonly sessions = new Map<string, Participant>();

  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      switch (true) {
        case path === "/live" && request.method === "GET":
          return await this.getState();
        case path === "/live" && request.method === "POST":
          return await this.updateState(request);
        case path === "/participants":
          return await this.participants(request);
        case path === "/ws":
          return await this.upgrade(request);
        case path === "/reset" && request.method === "POST":
          await this.state.storage.delete("live");
          this.broadcast({ type: "reset" });
          return Response.json({ ok: true });
        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 400 });
    }
  }

  private async getState(): Promise<Response> {
    const live = (await this.state.storage.get<LiveState>("live")) ?? null;
    const participants = [...this.sessions.values()].filter(
      (participant) => Date.now() - Date.parse(participant.lastSeen) < 60_000,
    );
    return Response.json({ live, participants });
  }

  private async updateState(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<LiveState> & { participant?: { id: string; name: string } };
    const existing = (await this.state.storage.get<LiveState>("live")) ?? null;
    const revision = (existing?.revision ?? 0) + 1;
    const live: LiveState = {
      revision,
      sections: Array.isArray(body.sections) ? body.sections : existing?.sections ?? [],
      title: body.title ?? existing?.title,
      currentSectionId: body.currentSectionId ?? existing?.currentSectionId ?? null,
      updatedAt: nowIso(),
    };
    await this.state.storage.put("live", live);
    if (body.participant) this.touchParticipant(body.participant.id, body.participant.name);
    this.broadcast({ type: "state", revision, payload: live });
    return Response.json({ revision, updatedAt: live.updatedAt });
  }

  private async participants(request: Request): Promise<Response> {
    const body = (await request.json()) as { id?: string; name?: string; leave?: boolean };
    if (body.leave && body.id) this.sessions.delete(body.id);
    else if (body.id) this.touchParticipant(body.id, body.name ?? "artist");
    return Response.json({
      participants: [...this.sessions.values()].filter(
        (participant) => Date.now() - Date.parse(participant.lastSeen) < 60_000,
      ),
    });
  }

  private touchParticipant(id: string, name: string): void {
    this.sessions.set(id, { id, name, lastSeen: nowIso() });
    // Bounded: a long-lived session must not accumulate stale participants.
    if (this.sessions.size > 16) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeen.localeCompare(b.lastSeen))[0];
      if (oldest) this.sessions.delete(oldest.id);
    }
  }

  private async upgrade(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "hello", revision: (await this.state.storage.get<LiveState>("live"))?.revision ?? 0 }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(message: unknown): void {
    const encoded = JSON.stringify(message);
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(encoded);
      } catch {
        // A dead socket is cleaned up by the runtime.
      }
    }
  }

  // Hibernation API handlers — keep the DO from staying warm just for sockets.
  async webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    try {
      const parsed = JSON.parse(message) as { type?: string; participant?: { id: string; name: string } };
      if (parsed.type === "ping" && parsed.participant) {
        this.touchParticipant(parsed.participant.id, parsed.participant.name);
      }
    } catch {
      // Ignore malformed frames from clients.
    }
  }

  async webSocketClose(_socket: WebSocket): Promise<void> {
    try {
      _socket.close(1000, "closed");
    } catch {
      // already closed
    }
  }
}
