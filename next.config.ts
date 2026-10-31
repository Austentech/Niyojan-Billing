import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Type errors fail the build — strict typing is a project requirement.
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
