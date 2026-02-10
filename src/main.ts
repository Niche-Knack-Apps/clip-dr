import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import './assets/styles/main.css';
import { DebugLogger, setLogger } from '@/services/debug-logger';

// Initialize debug logger
const logger = new DebugLogger({ appName: 'Clip Dr.' });
logger.init();
setLogger(logger);

const pinia = createPinia();
const app = createApp(App);

app.use(pinia);
app.use(router);

app.mount('#app');

// Expose debug utilities to window for console debugging
if (typeof window !== 'undefined') {
  import('./stores/playback').then(({ usePlaybackStore }) => {
    import('./stores/audio').then(({ useAudioStore }) => {
      import('./stores/tracks').then(({ useTracksStore }) => {
        (window as unknown as Record<string, unknown>).debugAudio = {
          testBeep: () => usePlaybackStore().testAudioOutput(),
          getContext: () => useAudioStore().getAudioContext(),
          getFirstBuffer: () => useTracksStore().tracks[0]?.audioData?.buffer ?? null,
          getTracks: () => useTracksStore().tracks,
          resumeContext: () => useAudioStore().resumeAudioContext(),
        };
        console.log('[Debug] Audio debug utilities available at window.debugAudio');
        console.log('  - debugAudio.testBeep() - play a test tone');
        console.log('  - debugAudio.getContext() - get AudioContext');
        console.log('  - debugAudio.getFirstBuffer() - get first track buffer');
        console.log('  - debugAudio.getTracks() - get all tracks');
        console.log('  - debugAudio.resumeContext() - resume if suspended');
      });
    });
  });
}
