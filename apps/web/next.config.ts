import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@cap/domain", "@cap/recording"],
  output: "standalone",
};

export default nextConfig;
