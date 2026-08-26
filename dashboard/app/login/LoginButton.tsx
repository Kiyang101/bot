'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export default function LoginButton() {
  const [error, setError] = useState<string | null>(null);

  async function login() {
    setError(null);
    try {
      const { error: authError } = await createClient().auth.signInWithOAuth({
        provider: 'discord',
        options: { redirectTo: `${window.location.origin}/api/auth/callback` },
      });
      if (authError) setError(authError.message);
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : 'Could not start Discord login.');
    }
  }

  return (
    <>
      <button className="discord-btn" type="button" onClick={login}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3c-.2.358-.43.84-.59 1.222a18.27 18.27 0 0 0-3.937 0A12.6 12.6 0 0 0 11.44 3a19.74 19.74 0 0 0-3.76 1.369C3.286 8.62 2.49 12.766 2.888 16.85a19.9 19.9 0 0 0 5.993 3.04c.484-.66.915-1.36 1.286-2.096a12.9 12.9 0 0 1-2.026-.97c.17-.124.336-.254.496-.388a14.2 14.2 0 0 0 12.124 0c.162.14.328.27.496.388-.648.382-1.33.708-2.028.97.372.736.802 1.435 1.286 2.096a19.86 19.86 0 0 0 5.996-3.04c.466-4.74-.797-8.85-3.314-12.484ZM9.681 14.34c-1.182 0-2.157-1.085-2.157-2.42 0-1.334.955-2.42 2.157-2.42 1.21 0 2.176 1.095 2.156 2.42 0 1.335-.955 2.42-2.156 2.42Zm4.638 0c-1.182 0-2.157-1.085-2.157-2.42 0-1.334.955-2.42 2.157-2.42 1.21 0 2.176 1.095 2.156 2.42 0 1.335-.946 2.42-2.156 2.42Z" />
        </svg>
        Continue with Discord
      </button>
      {error && <p className="hint err">{error}</p>}
    </>
  );
}
