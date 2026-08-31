/** @type {import('next').NextConfig} */
const nextConfig = {};

// ffmpeg-static resolves its executable relative to the package directory.
// Keep that package external so Next does not point the runtime at a missing
// executable inside .next/server, and include the downloaded binary in traced
// deployments (for example, serverless hosts).
nextConfig.serverExternalPackages = ['ffmpeg-static'];
nextConfig.outputFileTracingIncludes = {
  '/*': ['./node_modules/ffmpeg-static/**/*'],
};

export default nextConfig;
