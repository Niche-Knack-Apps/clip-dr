import { onMounted, onUnmounted } from 'vue';
import { KEYBOARD_SHORTCUTS } from '@/shared/constants';
import type { LoopMode } from '@/shared/constants';
import { useRecordingStore } from '@/stores/recording';

export interface KeyboardActions {
  onPlayPause?: () => void;
  onSetIn?: () => void;
  onSetOut?: () => void;
  onCreateClip?: () => void;
  onJumpStart?: () => void;
  onJumpEnd?: () => void;
  onJumpIn?: () => void;
  onJumpOut?: () => void;
  onDeleteTrack?: () => void;
  onFocusSearch?: () => void;
  // New actions
  onJumpLayerEnd?: () => void;
  // Split & trim actions
  onSplit?: () => void;
  onTrimStart?: () => void;
  onTrimEnd?: () => void;
  onSpeedUp?: () => void;
  onSpeedDown?: () => void;
  onNudge?: (ms: number) => void;
  // JKL playback actions
  onJklPlay?: (speed: number, reverse: boolean) => void;
  onJklStop?: () => void;
  // Clipboard actions (Ctrl+X/C/V)
  onCut?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  // Direct shortcuts (no Ctrl modifier)
  onCutDirect?: () => void;
  onPasteDirect?: () => void;
  onDeleteDirect?: () => void;
  // Zoom shortcuts (+/-)
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  // Track selection cycling (Tab/Shift+Tab)
  onSelectNextTrack?: () => void;
  onSelectPrevTrack?: () => void;
  // Undo/Redo (Ctrl+Z / Ctrl+Shift+Z)
  onUndo?: () => void;
  onRedo?: () => void;
  // Marker navigation
  onNextMarker?: () => void;
  onPreviousMarker?: () => void;
  // Add marker (recording timemark or at playhead)
  onAddTimemark?: () => void;
  // Quick Re-Export (Ctrl+Shift+E)
  onQuickExport?: () => void;
  // Loop mode shortcuts (Q/W/E/R/T)
  onSetLoopMode?: (mode: LoopMode) => void;
  // Project save/open/new
  onSaveProject?: () => void;
  onOpenProject?: () => void;
  onNewProject?: () => void;
  // Help modal
  onShowHelp?: () => void;
}

