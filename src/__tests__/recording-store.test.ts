import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Mock Tauri internals that stores depend on
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn(),
  once: vi.fn().mockResolvedValue(() => {}),
}));

// Mock @tauri-apps/plugin-dialog
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

// Mock @tauri-apps/plugin-fs
vi.mock('@tauri-apps/plugin-fs', () => ({
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

// Mock @tauri-apps/api/path
vi.mock('@tauri-apps/api/path', () => ({
  appLocalDataDir: vi.fn().mockResolvedValue('/tmp/test'),
}));

// Suppress console.error for expected localStorage warnings in settings store
vi.spyOn(console, 'error').mockImplementation(() => {});

import type { AudioDevice } from '@/stores/recording';

describe('Recording Store - Device Filtering', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  const mockDevices: AudioDevice[] = [
    { id: 'hw:0,0', name: 'Built-in Mic', is_default: true, is_input: true, is_loopback: false, is_output: false, device_type: 'microphone', channels: 2, sample_rates: [44100, 48000], platform_id: 'hw:0,0' },
    { id: 'hw:1,0', name: 'USB Mic', is_default: false, is_input: true, is_loopback: false, is_output: false, device_type: 'microphone', channels: 1, sample_rates: [48000], platform_id: 'hw:1,0' },
    { id: 'alsa_output.monitor', name: 'Monitor of Built-in', is_default: false, is_input: true, is_loopback: true, is_output: false, device_type: 'loopback', channels: 2, sample_rates: [44100, 48000], platform_id: 'alsa_output.monitor' },
    { id: 'stereo_mix', name: 'Stereo Mix', is_default: false, is_input: true, is_loopback: true, is_output: false, device_type: 'loopback', channels: 2, sample_rates: [44100], platform_id: 'stereo_mix' },
  ];

  it('microphoneDevices filters out loopback devices', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    store.devices = mockDevices;

    expect(store.microphoneDevices).toHaveLength(2);
    expect(store.microphoneDevices.every(d => !d.is_loopback)).toBe(true);
    expect(store.microphoneDevices.map(d => d.name)).toEqual(['Built-in Mic', 'USB Mic']);
  });

  it('loopbackDevices returns only loopback devices', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    store.devices = mockDevices;

    expect(store.loopbackDevices).toHaveLength(2);
    expect(store.loopbackDevices.every(d => d.is_loopback)).toBe(true);
  });

  it('selectedDevice returns null when no device selected', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    store.devices = mockDevices;
    store.selectedDeviceId = null;

    expect(store.selectedDevice).toBeNull();
  });

  it('selectedDevice returns matching device', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    store.devices = mockDevices;
    store.selectedDeviceId = 'hw:1,0';

    expect(store.selectedDevice).not.toBeNull();
    expect(store.selectedDevice!.name).toBe('USB Mic');
  });

  it('defaultDevice returns first default device', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    store.devices = mockDevices;

    expect(store.defaultDevice).not.toBeNull();
    expect(store.defaultDevice!.name).toBe('Built-in Mic');
  });

  it('defaultDevice falls back to first device when no default', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    const noDefaultDevices = mockDevices.map(d => ({ ...d, is_default: false }));
    store.devices = noDefaultDevices;

    expect(store.defaultDevice).not.toBeNull();
    expect(store.defaultDevice!.name).toBe('Built-in Mic');
  });

  it('selectDevice updates selectedDeviceId', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    store.devices = mockDevices;
    store.selectDevice('stereo_mix');

    expect(store.selectedDeviceId).toBe('stereo_mix');
  });
});

describe('Recording Store - Timemark CRUD', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('addTimemark does nothing when not recording', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    store.addTimemark('Test Mark');
    expect(store.timemarks).toHaveLength(0);
  });

  it('addTimemark adds a mark when recording', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    // Simulate recording state
    store.isRecording = true;
    store.recordingDuration = 5.5;

    store.addTimemark('My Mark');

    expect(store.timemarks).toHaveLength(1);
    expect(store.timemarks[0].label).toBe('My Mark');
    expect(store.timemarks[0].time).toBe(5.5);
    expect(store.timemarks[0].source).toBe('manual');
    expect(store.timemarks[0].color).toBe('#00d4ff');
  });

  it('addTimemark auto-generates label', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    store.isRecording = true;
    store.recordingDuration = 1.0;
    store.addTimemark();

    expect(store.timemarks[0].label).toMatch(/^Mark \d+$/);
  });

  it('addTimemark with auto source gets yellow color', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    store.isRecording = true;
    store.recordingDuration = 2.0;
    store.addTimemark('Auto Mark', 'auto');

    expect(store.timemarks[0].source).toBe('auto');
    expect(store.timemarks[0].color).toBe('#fbbf24');
  });

  it('addTimemark with custom time', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    store.isRecording = true;
    store.recordingDuration = 10.0;
    store.addTimemark('At 3s', 'manual', 3.0);

    expect(store.timemarks[0].time).toBe(3.0);
  });

  it('removeTimemark removes by id', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    store.isRecording = true;
    store.recordingDuration = 1.0;

    store.addTimemark('First');
    store.addTimemark('Second');
    store.addTimemark('Third');

    expect(store.timemarks).toHaveLength(3);

    const secondId = store.timemarks[1].id;
    store.removeTimemark(secondId);

    expect(store.timemarks).toHaveLength(2);
    expect(store.timemarks.map(m => m.label)).toEqual(['First', 'Third']);
  });

  it('clearTimemarks removes all', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    store.isRecording = true;
    store.recordingDuration = 1.0;
    store.addTimemark('A');
    store.addTimemark('B');

    store.clearTimemarks();
    expect(store.timemarks).toHaveLength(0);
  });

  it('setTriggerPhrases updates phrases', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    store.setTriggerPhrases(['hello', 'world']);
    expect(store.triggerPhrases).toEqual(['hello', 'world']);
  });
});

describe('Recording Store - State Management', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('lockRecording only works when recording', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    store.lockRecording();
    expect(store.isLocked).toBe(false);

    store.isRecording = true;
    store.lockRecording();
    expect(store.isLocked).toBe(true);
  });

  it('unlockRecording clears lock', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    store.isRecording = true;
    store.lockRecording();
    expect(store.isLocked).toBe(true);

    store.unlockRecording();
    expect(store.isLocked).toBe(false);
  });

  it('setPlacement updates placement', async () => {
    const { useRecordingStore } = await import('@/stores/recording');
    const store = useRecordingStore();

    expect(store.placement).toBe('append');
    store.setPlacement('playhead');
    expect(store.placement).toBe('playhead');
  });
});
