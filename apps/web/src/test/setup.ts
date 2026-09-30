import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => cleanup());

// jsdom has no <dialog> modal API.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

// Recharts' ResponsiveContainer observes its size; jsdom has no ResizeObserver
// (charts render at their initialDimension instead).
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// jsdom has no layout, so ResponsiveContainer would measure 0×0 and draw
// nothing. Charts in tests get a fixed size instead.
vi.mock('recharts', async (importOriginal) => {
  const recharts = await importOriginal<typeof import('recharts')>();
  const { createElement } = await import('react');
  return {
    ...recharts,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      createElement(recharts.ResponsiveContainer, { width: 480, height: 240, children }),
  };
});
