import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Mirror Control",
  description: "Espelhamento WebRTC do Android com teclado e mouse",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
