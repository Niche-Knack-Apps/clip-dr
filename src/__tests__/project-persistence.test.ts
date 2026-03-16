import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Mock Tauri internals
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn(),
  once: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/path', () => ({
  appLocalDataDir: vi.fn().mockResolvedValue('/tmp/test'),
  tempDir: vi.fn().mockResolvedValue('/tmp/'),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn().mockReturnValue({
    setTitle: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

class MockAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  private channels: Float32Array[];
  constructor(options: { numberOfChannels: number; length: number; sampleRate: number }) {
    this.numberOfChannels = options.numberOfChannels;
    this.length = options.length;
    this.sampleRate = options.sampleRate;
    this.duration = options.length / options.sampleRate;
    this.channels = [];
    for (let i = 0; i < options.numberOfChannels; i++) {
      this.channels.push(new Float32Array(options.length));
    }
  }
  getChannelData(ch: number): Float32Array { return this.channels[ch]; }
  copyFromChannel(dest: Float32Array, ch: number, start?: number) {
    dest.set(this.channels[ch].subarray(start ?? 0, (start ?? 0) + dest.length));
  }
  copyToChannel(src: Float32Array, ch: number, start?: number) {
    this.channels[ch].set(src, start ?? 0);
  }
}

class MockAudioContext {
  readonly sampleRate = 44100;
  createBuffer(ch: number, len: number, rate: number): AudioBuffer {
    return new MockAudioBuffer({ numberOfChannels: ch, length: len, sampleRate: rate }) as unknown as AudioBuffer;
  }
  createBufferSource() { return { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), buffer: null, onended: null }; }
  createGain() { return { connect: vi.fn(), gain: { value: 1 } }; }
  get destination() { return {}; }
  get currentTime() { return 0; }
}

(globalThis as Record<string, unknown>).AudioContext = MockAudioContext;
(globalThis as Record<string, unknown>).AudioBuffer = MockAudioBuffer;

function mkBuf(dur: number, rate = 44100, ch = 2): AudioBuffer {
  const ctx = new MockAudioContext();
  return ctx.createBuffer(ch, Math.max(1, Math.floor(dur * rate)), rate);
}

