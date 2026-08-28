import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

if (!globalThis.PointerEvent && typeof MouseEvent !== 'undefined') {
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
}

if (typeof URL !== 'undefined' && !URL.createObjectURL) {
  URL.createObjectURL = vi.fn(() => 'blob:test-audio');
}

if (typeof URL !== 'undefined' && !URL.revokeObjectURL) {
  URL.revokeObjectURL = vi.fn();
}
