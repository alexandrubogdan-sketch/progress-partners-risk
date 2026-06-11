import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Progress Partners Risk",
  description: "VAMP fraud risk monitoring dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--ds-background-200)]">
        {children}
      </body>
    </html>
  );
}
