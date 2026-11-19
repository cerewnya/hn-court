import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Case JSON and OG fonts are read from disk at request time; make sure the
  // serverless bundle tracer ships them alongside every route.
  outputFileTracingIncludes: {
    "/**": ["./content/cases/**/*.json", "./assets/fonts/**/*", "./public/assets/**/*"],
  },
};

export default nextConfig;
