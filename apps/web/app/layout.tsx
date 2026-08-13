import type { Metadata } from "next";
import { Archivo } from "next/font/google";
import "./styles.css";

// Self-hosted at build time, so the product's type never waits on a third
// party. 400 sets body copy, 600 the labels, 800 every heading.
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "600", "800"],
  variable: "--font-archivo",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Cap — browser capture",
  description: "Local-first screen recording prototype",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={archivo.variable}>
      <body>{children}</body>
    </html>
  );
}
