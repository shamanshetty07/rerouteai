"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchProfile, signOut, type Profile } from "@/lib/api";

const LINKS = [
  { href: "/search", label: "Search" },
  { href: "/saved", label: "Saved journeys" },
];

export function Header() {
  const pathname = usePathname();
  const [profile, setProfile] = useState<Profile | null>(null);

  // Re-check on navigation: signing in redirects back here with a fresh session cookie.
  useEffect(() => {
    let current = true;
    void fetchProfile().then((p) => current && setProfile(p));
    return () => {
      current = false;
    };
  }, [pathname]);

  async function onSignOut() {
    await signOut();
    setProfile(null);
    window.location.assign("/search");
  }

  return (
    <header className="site-header">
      <Link href="/search" className="brand">
        Reroute
      </Link>
      <nav className="tabs" aria-label="Sections">
        {LINKS.map(({ href, label }) => (
          <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      {profile && (
        <div className="account">
          <span>{profile.name ?? profile.email ?? "Signed in"}</span>
          <button type="button" className="secondary" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}
