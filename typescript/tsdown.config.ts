import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    types: 'src/types.ts',
    http: 'src/http.ts',
    compat: 'src/compat.ts',
    'compat-mpp': 'src/compat-mpp.ts',
    'compat-l402': 'src/compat-l402.ts',
    errors: 'src/errors.ts',
    receipts: 'src/receipts.ts',
    'test-utils': 'src/test-utils.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
});
