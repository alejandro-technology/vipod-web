import { Disc3 } from "lucide-react";
import Link from "next/link";

export function SiteHeader() {
  return <header className="topbar">
    <Link className="wordmark" href="/" aria-label="Vipod home"><span className="brand-icon"><Disc3 size={21} /></span>VIPOD</Link>
    <nav className="site-nav" aria-label="Main navigation">
      <Link href="/">Download</Link><Link href="/library">Library</Link><Link href="/temporary">Temporary</Link>
    </nav>
    <p className="top-tagline">Your music. Your library.</p>
  </header>;
}
