import type { Metadata } from "next";
import { Aleo, Azeret_Mono, Host_Grotesk } from "next/font/google";
import { Header } from "@/components/Header";
import "./globals.css";

const aleo = Aleo({ subsets: ["latin"], variable: "--font-aleo", display: "swap" });
const hostGrotesk = Host_Grotesk({ subsets: ["latin"], variable: "--font-host-grotesk", display: "swap" });
const azeretMono = Azeret_Mono({ subsets: ["latin"], variable: "--font-azeret-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Reroute · Train search",
  description: "Find alternative train journeys across India.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${aleo.variable} ${hostGrotesk.variable} ${azeretMono.variable}`}>
      <body>
        <main>
          <Header />
          {children}
        </main>
      </body>
    </html>
  );
}
