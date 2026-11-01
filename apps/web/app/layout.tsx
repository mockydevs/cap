import type { Metadata } from "next";
import localFont from "next/font/local";
import "./styles.css";

// Vendored Archivo Latin variable font: no third-party request during builds
// or rendering. 400 sets body copy, 600 the labels, 800 every heading.
const archivo = localFont({
  src: "./fonts/archivo-latin-normal.woff2",
  weight: "100 900",
  style: "normal",
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
