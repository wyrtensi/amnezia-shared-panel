import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The repository already documents agents in the root AGENTS.md.
  agentRules: false,
};

export default nextConfig;