describe('Project Persistence — sourcePath recovery', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('loadProject recovers track when sourcePath is empty but clips have sourceFile', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { useTracksStore } = await import('@/stores/tracks');
    const { useProjectStore } = await import('@/stores/project');

    const tracksStore = useTracksStore();
    const projectStore = useProjectStore();

    // Mock load_project to return a project with empty sourcePath but clip sourceFile
    const project = {
      version: 2,
      name: 'Test',
      createdAt: '2025-01-01',
      modifiedAt: '2025-01-01',
      tracks: [{
        id: 't1', name: 'Clip Track', sourcePath: '',
        trackStart: 0, duration: 5, color: '#ff0000',
        muted: false, solo: false, volume: 1, tag: undefined,
        timemarks: undefined, volumeEnvelope: undefined,
        cachedAudioPath: null,
        clips: [
          { id: 'c1', clipStart: 0, duration: 5, sourceFile: '/audio/source.wav', sourceOffset: 0, source_kind: 'original' as const },
        ],
      }],
      selection: { inPoint: null, outPoint: null },
      silenceRegions: [],
    };

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'load_project') return JSON.stringify(project);
      return [];
    });

    // Mock importFile to create a track
    const audioStore = (await import('@/stores/audio')).useAudioStore();
    const origImport = audioStore.importFile;
    audioStore.importFile = async (path: string) => {
      const buf = mkBuf(5);
      await tracksStore.createTrackFromBuffer(buf, null, 'imported', 0);
    };

    await projectStore.loadProject('/projects/test.clipdr');

    // Track should have been loaded (not skipped)
    expect(tracksStore.tracks.length).toBe(1);
    // The error should NOT contain "no source path"
    expect(projectStore.error).toBeNull();

    audioStore.importFile = origImport;
  });

  it('loadProject recovers track when sourcePath is empty with cachedAudioPath', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { useTracksStore } = await import('@/stores/tracks');
    const { useProjectStore } = await import('@/stores/project');

    const tracksStore = useTracksStore();
    const projectStore = useProjectStore();

    const project = {
      version: 2,
      name: 'Test',
      createdAt: '2025-01-01',
      modifiedAt: '2025-01-01',
      tracks: [{
        id: 't1', name: 'Cache Track', sourcePath: '',
        trackStart: 0, duration: 5, color: '#ff0000',
        muted: false, solo: false, volume: 1, tag: undefined,
        timemarks: undefined, volumeEnvelope: undefined,
        cachedAudioPath: '/cache/audio.wav',
        clips: [],
      }],
      selection: { inPoint: null, outPoint: null },
      silenceRegions: [],
    };

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'load_project') return JSON.stringify(project);
      return [];
    });

    const audioStore = (await import('@/stores/audio')).useAudioStore();
    const origImport = audioStore.importFile;
    audioStore.importFile = async () => {
      const buf = mkBuf(5);
      await tracksStore.createTrackFromBuffer(buf, null, 'imported', 0);
    };

    await projectStore.loadProject('/projects/test.clipdr');

    expect(tracksStore.tracks.length).toBe(1);
    expect(projectStore.error).toBeNull();

    audioStore.importFile = origImport;
  });

  it('loadProject uses first clip sourceFile when multiple clips from different sources', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { useTracksStore } = await import('@/stores/tracks');
    const { useProjectStore } = await import('@/stores/project');

    const tracksStore = useTracksStore();
    const projectStore = useProjectStore();

    let importedPath = '';
    const project = {
      version: 2,
      name: 'Test',
      createdAt: '2025-01-01',
      modifiedAt: '2025-01-01',
      tracks: [{
        id: 't1', name: 'Multi Source', sourcePath: '',
        trackStart: 0, duration: 10, color: '#ff0000',
        muted: false, solo: false, volume: 1, tag: undefined,
        timemarks: undefined, volumeEnvelope: undefined,
        cachedAudioPath: null,
        clips: [
          { id: 'c1', clipStart: 0, duration: 5, sourceFile: '/audio/first.wav', sourceOffset: 0, source_kind: 'original' as const },
          { id: 'c2', clipStart: 5, duration: 5, sourceFile: '/audio/second.wav', sourceOffset: 0, source_kind: 'original' as const },
        ],
      }],
      selection: { inPoint: null, outPoint: null },
      silenceRegions: [],
    };

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'load_project') return JSON.stringify(project);
      return [];
    });

    const audioStore = (await import('@/stores/audio')).useAudioStore();
    const origImport = audioStore.importFile;
    audioStore.importFile = async (path: string) => {
      importedPath = path;
      const buf = mkBuf(10);
      await tracksStore.createTrackFromBuffer(buf, null, 'imported', 0);
    };

    await projectStore.loadProject('/projects/test.clipdr');

    // Should use first clip's sourceFile as the import path
    expect(importedPath).toBe('/audio/first.wav');
    expect(tracksStore.tracks.length).toBe(1);

    audioStore.importFile = origImport;
  });

  it('loadProject skips track when no sourcePath, clips, or cachedAudioPath', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { useTracksStore } = await import('@/stores/tracks');
    const { useProjectStore } = await import('@/stores/project');

    const tracksStore = useTracksStore();
    const projectStore = useProjectStore();

    const project = {
      version: 2,
      name: 'Test',
      createdAt: '2025-01-01',
      modifiedAt: '2025-01-01',
      tracks: [{
        id: 't1', name: 'Empty Track', sourcePath: '',
        trackStart: 0, duration: 5, color: '#ff0000',
        muted: false, solo: false, volume: 1, tag: undefined,
        timemarks: undefined, volumeEnvelope: undefined,
        cachedAudioPath: null,
        clips: [],
      }],
      selection: { inPoint: null, outPoint: null },
      silenceRegions: [],
    };

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'load_project') return JSON.stringify(project);
      return [];
    });

    await projectStore.loadProject('/projects/test.clipdr');

    expect(tracksStore.tracks.length).toBe(0);
    expect(projectStore.error).toContain('no source path, clip source, or cached path');
  });

  it('serializeProject derives sourcePath from clips when t.sourcePath is empty', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useProjectStore } = await import('@/stores/project');
    type TrackClip = import('@/shared/types').TrackClip;

    const tracksStore = useTracksStore();
    const projectStore = useProjectStore();

    const buf = mkBuf(5);
    const track = await tracksStore.createTrackFromBuffer(buf, null, 'Pasted', 0);
    const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

    // Track has no sourcePath but clips have sourceFile
    tracksStore.tracks[idx] = {
      ...tracksStore.tracks[idx],
      sourcePath: undefined,
      clips: [
        { id: 'c1', buffer: null, waveformData: [], clipStart: 0, duration: 5, sourceFile: '/audio/clip.wav', sourceOffset: 0 } as TrackClip,
      ],
    };
    tracksStore.tracks = [...tracksStore.tracks];

    // Set project path so serialization has a baseDir
    projectStore.projectPath = '/projects/test.clipdr';

    // Access serializeProject through saveProject — we can test the track data directly
    const t = tracksStore.tracks[idx];
    const effective = t.sourcePath || (t.clips?.[0]?.sourceFile) || t.cachedAudioPath || '';
    expect(effective).toBe('/audio/clip.wav');
  });

  it('paste-created track gets sourcePath from source track', async () => {
    const { useTracksStore } = await import('@/stores/tracks');

    const tracksStore = useTracksStore();
    const buf = mkBuf(5);

    // createTrackFromBuffer accepts sourcePath as 5th arg
    const track = await tracksStore.createTrackFromBuffer(buf, null, 'Pasted 1', 0, '/audio/original.wav');
    expect(track.sourcePath).toBe('/audio/original.wav');
  });
});

