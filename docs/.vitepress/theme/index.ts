import { h } from 'vue';
import DefaultTheme from 'vitepress/theme';
import RetiredBanner from './RetiredBanner.vue';
import './custom.css';

// s402 is retired (2026-09-25, DAN-1262): every page carries the notice above the nav.
export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    'layout-top': () => h(RetiredBanner),
  }),
};
