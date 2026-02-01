import { onMounted, onUnmounted } from 'vue';
import { KEYBOARD_SHORTCUTS } from '@/shared/constants';

export interface KeyboardActions {
  onPlayPause?: () => void;
  onSetIn?: () => void;
  onSetOut?: () => void;
  onCreateClip?: () => void;
  onToggleLoop?: () => void;
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
}

export function useKeyboardShortcuts(actions: KeyboardActions) {
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

    // Handle number keys 1-9 for nudge
    if (!isCtrlOrCmd && !event.shiftKey && !event.altKey) {
      const num = parseInt(event.key, 10);
      if (num >= 1 && num <= 9) {
        event.preventDefault();
        actions.onNudge?.(num * 10); // 10ms per number
        return;
      }
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

      case KEYBOARD_SHORTCUTS.TOGGLE_LOOP:
        if (!isCtrlOrCmd) {
          event.preventDefault();
          actions.onToggleLoop?.();
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
      case 'ArrowRight':
        event.preventDefault();
        actions.onSpeedUp?.();
        break;

      case KEYBOARD_SHORTCUTS.SPEED_DOWN:
      case '<':
      case 'ArrowLeft':
        event.preventDefault();
        actions.onSpeedDown?.();
        break;
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', handleKeyDown);
  });

  onUnmounted(() => {
    window.removeEventListener('keydown', handleKeyDown);
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
