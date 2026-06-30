import './globals.css';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { listGuilds } from '@/lib/discord';
import { getSelectedGuildId } from '@/lib/guild';
import { getSessionUser } from '@/lib/session';
import { canAccess, forcedGuildId, requestHost } from '@/lib/auth';
import GuildSwitcher from './GuildSwitcher';

export const metadata = {
  title: 'Megu Dashboard',
  description: 'Voice activity and settings for the Megu Discord bot',
};

const NAV_LINKS = [
  { href: '/', label: 'Voice Logs' },
  { href: '/speak', label: 'Speak' },
  { href: '/music', label: 'Music' },
  { href: '/config', label: 'Settings' },
];

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser();

  // Unauthenticated requests (e.g. the /login page) render without the nav.
  if (!user) {
    return (
      <html lang="en" suppressHydrationWarning>
        <body>{children}</body>
      </html>
    );
  }

  const [guilds, current] = await Promise.all([
    listGuilds().catch(() => []),
    getSelectedGuildId(),
  ]);

  // Remote (ngrok) visitors are locked to a single server: show only that one.
  const hdrs = await headers();
  const forced = forcedGuildId(requestHost((n) => hdrs.get(n)));
  const visibleGuilds = forced ? guilds.filter((g) => g.id === forced) : guilds;

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
    : null;

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <nav className="nav">
          <span className="brand">🤖 Megu</span>
          {NAV_LINKS.filter((l) => canAccess(user.role, l.href)).map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
          <span className="nav-spacer" />
          <GuildSwitcher guilds={visibleGuilds} current={current ?? ''} />
          <span className="nav-user">
            {avatarUrl && <img className="nav-avatar" src={avatarUrl} alt="" />}
            <span className="nav-name">{user.username}</span>
          </span>
          <a className="logout" href="/api/auth/logout" title="Sign out">
            Sign out
          </a>
        </nav>
        {children}
      </body>
    </html>
  );
}
