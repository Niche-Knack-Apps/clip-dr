import { createRouter, createWebHistory } from 'vue-router';
import EditorView from '@/views/EditorView.vue';

const routes = [
  {
    path: '/',
    name: 'editor',
    component: EditorView,
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
