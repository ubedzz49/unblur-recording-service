export interface RecordingInfo {
  id: string;
  roomName: string;
  // Daily's own recording start timestamp, seconds since epoch
  startTs: number;
}

// Strategy pattern -- same reasoning as VideoRoomProvider in meeting-service: lets the real
// Daily-backed implementation swap out cleanly in tests
export interface RecordingProvider {
  listRecordings(): Promise<RecordingInfo[]>;
  deleteRecording(id: string): Promise<void>;
  // a temporary signed playback/download URL for a room's recording, for the admin dashboard's
  // "view this complaint's recording" action. null if no recording exists for that room (e.g.
  // already swept, or the session was never recorded).
  getAccessLinkForRoom(roomName: string): Promise<string | null>;
}

const DAILY_API_BASE = "https://api.daily.co/v1";

export class DailyRecordingProvider implements RecordingProvider {
  async listRecordings(): Promise<RecordingInfo[]> {
    const apiKey = process.env.DAILY_API_KEY;
    if (!apiKey) {
      throw new Error("DAILY_API_KEY is not set");
    }

    const res = await fetch(`${DAILY_API_BASE}/recordings`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`daily list recordings failed: ${res.status} ${body}`);
    }

    const json = (await res.json()) as { data: { id: string; room_name: string; start_ts: number }[] };
    return json.data.map((r) => ({ id: r.id, roomName: r.room_name, startTs: r.start_ts }));
  }

  async deleteRecording(id: string): Promise<void> {
    const apiKey = process.env.DAILY_API_KEY;
    if (!apiKey) {
      throw new Error("DAILY_API_KEY is not set");
    }

    const res = await fetch(`${DAILY_API_BASE}/recordings/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`daily delete recording failed: ${res.status} ${body}`);
    }
  }

  async getAccessLinkForRoom(roomName: string): Promise<string | null> {
    const apiKey = process.env.DAILY_API_KEY;
    if (!apiKey) {
      throw new Error("DAILY_API_KEY is not set");
    }

    const listRes = await fetch(`${DAILY_API_BASE}/recordings?room_name=${encodeURIComponent(roomName)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!listRes.ok) {
      const body = await listRes.text().catch(() => "");
      throw new Error(`daily list recordings failed: ${listRes.status} ${body}`);
    }
    const listJson = (await listRes.json()) as { data: { id: string }[] };
    const recording = listJson.data[0];
    if (!recording) return null;

    const linkRes = await fetch(`${DAILY_API_BASE}/recordings/${encodeURIComponent(recording.id)}/access-link`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!linkRes.ok) {
      const body = await linkRes.text().catch(() => "");
      throw new Error(`daily get access-link failed: ${linkRes.status} ${body}`);
    }
    const linkJson = (await linkRes.json()) as { download_link: string };
    return linkJson.download_link;
  }
}

// deterministic in-memory fake for tests -- no network call, no real credential needed
export class FakeRecordingProvider implements RecordingProvider {
  recordings: RecordingInfo[] = [];
  deleteCalls: string[] = [];
  // test seam: room name -> access link this fake should report
  accessLinksByRoom = new Map<string, string>();

  async listRecordings(): Promise<RecordingInfo[]> {
    return this.recordings;
  }

  async deleteRecording(id: string): Promise<void> {
    this.deleteCalls.push(id);
    this.recordings = this.recordings.filter((r) => r.id !== id);
  }

  async getAccessLinkForRoom(roomName: string): Promise<string | null> {
    return this.accessLinksByRoom.get(roomName) ?? null;
  }
}
