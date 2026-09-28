import { expect, it, vi } from 'vitest';
import type { Session, OnBeforeRequestListenerDetails,
  OnBeforeSendHeadersListenerDetails } from 'electron';
import { configureUpdateNetwork } from './update-network';

function fixture() {
  const webRequest = {
    onBeforeRequest: vi.fn<Session['webRequest']['onBeforeRequest']>(),
    onBeforeSendHeaders: vi.fn<Session['webRequest']['onBeforeSendHeaders']>(),
  };
  configureUpdateNetwork({ webRequest });
  return webRequest;
}

it.each([
  ['https://github.com/muyuzhong/Featherlog/releases.atom', false],
  ['https://api.github.com/repos/muyuzhong/Featherlog/releases/latest', false],
  ['https://release-assets.githubusercontent.com/file', false],
  ['https://objects.githubusercontent.com/file', false],
  ['http://github.com/file', true],
  ['https://github.com.evil.test/file', true],
  ['https://metrics.example.com/file', true],
])('limits updater requests and redirects to GitHub: %s', (url, cancel) => {
  const webRequest = fixture();
  const callback = vi.fn();
  const listener = webRequest.onBeforeRequest.mock.calls[0]![0]!;
  listener({ url } as OnBeforeRequestListenerDetails, callback);
  expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel });
});

it('strips rollout identifiers, cookies and credentials before each network request', () => {
  const webRequest = fixture();
  const callback = vi.fn();
  const listener = webRequest.onBeforeSendHeaders.mock.calls[0]![0]!;
  listener({ id: 1, url: 'https://github.com', method: 'GET', resourceType: 'xhr',
    timestamp: 0, webContentsId: 1, referrer: '', requestHeaders: { 'X-User-Staging-ID': 'uuid', cookie: 'device=uuid',
    Authorization: 'token', Accept: 'application/json' } } as OnBeforeSendHeadersListenerDetails,
  callback);
  expect(callback).toHaveBeenCalledExactlyOnceWith({ requestHeaders: {
    Accept: 'application/json',
  } });
});
