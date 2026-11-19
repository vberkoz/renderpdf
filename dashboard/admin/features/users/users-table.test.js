import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mockToken,
  createMockElement,
  sampleUsersResponse,
  windowEvents,
} from './test-dom-mock.js';
import { initUserDirectoryTab } from './users-table.js';

test('initUserDirectoryTab renders toolbar, table, badges, and progress bar', async () => {
  const fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => sampleUsersResponse,
    };
  };

  const container = createMockElement('div');
  await initUserDirectoryTab(container);

  // 1. Initial API call
  assert.strictEqual(fetchCalls.length, 1);
  assert.strictEqual(fetchCalls[0].url, '/api/v1/admin/users');
  assert.strictEqual(fetchCalls[0].opts.headers.Authorization, `Bearer ${mockToken}`);

  const html = container.innerHTML;

  // 2. Toolbar elements
  assert.ok(html.includes('id="admin-users-search"'), 'Search input exists');
  assert.ok(html.includes('id="admin-filter-tier"'), 'Tier filter dropdown exists');
  assert.ok(html.includes('id="admin-filter-status"'), 'Status filter dropdown exists');

  // 3. User rows rendered
  assert.ok(html.includes('customer@acme.com'), 'Customer email rendered');
  assert.ok(html.includes('c1f7b76e…') || html.includes('c1f7b76e'), 'ID snippet rendered');

  // 4. Tier badges
  assert.ok(html.includes('badge-starter'), 'Starter tier badge rendered');
  assert.ok(html.includes('badge-pro'), 'Pro tier badge rendered');
  assert.ok(html.includes('badge-free'), 'Free tier badge rendered');
  assert.ok(
    html.includes('admin-tier-override'),
    'Manual override asterisk rendered for overridden user'
  );

  // 5. Status badges
  assert.ok(html.includes('badge-status-active'), 'Active status badge rendered');
  assert.ok(
    html.includes('badge-status-past-due') || html.includes('badge-status-past_due'),
    'Past Due badge rendered'
  );
  assert.ok(html.includes('badge-status-canceled'), 'Canceled badge rendered');

  // 6. Quota progress bar
  assert.ok(html.includes('412 / 5,000'), 'Quota text 412 / 5,000 rendered');
  assert.ok(html.includes('8%'), 'Quota percentage 8% rendered');
  assert.ok(html.includes('role="progressbar"'), 'Progress bar role exists');

  // 7. Active keys count
  assert.ok(html.includes('2'), 'Active keys count rendered');
  assert.ok(html.includes('5'), 'Active keys count rendered');

  // 8. Inspect action buttons
  assert.ok(html.includes('admin-btn-inspect'), 'Inspect action button rendered');
  assert.ok(
    html.includes('data-user-id="c1f7b76e-3c2e-4b21-8273-df3e18a992bc"'),
    'data-user-id attribute set on Inspect button'
  );

  // 9. Pagination controls
  assert.ok(html.includes('Showing <strong>3</strong> users'), 'Shows 3 users count');
  assert.ok(html.includes('id="admin-pagination-prev"'), 'Previous page button exists');
  assert.ok(html.includes('id="admin-pagination-next"'), 'Next page button exists');
});

test('typing in search bar triggers API request after 300ms debounce', async () => {
  const fetchCalls = [];
  global.fetch = async (url) => {
    fetchCalls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => sampleUsersResponse,
    };
  };

  const container = createMockElement('div');
  await initUserDirectoryTab(container);
  assert.strictEqual(fetchCalls.length, 1);

  const searchInput = container.querySelector('#admin-users-search');
  assert.ok(searchInput, 'Search input exists');

  // Simulate typing: fire input event
  searchInput.value = 'alice@example.com';
  searchInput.dispatchEvent({ type: 'input', target: { value: 'alice@example.com' } });

  // Immediately after input, no new API request should have been dispatched (debounce pending)
  assert.strictEqual(fetchCalls.length, 1);

  // Wait 350ms to allow debounce timer to fire
  await new Promise((resolve) => setTimeout(resolve, 350));

  // Now the debounced search request must have been dispatched
  assert.strictEqual(fetchCalls.length, 2);
  assert.ok(
    fetchCalls[1].includes('q=alice%40example.com') || fetchCalls[1].includes('q=alice@example.com')
  );
});

