import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Cap — browser capture",
  description: "Local-first screen recording prototype",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
