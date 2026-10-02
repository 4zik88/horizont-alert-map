import {
  HISTORY_MS,
  type Alert,
  type DomainEvent,
  type ServerMessage,
  type Snapshot,
  type SourceStatus,
  type Track,
} from '@horizont/contract';

/**
 * The live state, as a pure reducer over snapshots and events. No DOM, no clock:
 * every function takes `now` when it needs one, so the tests can drive it.
 */
export interface LiveState {
  /** Last applied event seq. 0 for history views. */
  seq: number;
  /** Time of the newest data we hold (snapshot `at` or the latest event `at`). */
  at: number;
  alerts: Map<number, Alert>;
  tracks: Map<number, Track>;
  sources: Map<string, SourceStatus>;
}

export function emptyState(): LiveState {
  return { seq: 0, at: 0, alerts: new Map(), tracks: new Map(), sources: new Map() };
}

export function fromSnapshot(s: Snapshot): LiveState {
  return {
    seq: s.seq,
    at: s.at,
    alerts: new Map(s.alerts.filter((a) => a.endedAt === null).map((a) => [a.id, a])),
    tracks: new Map(s.tracks.map((t) => [t.id, t])),
    sources: new Map(s.sources.map((x) => [x.source, x])),
  };
}

export function toSnapshot(state: LiveState): Snapshot {
  return {
    seq: state.seq,
    at: state.at,
    alerts: [...state.alerts.values()],
    tracks: [...state.tracks.values()],
    sources: [...state.sources.values()],
  };
}

/** Apply one domain event. Returns a new state; the input is not mutated. */
export function applyEvent(state: LiveState, e: DomainEvent): LiveState {
  switch (e.type) {
    case 'alert.started': {
      const alerts = new Map(state.alerts);
      if (e.alert.endedAt === null) alerts.set(e.alert.id, e.alert);
      else alerts.delete(e.alert.id);
      return { ...state, alerts };
    }
    case 'alert.ended': {
      // The live view only shows open alerts, so an ended one simply leaves it.
      if (!state.alerts.has(e.alertId)) return state;
      const alerts = new Map(state.alerts);
      alerts.delete(e.alertId);
      return { ...state, alerts };
    }
    case 'track.observed': {
      const tracks = new Map(state.tracks);
      tracks.set(e.track.id, e.track);
      return { ...state, tracks };
    }
    case 'track.revised': {
      const tracks = new Map(state.tracks);
      if (e.track === null) tracks.delete(e.trackId);
      else {
        if (e.track.id !== e.trackId) tracks.delete(e.trackId);
        tracks.set(e.track.id, e.track);
      }
      return { ...state, tracks };
    }
    case 'source.status': {
      const sources = new Map(state.sources);
      sources.set(e.source.source, e.source);
      return { ...state, sources };
    }
  }
}

export type Reduction =
  | { kind: 'applied'; state: LiveState }
  /** Duplicate or old event: nothing to do. */
  | { kind: 'ignored'; state: LiveState }
  /** Seq skipped: the caller must send `resume` with `state.seq`. */
  | { kind: 'gap'; state: LiveState }
  | { kind: 'pong'; state: LiveState };

/** Fold one server frame into the state, detecting gaps in the event sequence. */
export function reduce(state: LiveState, msg: ServerMessage): Reduction {
  switch (msg.t) {
    case 'pong':
      return { kind: 'pong', state };
    case 'snapshot': {
      const { t: _t, ...snap } = msg;
      return { kind: 'applied', state: fromSnapshot(snap) };
    }
    case 'event': {
      if (msg.seq <= state.seq) return { kind: 'ignored', state };
      if (msg.seq !== state.seq + 1) return { kind: 'gap', state };
      const next = applyEvent(state, msg.e);
      return { kind: 'applied', state: { ...next, seq: msg.seq, at: Math.max(state.at, msg.at) } };
    }
  }
}

/** Drop tracks the live map no longer reaches back to. */
export function prune(state: LiveState, now: number): LiveState {
  let changed = false;
  const tracks = new Map(state.tracks);
  for (const [id, t] of tracks) {
    if (t.lastSeenAt < now - HISTORY_MS) {
      tracks.delete(id);
      changed = true;
    }
  }
  return changed ? { ...state, tracks } : state;
}

/** What the map draws: open alerts and tracks seen within the history window. */
export interface View {
  at: number;
  alerts: Alert[];
  tracks: Track[];
  sources: SourceStatus[];
}

export function liveView(state: LiveState, now: number): View {
  return {
    at: state.at,
    alerts: [...state.alerts.values()].filter((a) => a.endedAt === null),
    tracks: [...state.tracks.values()].filter((t) => t.lastSeenAt >= now - HISTORY_MS),
    sources: [...state.sources.values()],
  };
}

export function snapshotView(s: Snapshot): View {
  return liveView(fromSnapshot(s), s.at);
}
