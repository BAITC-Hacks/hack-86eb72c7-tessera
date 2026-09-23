import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { ruRU } from "@clerk/localizations/ru-RU";
import { Geist, Geist_Mono } from "next/font/google";
import { isClerkConfigured } from "@/lib/server/auth";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Tessera — закупки",
  description: "Рабочее место менеджера закупок",
  icons: { icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/%3E" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const content = isClerkConfigured() ? (
    <ClerkProvider
      localization={ruRU}
      appearance={{
        variables: {
          colorPrimary: "var(--primary)",
          colorPrimaryForeground: "var(--primary-foreground)",
          colorForeground: "var(--foreground)",
          colorBackground: "var(--card)",
          colorInput: "var(--background)",
          colorInputForeground: "var(--foreground)",
          colorRing: "var(--ring)",
          borderRadius: "var(--radius)",
          fontFamily: "var(--font-sans)",
        },
      }}
    >
      {children}
    </ClerkProvider>
  ) : (
    children
  );

  return (
    <html
      lang="ru"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{content}</body>
    </html>
  );
}