export function useKeyboardShortcuts(actions: KeyboardActions) {
  // Track all held keys for multi-key detection
  const heldKeys = new Set<string>();

  // Track if JKL playback is active
  let jklActive = false;

  // Busy guard: prevent key-repeat from firing edit ops faster than they complete (UI-05)
  let editBusy = false;
  async function guardedEditAction(fn: (() => void) | (() => Promise<unknown>) | undefined): Promise<void> {
    if (!fn || editBusy) return;
    editBusy = true;
    try { await fn(); } finally { editBusy = false; }
  }

  // Calculate JKL speed based on held keys
  function calculateJklSpeed(): { speed: number; reverse: boolean } | null {
    const hasL = heldKeys.has('l') || heldKeys.has('L') || heldKeys.has('ArrowRight');
    const hasJ = heldKeys.has('j') || heldKeys.has('J') || heldKeys.has('ArrowLeft');
    const hasK = heldKeys.has('k') || heldKeys.has('K');
    const hasShift = heldKeys.has('Shift');

    if (hasL && !hasJ) {
      // Forward playback
      if (hasK) return { speed: 2, reverse: false };
      if (hasShift) return { speed: 0.5, reverse: false };
      return { speed: 1, reverse: false };
    }

    if (hasJ && !hasL) {
      // Reverse playback
      if (hasK) return { speed: 2, reverse: true };
      if (hasShift) return { speed: 0.5, reverse: true };
      return { speed: 1, reverse: true };
    }

    return null; // No valid combination (or conflicting J+L)
  }

  // Update JKL playback state
  function updateJklPlayback(): void {
    const result = calculateJklSpeed();

    if (result) {
      // Start or update JKL playback
      jklActive = true;
      actions.onJklPlay?.(result.speed, result.reverse);
    } else if (jklActive) {
      // Stop JKL playback
      jklActive = false;
      actions.onJklStop?.();
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement
    ) {
      if (event.key === 'Escape') {
        (event.target as HTMLElement).blur();
      }
      return;
    }

    const isCtrlOrCmd = event.ctrlKey || event.metaKey;

    // Handle Ctrl+X/C/V for clipboard
    if (isCtrlOrCmd) {
      switch (event.key.toLowerCase()) {
        case 'x':
          event.preventDefault();
          console.log('[Keyboard] Ctrl+X (cut)');
          guardedEditAction(actions.onCut);
          return;
        case 'c':
          event.preventDefault();
          console.log('[Keyboard] Ctrl+C (copy)');
          guardedEditAction(actions.onCopy);
          return;
        case 'v':
          event.preventDefault();
          console.log('[Keyboard] Ctrl+V (paste)');
          guardedEditAction(actions.onPaste);
          return;
        case 'z':
          event.preventDefault();
          if (event.shiftKey) {
            console.log('[Keyboard] Ctrl+Shift+Z (redo)');
            guardedEditAction(actions.onRedo);
          } else {
            console.log('[Keyboard] Ctrl+Z (undo)');
            guardedEditAction(actions.onUndo);
          }
          return;
        case 'e':
          if (event.shiftKey) {
            event.preventDefault();
            console.log('[Keyboard] Ctrl+Shift+E (quick re-export)');
            actions.onQuickExport?.();
          }
          return;
        case 's':
          event.preventDefault();
          console.log('[Keyboard] Ctrl+S (save project)');
          actions.onSaveProject?.();
          return;
        case 'o':
          event.preventDefault();
          console.log('[Keyboard] Ctrl+O (open project)');
          actions.onOpenProject?.();
          return;
        case 'n':
          event.preventDefault();
          console.log('[Keyboard] Ctrl+N (new project)');
          actions.onNewProject?.();
          return;
      }
    }

    // Handle number keys 1-9 for nudge
    if (!isCtrlOrCmd && !event.shiftKey && !event.altKey) {
      const num = parseInt(event.key, 10);
      if (num >= 1 && num <= 9) {
        event.preventDefault();
        actions.onNudge?.(num * 10); // 10ms per number
        return;
      }
    }

    // Track held keys for JKL controls (including modifiers)
    const key = event.key;
    if (!heldKeys.has(key)) {
      heldKeys.add(key);

      // Check if this is a JKL-related key
      const jklKeys = ['j', 'J', 'k', 'K', 'l', 'L', 'ArrowLeft', 'ArrowRight', 'Shift'];
      if (jklKeys.includes(key)) {
        event.preventDefault();
        updateJklPlayback();
        return;
      }
    }

    // ? for help modal (Shift+/ on most keyboards)
    if (event.key === '?') {
      event.preventDefault();
      actions.onShowHelp?.();
      return;
    }

    // Tab / Shift+Tab for track selection cycling
    if (event.key === 'Tab') {
      event.preventDefault();
      if (event.shiftKey) {
        actions.onSelectPrevTrack?.();
      } else {
        actions.onSelectNextTrack?.();
      }
      return;
    }

    // +/- for zoom (Shift+= produces '+', - is literal)
    if (event.key === '+' || (event.key === '=' && event.shiftKey)) {
      event.preventDefault();
      actions.onZoomIn?.();
      return;
    }
    if (event.key === '-' && !isCtrlOrCmd) {
      event.preventDefault();
      actions.onZoomOut?.();
      return;
    }

    switch (event.key) {
      case KEYBOARD_SHORTCUTS.PLAY_PAUSE: {
        event.preventDefault();
        // Block spacebar stop when recording is locked
        const recStore = useRecordingStore();
        if (recStore.isRecording && recStore.isLocked) {
          return;
        }
        actions.onPlayPause?.();
        break;
      }

      case KEYBOARD_SHORTCUTS.SET_IN:
        if (!isCtrlOrCmd) {
          event.preventDefault();
          actions.onSetIn?.();
        }
        break;

      case KEYBOARD_SHORTCUTS.SET_OUT:
        if (!isCtrlOrCmd) {
          event.preventDefault();
          actions.onSetOut?.();
        }
        break;

      case KEYBOARD_SHORTCUTS.CREATE_CLIP:
        if (!isCtrlOrCmd) {
          event.preventDefault();
          actions.onCreateClip?.();
        }
        break;

      case KEYBOARD_SHORTCUTS.JUMP_START:
        event.preventDefault();
        actions.onJumpStart?.();
        break;

      case KEYBOARD_SHORTCUTS.JUMP_END:
        event.preventDefault();
        actions.onJumpEnd?.();
        break;

      case KEYBOARD_SHORTCUTS.JUMP_IN:
        event.preventDefault();
        actions.onJumpIn?.();
        break;

      case KEYBOARD_SHORTCUTS.JUMP_OUT:
        event.preventDefault();
        actions.onJumpOut?.();
        break;

      case KEYBOARD_SHORTCUTS.DELETE_TRACK:
        event.preventDefault();
        actions.onDeleteTrack?.();
        break;

      case KEYBOARD_SHORTCUTS.FOCUS_SEARCH:
        if (isCtrlOrCmd) {
          event.preventDefault();
          actions.onFocusSearch?.();
        }
        break;

      // Split & trim shortcuts
      case KEYBOARD_SHORTCUTS.SPLIT:
      case 'S':
        if (!isCtrlOrCmd) {
          event.preventDefault();
          guardedEditAction(actions.onSplit);
        }
        break;

      case KEYBOARD_SHORTCUTS.TRIM_START:
      case 'Y':
        if (!isCtrlOrCmd) {
          event.preventDefault();
          guardedEditAction(actions.onTrimStart);
        }
        break;

      case KEYBOARD_SHORTCUTS.TRIM_END:
      case 'U':
        if (!isCtrlOrCmd) {
          event.preventDefault();
          guardedEditAction(actions.onTrimEnd);
        }
        break;

      case KEYBOARD_SHORTCUTS.JUMP_LAYER_END:
        if (!isCtrlOrCmd) {
          event.preventDefault();
          actions.onJumpLayerEnd?.();
        }
        break;

      case KEYBOARD_SHORTCUTS.SPEED_UP: // ArrowUp
        event.preventDefault();
        actions.onSpeedUp?.();
        break;

      case KEYBOARD_SHORTCUTS.SPEED_DOWN: // ArrowDown
        event.preventDefault();
        actions.onSpeedDown?.();
        break;

      case KEYBOARD_SHORTCUTS.NEXT_MARKER: // >
        event.preventDefault();
        actions.onNextMarker?.();
        break;

      case KEYBOARD_SHORTCUTS.PREV_MARKER: // <
        event.preventDefault();
        actions.onPreviousMarker?.();
        break;

      // Direct shortcuts (no Ctrl modifier)
      case 'x':
      case 'X':
        if (!isCtrlOrCmd) {
          event.preventDefault();
          console.log('[Keyboard] X (cut direct)');
          actions.onCutDirect?.();
        }
        break;

      case 'v':
      case 'V':
        if (!isCtrlOrCmd) {
          event.preventDefault();
          console.log('[Keyboard] V (paste direct)');
          actions.onPasteDirect?.();
        }
        break;

      case KEYBOARD_SHORTCUTS.MARK_TIME:
        if (!isCtrlOrCmd) {
          event.preventDefault();
          actions.onAddTimemark?.();
        }
        break;

      case 'Delete':
      case 'Backspace':
        if (!isCtrlOrCmd) {
          event.preventDefault();
          console.log(`[Keyboard] ${event.key} (delete)`);
          guardedEditAction(actions.onDeleteDirect);
        }
        break;

      // Loop mode shortcuts (Q/W/E/R/T)
      case KEYBOARD_SHORTCUTS.LOOP_FULL:
        if (!isCtrlOrCmd) {
          event.preventDefault();
          actions.onSetLoopMode?.('full');
        }
        break;
      case KEYBOARD_SHORTCUTS.LOOP_INOUT:
        if (!isCtrlOrCmd) {
          event.preventDefault();
          actions.onSetLoopMode?.('inout');
        }
        break;
      case KEYBOARD_SHORTCUTS.LOOP_CLIP:
        if (!isCtrlOrCmd) {
          event.preventDefault();
          actions.onSetLoopMode?.('clip');
        }
        break;
    }
  }

  function handleKeyUp(event: KeyboardEvent) {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement
    ) {
      return;
    }

    const key = event.key;

    // Remove from held keys
    if (heldKeys.has(key)) {
      heldKeys.delete(key);

      // Check if this is a JKL-related key
      const jklKeys = ['j', 'J', 'k', 'K', 'l', 'L', 'ArrowLeft', 'ArrowRight', 'Shift'];
      if (jklKeys.includes(key)) {
        event.preventDefault();
        updateJklPlayback();
      }
    }
  }

  // Clear held keys when window loses focus
  function handleBlur(): void {
    if (jklActive) {
      jklActive = false;
      actions.onJklStop?.();
    }
    heldKeys.clear();
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
  });

  onUnmounted(() => {
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    window.removeEventListener('blur', handleBlur);
  });
}

export function getShortcutLabel(action: keyof typeof KEYBOARD_SHORTCUTS): string {
  const key = KEYBOARD_SHORTCUTS[action];

  switch (key) {
    case ' ':
      return 'Space';
    case 'Delete':
      return 'Del';
    default:
      return key.toUpperCase();
  }
}
