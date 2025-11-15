export const dynamic = "force-dynamic";
import BleReader from "@/components/BleReader";
import AuthWrapper from "@/components/admin/auth-wrapper";
import { isAuthenticated } from "@/app/actions/config";
import Link from "next/link";
import { Github } from "lucide-react";
export default async function Home() {
  const authenticated = await isAuthenticated();
  return (
    <AuthWrapper isAuthenticated={authenticated}>
      <div className="min-h-screen">
        <div className="max-w-3xl mx-auto px-6 pt-6">
          <div className="text-right mb-4">
            <Link 
              href="https://github.com/enkhbold470/eeg-study" 
              target="_blank" 
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
            >
              <Github className="w-3 h-3" />
              Github repo link
            </Link>
          </div>
        </div>
        <BleReader />
      </div>
    </AuthWrapper>
  );
}