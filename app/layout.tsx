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
    <html lang="en" suppressHydrationWarning>
      {/* Inline script prevents flash of wrong theme before hydration */}
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme:dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}})()`,
          }}
        />
      </head>
      <body className="min-h-screen bg-[var(--ds-background-200)]">
        {children}
      </body>
    </html>
  );
}