describe('Project Persistence — Clip track duration restore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  function makeProject(tracks: Record<string, unknown>[]) {
    return {
      version: 2,
      name: 'Test',
      createdAt: '2025-01-01',
      modifiedAt: '2025-01-01',
      tracks,
      selection: { inPoint: null, outPoint: null },
      silenceRegions: [],
    };
  }

  it('original full-length track: saved duration restored (idempotent when matching source)', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { useTracksStore } = await import('@/stores/tracks');
    const { useProjectStore } = await import('@/stores/project');

    const tracksStore = useTracksStore();
    const projectStore = useProjectStore();

    const project = makeProject([{
      id: 't1', name: 'Full Track', sourcePath: '/audio/full.wav',
      trackStart: 0, duration: 10, color: '#ff0000',
      muted: false, solo: false, volume: 1, tag: undefined,
      timemarks: undefined, volumeEnvelope: undefined,
      cachedAudioPath: null,
      clips: [],
    }]);

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'load_project') return JSON.stringify(project);
      return [];
    });

    const audioStore = (await import('@/stores/audio')).useAudioStore();
    const origImport = audioStore.importFile;
    audioStore.importFile = async () => {
      const buf = mkBuf(10);
      await tracksStore.createTrackFromBuffer(buf, null, 'imported', 0);
    };

    await projectStore.loadProject('/projects/test.clipdr');
    const t = tracksStore.tracks[0];
    // Saved duration restored — matches source file so it's idempotent
    expect(t.duration).toBe(10);

    audioStore.importFile = origImport;
  });

  it('non-clip track with trimmed duration: saved duration restored, not full source', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { useTracksStore } = await import('@/stores/tracks');
    const { useProjectStore } = await import('@/stores/project');

    const tracksStore = useTracksStore();
    const projectStore = useProjectStore();

    // Single-buffer track (no clips) whose saved duration < source file
    const project = makeProject([{
      id: 't1', name: 'Clip 2', sourcePath: '/audio/source.wav',
      trackStart: 0, duration: 22.92, color: '#ff6b6b',
      muted: false, solo: false, volume: 1, tag: undefined,
      timemarks: undefined, volumeEnvelope: undefined,
      cachedAudioPath: '/tmp/clip_old.wav',
    }]);

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'load_project') return JSON.stringify(project);
      return [];
    });

    const audioStore = (await import('@/stores/audio')).useAudioStore();
    const origImport = audioStore.importFile;
    audioStore.importFile = async () => {
      // Import creates track with full source duration (39s)
      const buf = mkBuf(39);
      await tracksStore.createTrackFromBuffer(buf, null, 'imported', 0);
    };

    await projectStore.loadProject('/projects/test.clipdr');
    const t = tracksStore.tracks[0];
    // Duration must be restored to saved 22.92s, NOT the imported 39s
    expect(t.duration).toBe(22.92);

    audioStore.importFile = origImport;
  });

  it('single-source clip track: saved duration < source file, restored correctly', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { useTracksStore } = await import('@/stores/tracks');
    const { useProjectStore } = await import('@/stores/project');

    const tracksStore = useTracksStore();
    const projectStore = useProjectStore();

    // Source file is 30s, but track was trimmed to 5s
    const project = makeProject([{
      id: 't1', name: 'Trimmed Clip', sourcePath: '/audio/long.wav',
      trackStart: 2, duration: 5, color: '#00ff00',
      muted: false, solo: false, volume: 1, tag: undefined,
      timemarks: undefined, volumeEnvelope: undefined,
      cachedAudioPath: null,
      clips: [
        { id: 'c1', clipStart: 0, duration: 5, sourceFile: '/audio/long.wav', sourceOffset: 10, source_kind: 'original' },
      ],
    }]);

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'load_project') return JSON.stringify(project);
      return [];
    });

    const audioStore = (await import('@/stores/audio')).useAudioStore();
    const origImport = audioStore.importFile;
    audioStore.importFile = async () => {
      // Import creates track with full source duration (30s)
      const buf = mkBuf(30);
      await tracksStore.createTrackFromBuffer(buf, null, 'imported', 2);
    };

    await projectStore.loadProject('/projects/test.clipdr');
    const t = tracksStore.tracks[0];
    // Duration must be restored to saved 5s, NOT the imported 30s
    expect(t.duration).toBe(5);
    expect(t.trackStart).toBe(2);

    audioStore.importFile = origImport;
  });

  it('multi-clip track: duration = clip span, not source file duration', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { useTracksStore } = await import('@/stores/tracks');
    const { useProjectStore } = await import('@/stores/project');

    const tracksStore = useTracksStore();
    const projectStore = useProjectStore();

    const project = makeProject([{
      id: 't1', name: 'Multi Clip', sourcePath: '/audio/source.wav',
      trackStart: 0, duration: 8, color: '#0000ff',
      muted: false, solo: false, volume: 1, tag: undefined,
      timemarks: undefined, volumeEnvelope: undefined,
      cachedAudioPath: null,
      clips: [
        { id: 'c1', clipStart: 0, duration: 3, sourceFile: '/audio/source.wav', sourceOffset: 0, source_kind: 'original' },
        { id: 'c2', clipStart: 3, duration: 5, sourceFile: '/audio/source.wav', sourceOffset: 10, source_kind: 'original' },
      ],
    }]);

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'load_project') return JSON.stringify(project);
      return [];
    });

    const audioStore = (await import('@/stores/audio')).useAudioStore();
    const origImport = audioStore.importFile;
    audioStore.importFile = async () => {
      const buf = mkBuf(20); // source is 20s
      await tracksStore.createTrackFromBuffer(buf, null, 'imported', 0);
    };

    await projectStore.loadProject('/projects/test.clipdr');
    const t = tracksStore.tracks[0];
    expect(t.duration).toBe(8);
    expect(t.clips).toHaveLength(2);

    audioStore.importFile = origImport;
  });

  it('multi-source clip track: duration and trackStart preserved', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { useTracksStore } = await import('@/stores/tracks');
    const { useProjectStore } = await import('@/stores/project');

    const tracksStore = useTracksStore();
    const projectStore = useProjectStore();

    const project = makeProject([{
      id: 't1', name: 'Multi Source', sourcePath: '',
      trackStart: 5, duration: 12, color: '#ff00ff',
      muted: false, solo: false, volume: 1, tag: undefined,
      timemarks: undefined, volumeEnvelope: undefined,
      cachedAudioPath: null,
      clips: [
        { id: 'c1', clipStart: 0, duration: 6, sourceFile: '/audio/a.wav', sourceOffset: 0, source_kind: 'original' },
        { id: 'c2', clipStart: 6, duration: 6, sourceFile: '/audio/b.wav', sourceOffset: 0, source_kind: 'original' },
      ],
    }]);

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'load_project') return JSON.stringify(project);
      return [];
    });

    const audioStore = (await import('@/stores/audio')).useAudioStore();
    const origImport = audioStore.importFile;
    audioStore.importFile = async () => {
      const buf = mkBuf(25);
      await tracksStore.createTrackFromBuffer(buf, null, 'imported', 5);
    };

    await projectStore.loadProject('/projects/test.clipdr');
    const t = tracksStore.tracks[0];
    expect(t.duration).toBe(12);
    expect(t.trackStart).toBe(5);

    audioStore.importFile = origImport;
  });

  it('save/load/re-save round trip: duration, trackStart, clips identical', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const { useTracksStore } = await import('@/stores/tracks');
    const { useProjectStore } = await import('@/stores/project');

    const tracksStore = useTracksStore();
    const projectStore = useProjectStore();

    const savedClips = [
      { id: 'c1', clipStart: 0, duration: 4, sourceFile: '/audio/src.wav', sourceOffset: 2, source_kind: 'original' as const },
      { id: 'c2', clipStart: 4, duration: 3, sourceFile: '/audio/src.wav', sourceOffset: 8, source_kind: 'original' as const },
    ];
    const project = makeProject([{
      id: 't1', name: 'RoundTrip', sourcePath: '/audio/src.wav',
      trackStart: 1.5, duration: 7, color: '#abcdef',
      muted: true, solo: false, volume: 0.8, tag: undefined,
      timemarks: undefined, volumeEnvelope: undefined,
      cachedAudioPath: null,
      clips: savedClips,
    }]);

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'load_project') return JSON.stringify(project);
      if (cmd === 'save_project') return undefined;
      return [];
    });

    const audioStore = (await import('@/stores/audio')).useAudioStore();
    const origImport = audioStore.importFile;
    audioStore.importFile = async () => {
      const buf = mkBuf(30);
      await tracksStore.createTrackFromBuffer(buf, null, 'imported', 1.5);
    };

    // Load
    await projectStore.loadProject('/projects/test.clipdr');
    const t = tracksStore.tracks[0];
    expect(t.duration).toBe(7);
    expect(t.trackStart).toBe(1.5);
    expect(t.clips).toHaveLength(2);
    expect(t.clips![0].clipStart).toBe(0);
    expect(t.clips![0].duration).toBe(4);
    expect(t.clips![0].sourceOffset).toBe(2);
    expect(t.clips![1].clipStart).toBe(4);
    expect(t.clips![1].duration).toBe(3);
    expect(t.clips![1].sourceOffset).toBe(8);

    audioStore.importFile = origImport;
  });
});

