# XHS Image CDN Fallback Design

## Goal

Improve resilience for Xiaohongshu image downloads when the preferred `ci.xiaohongshu.com` URL is unavailable.

## Scope

- Keep the existing `ci.xiaohongshu.com` candidate as the preferred media URL.
- For `sns-webpic*.xhscdn.com` URLs whose image token starts with `1040g` and ends before `!`, derive two fallback candidates:
  - `sns-img-hw.xhscdn.com`
  - `sns-img-bd.xhscdn.com`
- Add the fallbacks to the existing `fallbackUrls` list so browser proxy downloads, server-side downloads, and Telegram uploads reuse the same retry path.
- Keep the implementation local to `src/xhs.js`; do not add a dependency or vendor code from the reference repository.

## Non-goals

- Do not replace the current primary URL selection.
- Do not change video resolution or page/short-link resolution.
- Do not claim that CDN PNG conversion guarantees the original byte stream.

## Verification

- Test the derived fallback URLs for a representative `1040g...!` source URL.
- Test that `extractImages()` keeps the current primary URL and exposes the CDN candidates as fallbacks.
- Run the complete Node test suite.
