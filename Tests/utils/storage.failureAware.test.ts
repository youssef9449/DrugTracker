import { describe, expect, it, vi } from 'vitest';
import { saveJson, saveString } from '../../src/utils/storage';

describe('failure-aware storage writers', () => {
  it('returns null after a successful JSON write', () => {
    expect(saveJson('critical', { value: 1 })).toBeNull();
  });

  it('returns an error when a JSON write fails', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(saveJson('critical', { value: 1 })).toBeTruthy();
    setItem.mockRestore();
  });

  it('returns an error when a raw string write fails', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(saveString('critical', 'value')).toBeTruthy();
    setItem.mockRestore();
  });
});
