import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Type errors fail the build — strict typing is a project requirement.
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  poweredByHeader: false,
  // Local verification tooling (curl / agent browser) talks to 127.0.0.1.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // Firm logo uploads travel through Server Actions (FormData with a file).
  // 2 MiB logo limit + form fields — 4 MiB leaves generous headroom.
  experimental: {
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
  // Firm logos are served from the project's Supabase Storage bucket
  // (public URLs on *.supabase.co). Everything else stays same-origin.
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.supabase.co",
      },
    ],
  },
};

export default nextConfig;