test('clicking dropdown filter immediately refilters the table', async () => {
  const fetchCalls = [];
  global.fetch = async (url) => {
    fetchCalls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => sampleUsersResponse,
    };
  };

  const container = createMockElement('div');
  await initUserDirectoryTab(container);
  assert.strictEqual(fetchCalls.length, 1);

  const tierSelect = container.querySelector('#admin-filter-tier');
  assert.ok(tierSelect, 'Tier select exists');

  // Change tier filter
  tierSelect.value = 'starter';
  tierSelect.dispatchEvent({ type: 'change', target: { value: 'starter' } });

  // Filter should immediately trigger API request without 300ms debounce delay
  assert.strictEqual(fetchCalls.length, 2);
  assert.ok(fetchCalls[1].includes('tier=starter'));

  const statusSelect = container.querySelector('#admin-filter-status');
  statusSelect.value = 'past_due';
  statusSelect.dispatchEvent({ type: 'change', target: { value: 'past_due' } });

  assert.strictEqual(fetchCalls.length, 3);
  assert.ok(fetchCalls[2].includes('status=past_due'));
});

test('clicking Inspect triggers open-user-dossier custom event with userId', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => sampleUsersResponse,
  });

  const container = createMockElement('div');
  const containerEvents = [];
  container.addEventListener('open-user-dossier', (e) => {
    containerEvents.push(e);
  });
  windowEvents.length = 0;

  await initUserDirectoryTab(container);

  const tbody = container.querySelector('#admin-users-tbody');
  const inspectBtn = tbody.querySelector('.admin-btn-inspect');
  assert.ok(inspectBtn, 'Inspect button exists');

  // Click Inspect
  tbody.dispatchEvent({
    type: 'click',
    target: inspectBtn,
  });

  // Verify container event
  assert.strictEqual(containerEvents.length, 1);
  assert.strictEqual(containerEvents[0].detail.userId, 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc');

  // Verify window event
  assert.strictEqual(windowEvents.length, 1);
  assert.strictEqual(windowEvents[0].detail.userId, 'c1f7b76e-3c2e-4b21-8273-df3e18a992bc');
});

test('pagination Next and Previous navigate pages via cursor tokens', async () => {
  const fetchCalls = [];
  global.fetch = async (url) => {
    fetchCalls.push(url);
    if (url.includes('cursor=')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          users: [
            {
              id: 'page2-user-1',
              email: 'page2@acme.com',
              tier: 'starter',
              status: 'active',
              quotaUsed: 10,
              quotaLimit: 5000,
            },
          ],
          nextCursor: null,
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => sampleUsersResponse,
    };
  };

  const container = createMockElement('div');
  await initUserDirectoryTab(container);
  assert.strictEqual(fetchCalls.length, 1);

  const paginationEl = container.querySelector('#admin-users-pagination');
  const nextBtn = paginationEl.querySelector('#admin-pagination-next');
  const prevBtn = paginationEl.querySelector('#admin-pagination-prev');

  assert.strictEqual(prevBtn.disabled, true);
  assert.strictEqual(nextBtn.disabled, false);

  // Click Next
  paginationEl.dispatchEvent({ type: 'click', target: nextBtn });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.strictEqual(fetchCalls.length, 2);
  assert.ok(fetchCalls[1].includes('cursor=cursor_token_page_2'));

  // On page 2, prevBtn should be enabled, nextBtn disabled
  const prevBtnP2 = paginationEl.querySelector('#admin-pagination-prev');
  const nextBtnP2 = paginationEl.querySelector('#admin-pagination-next');
  assert.strictEqual(prevBtnP2.disabled, false);
  assert.strictEqual(nextBtnP2.disabled, true);

  // Click Previous to return to page 1
  paginationEl.dispatchEvent({ type: 'click', target: prevBtnP2 });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.strictEqual(fetchCalls.length, 3);
  assert.ok(!fetchCalls[2].includes('cursor='));
});

test('handles empty results and network error retry', async () => {
  let attempt = 0;
  global.fetch = async () => {
    attempt++;
    if (attempt === 1) {
      return {
        ok: false,
        status: 500,
        json: async () => ({ error: 'Users service timeout' }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ users: [], nextCursor: null }),
    };
  };

  const container = createMockElement('div');
  await initUserDirectoryTab(container);

  // 1. Error state banner
  assert.ok(container.innerHTML.includes('Failed to load users'));
  assert.ok(container.innerHTML.includes('Users service timeout'));

  const tbody = container.querySelector('#admin-users-tbody');
  const retryBtn = tbody.querySelector('#admin-users-retry-btn');
  assert.ok(retryBtn, 'Retry button exists');

  // 2. Retry click
  retryBtn.dispatchEvent({ type: 'click', target: retryBtn });

  // Wait a tick for async loadData to finish
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.strictEqual(attempt, 2);
  // 3. Empty state rendered
  assert.ok(container.innerHTML.includes('No users found matching your search criteria'));
});
