import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ImageVisual — 多方法图像细节对比",
  description: "本地数据集与图像处理方法的同步对比、ROI 选区和细节放大工具。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
