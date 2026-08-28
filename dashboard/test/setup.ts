import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

if (!globalThis.PointerEvent) {
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
}

if (!URL.createObjectURL) {
  URL.createObjectURL = vi.fn(() => 'blob:test-audio');
}

if (!URL.revokeObjectURL) {
  URL.revokeObjectURL = vi.fn();
}
