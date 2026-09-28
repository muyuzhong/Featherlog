import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { DockService, registerDockService } from './dock-service';

function fixture() {
  const bus = Object.assign(new EventEmitter(), {
    requestName: vi.fn(async () => 1), export: vi.fn(), unexport: vi.fn(), disconnect: vi.fn(),
  });
  const log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { bus, log };
}

it('exports the named Dock service, validates input and disconnects on disposal', async () => {
  const { bus, log } = fixture();
  const setSide = vi.fn((side: 'left' | 'right') => side);
  const stop = await registerDockService(setSide, () => true, log, () => bus);
  expect(bus.requestName).toHaveBeenCalledWith('org.featherlog.Shell', 4);
  expect(bus.export.mock.calls[0]![0]).toBe('/Dock');
  const service = bus.export.mock.calls[0]![1] as DockService;
  expect(service.SetSide('right')).toBe('right');
  expect(service.GetExpanded()).toBe(true);
  expect(() => service.SetSide('invalid')).toThrow(expect.objectContaining({
    code: 'shell/invalid-input',
  }));
  expect(setSide).toHaveBeenCalledOnce();
  stop!();
  expect(bus.unexport).toHaveBeenCalledWith('/Dock', service);
  expect(bus.disconnect).toHaveBeenCalledOnce();
});

it.each(['occupied', 'connection', 'export', 'error-event'])(
  'logs and releases its connection when registration fails: %s', async mode => {
    const { bus, log } = fixture();
    if (mode === 'occupied') bus.requestName.mockResolvedValue(3);
    if (mode === 'connection') bus.requestName.mockRejectedValue(new Error('connection'));
    if (mode === 'export') bus.export.mockImplementation(() => { throw new Error('export'); });
    if (mode === 'error-event') bus.requestName.mockImplementation(() => new Promise(() => {
      queueMicrotask(() => bus.emit('error', new Error('socket')));
    }));
    const stop = await registerDockService(() => 'left', () => false, log, () => bus);
    expect(stop).toBeUndefined();
    expect(bus.disconnect).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalled();
  },
);