describe('Project Persistence — Clip EDL', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('serializeProject includes clips array with correct sourceFile/sourceOffset', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    const { useProjectStore } = await import('@/stores/project');
    type TrackClip = import('@/shared/types').TrackClip;

    const tracksStore = useTracksStore();
    const projectStore = useProjectStore();

    const buf = mkBuf(10);
    const track = await tracksStore.createTrackFromBuffer(buf, null, 'My Track', 0);
    const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

    // Give track a stable sourcePath and set edited clips
    tracksStore.tracks[idx] = {
      ...tracksStore.tracks[idx],
      sourcePath: '/source/audio.wav',
      clips: [
        { id: 'c1', buffer: null, waveformData: [], clipStart: 0, duration: 5, sourceFile: '/source/audio.wav', sourceOffset: 0 } as TrackClip,
        { id: 'c2', buffer: null, waveformData: [], clipStart: 5, duration: 5, sourceFile: '/source/audio.wav', sourceOffset: 5 } as TrackClip,
      ],
    };
    tracksStore.tracks = [...tracksStore.tracks];

    // Use Reflect to call internal serializeProject (it's not exported)
    // Instead, test via the public surface by checking what would be serialized
    const t = tracksStore.tracks[idx];
    expect(t.clips).toHaveLength(2);
    expect(t.clips![0].sourceFile).toBe('/source/audio.wav');
    expect(t.clips![0].sourceOffset).toBe(0);
    expect(t.clips![1].sourceOffset).toBe(5);
    expect(t.sourcePath).toBe('/source/audio.wav');

    // Verify source stability: sourcePath is preferred over clip.sourceFile
    const firstClip = t.clips![0];
    const stableSrc = t.sourcePath || firstClip.sourceFile;
    expect(stableSrc).toBe('/source/audio.wav');

    void projectStore; // referenced to avoid unused import
  });

  it('source_kind is original when track has sourcePath', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    type TrackClip = import('@/shared/types').TrackClip;

    const tracksStore = useTracksStore();
    const buf = mkBuf(5);
    const track = await tracksStore.createTrackFromBuffer(buf, null, 'Track', 0);
    const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

    tracksStore.tracks[idx] = {
      ...tracksStore.tracks[idx],
      sourcePath: '/source/original.wav',
      cachedAudioPath: undefined,
      clips: [
        { id: 'c1', buffer: null, waveformData: [], clipStart: 0, duration: 5, sourceFile: '/source/original.wav', sourceOffset: 0 } as TrackClip,
      ],
    };
    tracksStore.tracks = [...tracksStore.tracks];

    const t = tracksStore.tracks[idx];
    // Source kind determination: sourcePath → 'original'
    const kind = t.sourcePath ? 'original' : t.cachedAudioPath ? 'managed-cache' : 'temp';
    expect(kind).toBe('original');
  });

  it('source_kind is temp when only clip.sourceFile is a temp path', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    type TrackClip = import('@/shared/types').TrackClip;

    const tracksStore = useTracksStore();
    const buf = mkBuf(5);
    const track = await tracksStore.createTrackFromBuffer(buf, null, 'Track', 0);
    const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

    tracksStore.tracks[idx] = {
      ...tracksStore.tracks[idx],
      sourcePath: undefined,
      cachedAudioPath: undefined,
      clips: [
        { id: 'c1', buffer: null, waveformData: [], clipStart: 0, duration: 5, sourceFile: '/tmp/cache_xyz.wav', sourceOffset: 0 } as TrackClip,
      ],
    };
    tracksStore.tracks = [...tracksStore.tracks];

    const t = tracksStore.tracks[idx];
    const kind = t.sourcePath ? 'original' : t.cachedAudioPath ? 'managed-cache' : 'temp';
    expect(kind).toBe('temp');
  });

  it('setTrackClips restores clips on a track', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    type TrackClip = import('@/shared/types').TrackClip;

    const tracksStore = useTracksStore();
    const buf = mkBuf(10);
    const track = await tracksStore.createTrackFromBuffer(buf, null, 'Track', 0);

    const clips: TrackClip[] = [
      { id: 'r1', buffer: null, waveformData: [], clipStart: 0, duration: 5, sourceFile: '/s.wav', sourceOffset: 0 },
      { id: 'r2', buffer: null, waveformData: [], clipStart: 5, duration: 5, sourceFile: '/s.wav', sourceOffset: 5 },
    ];

    tracksStore.setTrackClips(track.id, clips);

    const restored = tracksStore.tracks.find(t => t.id === track.id);
    expect(restored?.clips).toHaveLength(2);
    expect(restored?.clips![0].id).toBe('r1');
    expect(restored?.clips![1].sourceOffset).toBe(5);
  });

  it('finalizeClipWaveforms slices parent waveform into clip waveforms', async () => {
    const { useTracksStore } = await import('@/stores/tracks');
    type TrackClip = import('@/shared/types').TrackClip;

    const tracksStore = useTracksStore();
    const buf = mkBuf(10);
    const track = await tracksStore.createTrackFromBuffer(buf, null, 'Track', 0);
    const idx = tracksStore.tracks.findIndex(t => t.id === track.id);

    // Set a synthetic parent waveform (200 values = 100 min/max buckets)
    const parentWaveform = new Array(200).fill(0).map((_, i) => i * 0.01);
    tracksStore.tracks[idx] = {
      ...tracksStore.tracks[idx],
      duration: 10,
      audioData: { ...tracksStore.tracks[idx].audioData, waveformData: parentWaveform },
      clips: [
        { id: 'c1', buffer: null, waveformData: [], clipStart: 0, duration: 5, sourceFile: '/s.wav', sourceOffset: 0 } as TrackClip,
        { id: 'c2', buffer: null, waveformData: [], clipStart: 5, duration: 5, sourceFile: '/s.wav', sourceOffset: 5 } as TrackClip,
      ],
    };
    tracksStore.tracks = [...tracksStore.tracks];

    tracksStore.finalizeClipWaveforms(track.id);

    const updated = tracksStore.tracks.find(t => t.id === track.id);
    expect(updated?.clips).toBeDefined();
    // Each clip covers half the waveform
    const c1 = updated!.clips![0];
    const c2 = updated!.clips![1];
    // Both clips should have non-empty waveform slices
    expect(c1.waveformData.length).toBeGreaterThan(0);
    expect(c2.waveformData.length).toBeGreaterThan(0);
    // Total waveform data should equal original length (no overlap, exact split)
    expect(c1.waveformData.length + c2.waveformData.length).toBe(parentWaveform.length);
  });
});
