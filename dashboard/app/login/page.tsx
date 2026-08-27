// Public login page. If already signed in, bounce to the role's home page.
import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/session';
import { homePathFor } from '@/lib/auth';
import LoginButton from './LoginButton';

export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  forbidden: 'Could not verify a Discord identity for this account.',
  denied: 'Login was cancelled.',
  exchange: 'Could not verify your Discord login. Please try again.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getSessionUser();
  if (user) redirect(homePathFor(user.role));

  const { error } = await searchParams;
  const message = error ? (ERRORS[error] ?? 'Something went wrong. Please try again.') : null;

  return (
    <main className="login">
      <div className="login-card">
        <div className="login-logo">🤖</div>
        <h1>Megu Dashboard</h1>
        <p className="sub">Sign in with Discord to continue.</p>

        {message && <p className="hint err">{message}</p>}
        <LoginButton />
      </div>
    </main>
  );
}
