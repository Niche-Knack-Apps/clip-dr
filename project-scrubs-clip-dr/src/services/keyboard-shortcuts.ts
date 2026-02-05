import { onMounted, onUnmounted } from 'vue';
import { KEYBOARD_SHORTCUTS } from '@/shared/constants';

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
  onJumpLayerStart?: () => void;
  onJumpLayerEnd?: () => void;
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
}

export function useKeyboardShortcuts(actions: KeyboardActions) {
  // Track all held keys for multi-key detection
  const heldKeys = new Set<string>();

  // Track if JKL playback is active
  let jklActive = false;

  // Calculate JKL speed based on held keys
  function calculateJklSpeed(): { speed: number; reverse: boolean } | null {
    const hasL = heldKeys.has('l') || heldKeys.has('L') || heldKeys.has('ArrowRight');
    const hasJ = heldKeys.has('j') || heldKeys.has('J') || heldKeys.has('ArrowLeft');
    const hasK = heldKeys.has('k') || heldKeys.has('K') || heldKeys.has('ArrowUp');
    const hasShift = heldKeys.has('Shift');
    const hasDown = heldKeys.has('ArrowDown');

    if (hasL && !hasJ) {
      // Forward playback
      if (hasK) return { speed: 2, reverse: false };
      if (hasShift || hasDown) return { speed: 0.5, reverse: false };
      return { speed: 1, reverse: false };
    }

    if (hasJ && !hasL) {
      // Reverse playback
      if (hasK) return { speed: 2, reverse: true };
      if (hasShift || hasDown) return { speed: 0.5, reverse: true };
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
          actions.onCut?.();
          return;
        case 'c':
          event.preventDefault();
          console.log('[Keyboard] Ctrl+C (copy)');
          actions.onCopy?.();
          return;
        case 'v':
          event.preventDefault();
          console.log('[Keyboard] Ctrl+V (paste)');
          actions.onPaste?.();
          return;
        case 'z':
          event.preventDefault();
          if (event.shiftKey) {
            console.log('[Keyboard] Ctrl+Shift+Z (redo)');
            actions.onRedo?.();
          } else {
            console.log('[Keyboard] Ctrl+Z (undo)');
            actions.onUndo?.();
          }
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
      const jklKeys = ['j', 'J', 'k', 'K', 'l', 'L', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Shift'];
      if (jklKeys.includes(key)) {
        event.preventDefault();
        updateJklPlayback();
        return;
      }
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
      case KEYBOARD_SHORTCUTS.PLAY_PAUSE:
        event.preventDefault();
        actions.onPlayPause?.();
        break;

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

      // New shortcuts
      case KEYBOARD_SHORTCUTS.JUMP_LAYER_START:
        if (!isCtrlOrCmd) {
          event.preventDefault();
          actions.onJumpLayerStart?.();
        }
        break;

      case KEYBOARD_SHORTCUTS.JUMP_LAYER_END:
        if (!isCtrlOrCmd) {
          event.preventDefault();
          actions.onJumpLayerEnd?.();
        }
        break;

      case KEYBOARD_SHORTCUTS.SPEED_UP:
      case '>':
        event.preventDefault();
        actions.onSpeedUp?.();
        break;

      case KEYBOARD_SHORTCUTS.SPEED_DOWN:
      case '<':
        event.preventDefault();
        actions.onSpeedDown?.();
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

      case 'Delete':
      case 'Backspace':
        if (!isCtrlOrCmd) {
          event.preventDefault();
          console.log(`[Keyboard] ${event.key} (delete)`);
          actions.onDeleteDirect?.();
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
      const jklKeys = ['j', 'J', 'k', 'K', 'l', 'L', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Shift'];
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
