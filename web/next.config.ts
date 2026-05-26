import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    images: {
        remotePatterns: [
            {
                protocol: "https",
                hostname: "polymarket-upload.s3.us-east-2.amazonaws.com",
                pathname: "/**",
            },
            {
                protocol: "https",
                hostname: "polymarket-upload.s3.amazonaws.com",
                pathname: "/**",
            },
        ],
    },
};

export default nextConfig;
