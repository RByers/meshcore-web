import { describe, expect, it, vi } from 'vitest';
import { TypedEmitter } from './events.js';

type Ev = { a: number; b: string };

describe('TypedEmitter', () => {
  it('delivers payloads to listeners in order', () => {
    const e = new TypedEmitter<Ev>();
    const got: string[] = [];
    e.on('a', (n) => got.push(`1:${n}`));
    e.on('a', (n) => got.push(`2:${n}`));
    e.on('b', (s) => got.push(`b:${s}`));
    e.emit('a', 5);
    e.emit('b', 'x');
    expect(got).toEqual(['1:5', '2:5', 'b:x']);
  });

  it('on returns an unsubscribe function', () => {
    const e = new TypedEmitter<Ev>();
    const fn = vi.fn();
    const off = e.on('a', fn);
    e.emit('a', 1);
    off();
    off();
    e.emit('a', 2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(e.listenerCount('a')).toBe(0);
  });

  it('off removes by function reference, or all listeners for an event', () => {
    const e = new TypedEmitter<Ev>();
    const fn = vi.fn();
    const other = vi.fn();
    e.on('a', fn);
    e.on('a', fn); // set semantics: still one registration
    e.on('a', other);
    e.emit('a', 1);
    expect(fn).toHaveBeenCalledTimes(1);
    e.off('a', fn);
    e.emit('a', 1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
    e.off('a');
    e.emit('a', 1);
    expect(other).toHaveBeenCalledTimes(2);
  });

  it('once fires a single time and can be cancelled', () => {
    const e = new TypedEmitter<Ev>();
    const fn = vi.fn();
    e.once('a', fn);
    e.emit('a', 1);
    e.emit('a', 2);
    expect(fn).toHaveBeenCalledExactlyOnceWith(1);
    const fn2 = vi.fn();
    const off = e.once('a', fn2);
    off();
    e.emit('a', 3);
    expect(fn2).not.toHaveBeenCalled();
  });

  it('listener changes during emit do not affect the current emit', () => {
    const e = new TypedEmitter<Ev>();
    const late = vi.fn();
    e.on('a', () => {
      e.on('a', late);
    });
    e.emit('a', 1);
    expect(late).not.toHaveBeenCalled();
    e.emit('a', 2);
    expect(late).toHaveBeenCalledWith(2);
  });

  it('a throwing listener does not stop the others; first error is rethrown', () => {
    const e = new TypedEmitter<Ev>();
    const after = vi.fn();
    e.on('a', () => {
      throw new Error('boom');
    });
    e.on('a', after);
    expect(() => e.emit('a', 1)).toThrow('boom');
    expect(after).toHaveBeenCalledWith(1);
  });

  it('emitting with no listeners is a no-op; removeAllListeners clears everything', () => {
    const e = new TypedEmitter<Ev>();
    e.emit('a', 1);
    const fn = vi.fn();
    e.on('b', fn);
    e.removeAllListeners();
    e.emit('b', 'x');
    expect(fn).not.toHaveBeenCalled();
  });
});
