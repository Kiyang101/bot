import './globals.css';
import type { ReactNode } from 'react';
import { listGuilds } from '@/lib/discord';
import { getSelectedGuildId, lockedGuildId } from '@/lib/guild';
import { getSessionUser } from '@/lib/session';
import { canAccess } from '@/lib/auth';
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

  const [guilds, current, locked] = await Promise.all([
    listGuilds().catch(() => []),
    getSelectedGuildId(),
    lockedGuildId(),
  ]);

  // Visitors locked to a single server (remote/ngrok users or a server-scoped
  // dashboard link) see only that one — they can't switch away.
  const visibleGuilds = locked ? guilds.filter((g) => g.id === locked) : guilds;

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
