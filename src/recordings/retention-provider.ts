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
}

// deterministic in-memory fake for tests -- no network call, no real credential needed
export class FakeRecordingProvider implements RecordingProvider {
  recordings: RecordingInfo[] = [];
  deleteCalls: string[] = [];

  async listRecordings(): Promise<RecordingInfo[]> {
    return this.recordings;
  }

  async deleteRecording(id: string): Promise<void> {
    this.deleteCalls.push(id);
    this.recordings = this.recordings.filter((r) => r.id !== id);
  }
}
