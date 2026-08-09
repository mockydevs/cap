import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@cap/recording"],
  output: "standalone",
};

export default nextConfig;
