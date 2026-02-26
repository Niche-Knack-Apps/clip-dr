import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import LevelMeter from '@/components/recording/LevelMeter.vue';

describe('LevelMeter.vue', () => {
  it('renders without errors', () => {
    const wrapper = mount(LevelMeter, {
      props: { level: 0.5 },
    });
    expect(wrapper.exists()).toBe(true);
  });

  it('shows green bar for low levels', () => {
    const wrapper = mount(LevelMeter, {
      props: { level: 0.3 },
    });
    const bar = wrapper.find('.h-full');
    expect(bar.classes()).toContain('bg-green-500');
  });

  it('shows yellow bar for medium-high levels', () => {
    const wrapper = mount(LevelMeter, {
      props: { level: 0.8 },
    });
    const bar = wrapper.find('.h-full');
    expect(bar.classes()).toContain('bg-yellow-500');
  });

  it('shows red bar for peak levels', () => {
    const wrapper = mount(LevelMeter, {
      props: { level: 0.95 },
    });
    const bar = wrapper.find('.h-full');
    expect(bar.classes()).toContain('bg-red-500');
  });

  it('green threshold boundary: 0.7 is still green', () => {
    const wrapper = mount(LevelMeter, {
      props: { level: 0.7 },
    });
    const bar = wrapper.find('.h-full');
    expect(bar.classes()).toContain('bg-green-500');
  });

  it('yellow threshold boundary: just above 0.7', () => {
    const wrapper = mount(LevelMeter, {
      props: { level: 0.71 },
    });
    const bar = wrapper.find('.h-full');
    expect(bar.classes()).toContain('bg-yellow-500');
  });

  it('red threshold boundary: 0.9 is still yellow', () => {
    const wrapper = mount(LevelMeter, {
      props: { level: 0.9 },
    });
    const bar = wrapper.find('.h-full');
    expect(bar.classes()).toContain('bg-yellow-500');
  });

  it('red threshold boundary: just above 0.9', () => {
    const wrapper = mount(LevelMeter, {
      props: { level: 0.91 },
    });
    const bar = wrapper.find('.h-full');
    expect(bar.classes()).toContain('bg-red-500');
  });

  it('bar width matches level percentage', () => {
    const wrapper = mount(LevelMeter, {
      props: { level: 0.65 },
    });
    const bar = wrapper.find('.h-full');
    expect(bar.attributes('style')).toContain('width: 65%');
  });

  it('bar width caps at 100%', () => {
    const wrapper = mount(LevelMeter, {
      props: { level: 1.5 },
    });
    const bar = wrapper.find('.h-full');
    expect(bar.attributes('style')).toContain('width: 100%');
  });

  it('zero level shows 0% width', () => {
    const wrapper = mount(LevelMeter, {
      props: { level: 0 },
    });
    const bar = wrapper.find('.h-full');
    expect(bar.attributes('style')).toContain('width: 0%');
  });

  it('shows dB readout when showDb is true', () => {
    const wrapper = mount(LevelMeter, {
      props: { level: 0.5, showDb: true },
    });
    const dbText = wrapper.find('.font-mono');
    expect(dbText.exists()).toBe(true);
    expect(dbText.text()).toContain('dB');
  });

  it('hides dB readout when showDb is false', () => {
    const wrapper = mount(LevelMeter, {
      props: { level: 0.5 },
    });
    // Without showDb, the v-if hides the span
    const dbTexts = wrapper.findAll('.font-mono');
    expect(dbTexts).toHaveLength(0);
  });

  it('dB display shows -inf for zero level', () => {
    const wrapper = mount(LevelMeter, {
      props: { level: 0, showDb: true },
    });
    const dbText = wrapper.find('.font-mono');
    expect(dbText.text()).toContain('-inf');
  });

  it('dB display shows approximately 0 dB for level 1.0', () => {
    const wrapper = mount(LevelMeter, {
      props: { level: 1.0, showDb: true },
    });
    const dbText = wrapper.find('.font-mono');
    expect(dbText.text()).toContain('0.0');
  });

  it('dB display shows approximately -6 dB for level 0.5', () => {
    const wrapper = mount(LevelMeter, {
      props: { level: 0.5, showDb: true },
    });
    const dbText = wrapper.find('.font-mono');
    // 20 * log10(0.5) ≈ -6.02
    expect(dbText.text()).toContain('-6.0');
  });
});
