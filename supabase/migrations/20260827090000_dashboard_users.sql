-- Database-backed dashboard accounts and roles.
-- A successful Discord login creates a member row; admins can promote rows.

CREATE TYPE public."DashboardRole" AS ENUM ('admin', 'member');

CREATE TABLE public."DashboardUser" (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  "discordId" text NOT NULL UNIQUE,
  username text NOT NULL,
  avatar text,
  role public."DashboardRole" NOT NULL DEFAULT 'member',
  "createdAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public."DashboardUser" ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public."DashboardUser" TO authenticated;
GRANT ALL ON public."DashboardUser" TO service_role;

CREATE POLICY "users can read their own dashboard account"
  ON public."DashboardUser"
  FOR SELECT
  TO authenticated
  USING (id = auth.uid());
