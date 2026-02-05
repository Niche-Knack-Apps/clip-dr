<script setup lang="ts">
import { ref, computed } from 'vue';

// V4V Configuration
const config = {
  brand: {
    name: 'niche-knack apps',
    tagline: 'Cabinet of Curiosities for Software',
    website: 'https://nicheknack.app',
    email: 'hello@nicheknack.app',
  },
  v4v: {
    lightning: {
      label: 'Bitcoin Lightning',
      description: 'Instant, low-fee payments',
      icon: '\u26a1',
      address: 'itsmikenichols@getalby.com',
      enabled: true,
    },
    bitcoin: {
      label: 'Bitcoin On-chain',
      description: 'For larger contributions',
      icon: '\u20bf',
      address: '',
      enabled: false,
    },
    kofi: {
      label: 'Ko-fi',
      description: 'Buy us a coffee',
      icon: '\u2615',
      url: 'https://ko-fi.com/nicheknack',
      enabled: true,
    },
    paypal: {
      label: 'PayPal',
      description: 'Traditional payment',
      icon: '\ud83d\udcb3',
      url: 'https://paypal.me/itsmikenichols',
      enabled: true,
    },
  },
};

const props = defineProps<{
  appName: string;
  appVersion: string;
}>();

const copiedKey = ref<string | null>(null);

interface V4VOption {
  key: string;
  label: string;
  description: string;
  icon: string;
  address?: string;
  url?: string;
  enabled: boolean;
}

const enabledOptions = computed<V4VOption[]>(() => {
  return Object.entries(config.v4v)
    .filter(([_, opt]) => opt.enabled)
    .map(([key, opt]) => ({ key, ...opt }));
});

async function copyToClipboard(text: string, key: string) {
  try {
    await navigator.clipboard.writeText(text);
    copiedKey.value = key;
    setTimeout(() => {
      copiedKey.value = null;
    }, 2000);
  } catch (err) {
    console.error('Failed to copy:', err);
  }
}

function openExternal(url: string) {
  window.open(url, '_blank', 'noopener');
}
</script>

<template>
  <div class="about-panel">
    <!-- Header -->
    <div class="about-header">
      <img src="@/assets/niche-knack-logo.png" alt="niche-knack apps" class="about-logo" />
      <h3 class="app-name">{{ appName }}</h3>
      <span class="app-version">Version {{ appVersion }}</span>
      <div class="about-org">
        <p>Part of <strong>niche-knack apps</strong></p>
        <a :href="config.brand.website" target="_blank" rel="noopener">nicheknack.app</a>
      </div>
    </div>

    <!-- Value for Value -->
    <div class="v4v-section">
      <h4>Support Development</h4>
      <p class="v4v-description">
        This app is free, built on the
        <a href="https://value4value.info/" target="_blank" rel="noopener">Value for Value</a> model.
        If it brings you value, consider giving back.
      </p>

      <!-- Donation Options -->
      <div class="donation-options">
        <div
          v-for="option in enabledOptions"
          :key="option.key"
          class="donation-option"
        >
          <div class="donation-info">
            <span class="donation-icon">{{ option.icon }}</span>
            <div class="donation-details">
              <strong>{{ option.label }}</strong>
              <small>{{ option.address || option.description }}</small>
            </div>
          </div>
          <div class="donation-action">
            <button
              v-if="option.address"
              class="btn-copy"
              :class="{ copied: copiedKey === option.key }"
              @click="copyToClipboard(option.address!, option.key)"
            >
              {{ copiedKey === option.key ? 'Copied!' : 'Copy' }}
            </button>
            <button
              v-else-if="option.url"
              class="btn-donate"
              @click="openExternal(option.url!)"
            >
              Donate
            </button>
          </div>
        </div>
      </div>

      <!-- Other ways -->
      <div class="other-ways">
        <strong>Other ways to help:</strong>
        <ul>
          <li>Share this app with others</li>
          <li>Report bugs (<a :href="`mailto:${config.brand.email}`">{{ config.brand.email }}</a>)</li>
          <li>Suggest features</li>
        </ul>
      </div>
    </div>

    <!-- Footer -->
    <div class="about-footer">
      <p>Learn more at <a :href="config.brand.website" target="_blank" rel="noopener">nicheknack.app</a></p>
    </div>
  </div>
</template>

<style scoped>
.about-panel {
  padding: 8px 0;
}

.about-header {
  text-align: center;
  margin-bottom: 24px;
}

.about-logo {
  width: 80px;
  height: 80px;
  margin: 0 auto 12px;
  border-radius: 12px;
}

.app-name {
  font-size: 1.25rem;
  font-weight: 600;
  margin: 0 0 4px;
}

.app-version {
  font-size: 0.8rem;
  opacity: 0.7;
}

.about-org {
  margin-top: 8px;
  font-size: 0.85rem;
  opacity: 0.8;
}

.about-org a {
  color: #22d3ee;
}

.v4v-section {
  padding-top: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.v4v-section h4 {
  font-size: 0.95rem;
  margin-bottom: 8px;
}

.v4v-description {
  font-size: 0.85rem;
  opacity: 0.8;
  margin-bottom: 16px;
}

.v4v-description a {
  color: #22d3ee;
}

.donation-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.donation-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.donation-info {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.donation-icon {
  font-size: 1.5rem;
  width: 36px;
  text-align: center;
}

.donation-details {
  flex: 1;
  min-width: 0;
}

.donation-details strong {
  display: block;
  font-size: 0.9rem;
}

.donation-details small {
  display: block;
  font-size: 0.75rem;
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.btn-copy,
.btn-donate {
  padding: 6px 12px;
  font-size: 0.8rem;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-copy:hover,
.btn-donate:hover {
  background: #22d3ee;
  border-color: #22d3ee;
  color: #111827;
}

.btn-copy.copied {
  background: #4caf50;
  border-color: #4caf50;
  color: white;
}

.other-ways {
  margin-top: 16px;
  padding: 12px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  font-size: 0.85rem;
}

.other-ways strong {
  display: block;
  margin-bottom: 8px;
}

.other-ways ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.other-ways li {
  padding: 4px 0 4px 16px;
  position: relative;
}

.other-ways li::before {
  content: '\2022';
  position: absolute;
  left: 0;
  opacity: 0.5;
}

.other-ways a {
  color: #22d3ee;
}

.about-footer {
  margin-top: 16px;
  text-align: center;
  font-size: 0.8rem;
  opacity: 0.7;
}

.about-footer a {
  color: #22d3ee;
}
</style>
