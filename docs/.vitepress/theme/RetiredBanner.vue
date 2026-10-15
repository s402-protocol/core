<script setup lang="ts">
/**
 * RetiredBanner — s402 was retired on 2026-09-25 in favor of x402 (DAN-1262).
 *
 * Rendered in the default theme's `layout-top` slot, so it sits above the nav on
 * every page. VitePress offsets the fixed nav and sidebar by `--vp-layout-top-height`;
 * the banner wraps to more lines on a phone, so its real height is measured and
 * written to that variable rather than guessed. The CSS fallback below covers the
 * first paint before the script runs.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const el = ref<HTMLElement | null>(null)
let observer: ResizeObserver | undefined

function sync() {
  if (el.value)
    document.documentElement.style.setProperty('--vp-layout-top-height', `${el.value.offsetHeight}px`)
}

onMounted(() => {
  sync()
  observer = new ResizeObserver(sync)
  if (el.value) observer.observe(el.value)
})

onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div ref="el" class="retired-banner" role="note" aria-label="s402 is retired">
    <p>
      <strong>s402 was retired in September 2026.</strong>
      It was an HTTP 402 payment protocol for agents on Sui, and x402 has since become the
      industry standard. For new work, use
      <a href="https://x402.org" rel="noopener">x402&nbsp;→</a>
    </p>
  </div>
</template>
