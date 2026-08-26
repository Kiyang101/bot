'use client';

import { useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { startBot, stopBot } from './actions';
import type { BotRuntime } from '@/lib/control';

export default function BotControl({ runtime }: { runtime: BotRuntime | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const status = runtime?.status ?? 'STOPPED';
  const busy = pending || status === 'STARTING' || status === 'STOPPING';

  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [router]);

  function run(action: typeof startBot | typeof stopBot) {
    startTransition(async () => {
      await action();
      router.refresh();
    });
  }

  const label =
    status === 'RUNNING'
      ? 'Running'
      : status === 'STARTING'
        ? 'Starting…'
        : status === 'STOPPING'
          ? 'Stopping…'
          : status === 'ERROR'
            ? 'Error'
            : 'Stopped';

  return (
    <section className="bot-control card-wide">
      <div>
        <div className="section-title">Bot process</div>
        <div className="bot-status-line">
          <span className={`status-dot ${status.toLowerCase()}`} />
          <strong>{label}</strong>
          {runtime?.pid && <span className="muted">PID {runtime.pid}</span>}
        </div>
        {runtime?.lastError && <p className="hint err">{runtime.lastError}</p>}
      </div>
      <div className="actions">
        <button type="button" disabled={busy || status === 'RUNNING'} onClick={() => run(startBot)}>
          Start bot
        </button>
        <button
          type="button"
          className="danger"
          disabled={pending || (status !== 'RUNNING' && status !== 'STARTING')}
          onClick={() => run(stopBot)}
        >
          Stop bot
        </button>
      </div>
    </section>
  );
}
