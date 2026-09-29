import { MemoryCounter } from '../../src/middleware/rate-limit';

describe('MemoryCounter', () => {
  it('counts hits within a window and resets after it', async () => {
    let now = 1_000_000;
    const counter = new MemoryCounter(() => now);

    expect((await counter.hit('k', 60)).count).toBe(1);
    expect((await counter.hit('k', 60)).count).toBe(2);
    expect((await counter.hit('other', 60)).count).toBe(1);

    now += 59_000;
    const beforeReset = await counter.hit('k', 60);
    expect(beforeReset.count).toBe(3);
    expect(beforeReset.resetInSeconds).toBe(1);

    now += 1_000;
    expect((await counter.hit('k', 60)).count).toBe(1);
  });
});
