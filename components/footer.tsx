import Link from "next/link";
import { Sparkles, Globe, MessageCircle, HelpCircle, Download } from "lucide-react";
import { siteConfig } from "@/config/site";

export function Footer() {
  return (
    <footer className="py-16 px-6 mt-auto">
      <div className="max-w-6xl mx-auto">
        {/* Main Footer Content */}
        <div className="w-full h-px mb-6"></div>

        {/* Bottom Section */}
        <div className="text-center">
          <p className="text-sm mb-2">
            © {new Date().getFullYear()} {siteConfig.name} by{" "}
            <Link
              href="https://github.com/enkhbold470"
              target="_blank"
              className="inline-flex items-center gap-1 hover:opacity-80 transition-colors group"
            >
              <Globe className="w-3 h-3 group-hover:scale-110 transition-transform" />
              enk.icu
            </Link>
          </p>
          <p className="text-xs">
            {siteConfig.description}
          </p>
        </div>
      </div>
    </footer>
  );
}
