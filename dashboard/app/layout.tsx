import './globals.css';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { listGuilds } from '@/lib/discord';
import { getSelectedGuildId, lockedGuildId } from '@/lib/guild';
import { getSessionUser } from '@/lib/session';
import { canAccess, isLocalHost, requestHost } from '@/lib/auth';

export const metadata = {
  title: 'Megu Dashboard',
  description: 'Voice activity and settings for the Megu Discord bot',
};

const NAV_LINKS = [
  { href: '/logs', label: 'Voice Logs' },
  { href: '/speak', label: 'Speak' },
  { href: '/music', label: 'Music' },
  { href: '/config', label: 'Settings' },
];

export default async function RootLayout({ children }: { children: ReactNode }) {
  const hdrs = await headers();
  const host = requestHost((name) => hdrs.get(name));
  const remote = !isLocalHost(host);
  const user = await getSessionUser({ allowRemoteAdmin: true });

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
  const currentGuild = visibleGuilds.find((guild) => guild.id === current);
  const guildIconUrl = currentGuild?.icon
    ? `https://cdn.discordapp.com/icons/${currentGuild.id}/${currentGuild.icon}.${currentGuild.icon.startsWith('a_') ? 'gif' : 'png'}?size=64`
    : null;

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <nav className="nav">
          <span className="brand">🤖 Megu</span>
          {NAV_LINKS.filter(
            (l) => canAccess(user.role, l.href) && (!remote || l.href !== '/logs'),
          ).map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
          <span className="nav-spacer" />
          <a className="current-guild" href="/servers" aria-label="Select a different Discord server">
            {guildIconUrl ? (
              <img className="current-guild-icon" src={guildIconUrl} alt="" />
            ) : (
              <span className="current-guild-icon current-guild-placeholder">?</span>
            )}
            <span className="current-guild-name">{currentGuild?.name ?? 'Select server'}</span>
            <span className="current-guild-arrow" aria-hidden="true">→</span>
          </a>
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
