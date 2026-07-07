import assert from 'node:assert/strict';
import { it } from 'node:test';

import { requestJsonWithRetry } from '../src/supermarket-cli.js';

it('retries pagination requests when response body is not json', async () => {
  let attempts = 0;
  const page = {
    request: {
      async post() {
        attempts += 1;
        if (attempts === 1) {
          return {
            status: () => 200,
            async json() {
              throw new SyntaxError('Unexpected token <');
            },
            async text() {
              return '<html>temporary block</html>';
            },
          };
        }
        return {
          status: () => 200,
          async json() {
            return { data: { product_spu_list: [{ id: 1 }], has_next_page: false } };
          },
          async text() {
            return '{"data":{}}';
          },
        };
      },
    },
  };

  const result = await requestJsonWithRetry(page, 'https://example.test/api', {
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    data: 'page_index=2',
    timeout: 30000,
    attempts: 2,
    delayMs: 0,
  });

  assert.equal(attempts, 2);
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.data.product_spu_list, [{ id: 1 }]);
});
