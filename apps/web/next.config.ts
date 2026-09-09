import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	typedRoutes: true,
	reactCompiler: true,
	async rewrites() {
		return [
			{
				source: "/api/:path*",
				destination: `${process.env.INTERNAL_API_URL || "http://127.0.0.1:8000"}/api/:path*`,
			},
		];
	},
};

export default nextConfig;
