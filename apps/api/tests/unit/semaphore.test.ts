import { isProgressStep, semaphoreFor } from '../../src/lib/semaphore';

describe('semaphoreFor', () => {
  it.each([
    [0, 'RED'],
    [25, 'RED'],
    [50, 'RED'],
    [69, 'RED'],
    [70, 'YELLOW'],
    [75, 'YELLOW'],
    [89, 'YELLOW'],
    [90, 'GREEN'],
    [100, 'GREEN'],
  ])('progress %i → %s', (progress, expected) => {
    expect(semaphoreFor(progress)).toBe(expected);
  });
});

describe('isProgressStep', () => {
  it('accepts only the five daily steps', () => {
    expect([0, 25, 50, 75, 100].every(isProgressStep)).toBe(true);
    expect([10, 99, -25, 125].some(isProgressStep)).toBe(false);
  });
});
