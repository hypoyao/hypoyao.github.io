/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 关键：静态小游戏依赖相对路径（./xxx.css/js），需要目录形式 URL（/games/ttt/）
  // 否则浏览器会把资源解析到 /games/ttt.css 这种错误路径，导致样式/脚本丢失。
  trailingSlash: true,
};

export default nextConfig;
