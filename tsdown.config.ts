import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    types: 'src/types.ts',
    http: 'src/http.ts',
    compat: 'src/compat.ts',
    errors: 'src/errors.ts',
    receipts: 'src/receipts.ts',
    'test-utils': 'src/test-utils.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
});
