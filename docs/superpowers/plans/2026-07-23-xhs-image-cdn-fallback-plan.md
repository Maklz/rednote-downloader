# XHS Image CDN Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Huawei and Baidu Xiaohongshu image CDN fallbacks without changing the existing primary image URL or any video flow.

**Architecture:** Extend the existing image candidate collector in `src/xhs.js`. For supported `sns-webpic*.xhscdn.com` URLs containing a `1040g...` trace ID, generate two CDN transformation URLs and place them after the existing derived `ci.xiaohongshu.com` candidate. Existing `fallbackUrls` consumers will handle retries automatically.

**Tech Stack:** Node.js ESM, Node built-in test runner, existing `extractImages()` candidate model.

---

### Task 1: Add failing image CDN fallback tests

**Files:**
- Modify: `test/xhs.test.js:9-27`
- Test: `test/xhs.test.js`

- [x] **Step 1: Import the new helper and add the expected URL test**

Add `deriveXhsImageCdnFallbackUrls` to the import list and add:

```js
test('derives Huawei and Baidu CDN fallbacks from a 1040g image URL', () => {
  const input = 'https://sns-webpic-qc.xhscdn.com/202511292028/30ab642bea120348cf64a607c9eb8141/1040g00830t2hgqelk4005o49b2u097vri7c1ij8!nd_dft_wlteh_webp_3';

  assert.deepEqual(deriveXhsImageCdnFallbackUrls(input), [
    'https://sns-img-hw.xhscdn.com/1040g00830t2hgqelk4005o49b2u097vri7c1ij8?imageView2/2/w/format/png',
    'https://sns-img-bd.xhscdn.com/1040g00830t2hgqelk4005o49b2u097vri7c1ij8?imageView2/2/w/format/png',
  ]);
});
```

Also add:

```js
test('extractImages keeps the ci URL primary and exposes CDN fallbacks', () => {
  const result = extractImages({
    imageList: [{
      urlDefault: 'https://sns-webpic-qc.xhscdn.com/202511292028/30ab642bea120348cf64a607c9eb8141/1040g00830t2hgqelk4005o49b2u097vri7c1ij8!nd_dft_wlteh_webp_3',
    }],
  });

  assert.equal(result[0].url, 'https://ci.xiaohongshu.com/1040g00830t2hgqelk4005o49b2u097vri7c1ij8');
  assert.deepEqual(result[0].fallbackUrls.slice(0, 2), [
    'https://sns-img-hw.xhscdn.com/1040g00830t2hgqelk4005o49b2u097vri7c1ij8?imageView2/2/w/format/png',
    'https://sns-img-bd.xhscdn.com/1040g00830t2hgqelk4005o49b2u097vri7c1ij8?imageView2/2/w/format/png',
  ]);
});
```

- [x] **Step 2: Run the focused tests and verify they fail for the missing helper**

Run:

```bash
node --test test/xhs.test.js
```

Expected: FAIL because `deriveXhsImageCdnFallbackUrls` is not exported and the candidate collector does not yet add the fallback URLs.

### Task 2: Implement the minimal candidate fallback

**Files:**
- Modify: `src/xhs.js:405-447`
- Test: `test/xhs.test.js`

- [x] **Step 1: Add the independent fallback helper**

After `deriveOriginalImageUrl`, add:

```js
export function deriveXhsImageCdnFallbackUrls(url) {
  const normalized = normalizeImageUrl(url);
  if (!normalized) {
    return [];
  }

  const match = normalized.match(/https?:\/\/sns-webpic[^/]*\.xhscdn\.com\/\d+\/[0-9a-z]+\/(1040g[^!?]+)(?:!.*)?$/i);
  if (!match?.[1]) {
    return [];
  }

  const traceId = match[1];
  const suffix = '?imageView2/2/w/format/png';
  return [
    `https://sns-img-hw.xhscdn.com/${traceId}${suffix}`,
    `https://sns-img-bd.xhscdn.com/${traceId}${suffix}`,
  ];
}
```

- [x] **Step 2: Add the derived URLs to the existing candidate list**

Update `collectImageCandidates` so its return value is:

```js
  const derived = unique(normalized.map(deriveOriginalImageUrl));
  const cdnFallbacks = unique(normalized.flatMap(deriveXhsImageCdnFallbackUrls));
  return unique([...derived, ...cdnFallbacks, ...normalized]);
```

The existing score keeps `ci.xiaohongshu.com` as the primary URL, while the two new URLs become fallback candidates.

- [x] **Step 3: Run the focused tests and verify they pass**

Run:

```bash
node --test test/xhs.test.js
```

Expected: PASS, including both new fallback tests.

### Task 3: Run the complete verification suite

**Files:**
- Verify: `src/xhs.js`
- Verify: `test/xhs.test.js`

- [x] **Step 1: Run the full tests**

Run:

```bash
npm test
```

Expected: all existing tests plus the two new fallback tests pass.

- [x] **Step 2: Validate the Docker compose files**

Run:

```bash
docker compose -f compose.hub.yaml config
docker compose -f compose.unraid.yaml config
```

Expected: both commands exit successfully.

- [x] **Step 3: Commit the implementation**

```bash
git add src/xhs.js test/xhs.test.js
git commit -m "feat: add XHS image CDN fallbacks"
```
