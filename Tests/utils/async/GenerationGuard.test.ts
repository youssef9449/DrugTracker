import { GenerationGuard } from '@/utils/async/GenerationGuard';

describe('GenerationGuard', () => {
  it('bumps and identifies the current generation', () => {
    const guard = new GenerationGuard<string>();
    const first = guard.bump('med-1');
    const second = guard.bump('med-1');

    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(guard.isCurrent('med-1', first)).toBe(false);
    expect(guard.isCurrent('med-1', second)).toBe(true);
  });

  it('keeps generations independent by key', () => {
    const guard = new GenerationGuard<string>();
    expect(guard.bump('a')).toBe(1);
    expect(guard.bump('a')).toBe(2);
    expect(guard.bump('b')).toBe(1);
    expect(guard.current('a')).toBe(2);
    expect(guard.current('b')).toBe(1);
  });
});
