/** @type {import('next').NextConfig} */
const nextConfig = {
  // Don't bundle Prisma's engine — load it at runtime instead (recommended for Prisma + Next).
  serverExternalPackages: ['@prisma/client', '.prisma/client'],
};

export default nextConfig;
