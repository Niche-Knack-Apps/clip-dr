import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import './assets/styles/main.css';
import { DebugLogger, setLogger } from '@/services/debug-logger';

// Initialize debug logger
const logger = new DebugLogger({ appName: 'Project Scrubs' });
logger.init();
setLogger(logger);

const app = createApp(App);

app.use(createPinia());
app.use(router);

app.mount('#app');
